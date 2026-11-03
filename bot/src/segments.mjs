/**
 * OneBot v11 消息段工具。
 * SnowLuma 的事件里 message 既可能是消息段数组，也可能是 CQ 码字符串（取决于上报格式），这里两种都吃。
 */

export const at = (qq, name) => ({ type: 'at', data: name ? { qq: String(qq), name } : { qq: String(qq) } });
export const reply = (messageId) => ({ type: 'reply', data: { id: String(messageId) } });
export const text = (t) => ({ type: 'text', data: { text: String(t) } });
export const face = (id) => ({ type: 'face', data: { id: String(id) } });
export const image = (file) => ({ type: 'image', data: { file } });

/** 把 "你好" 变成消息段数组 */
export function toSegments(input) {
  if (Array.isArray(input)) return input;
  if (input == null) return [];
  return [text(input)];
}

const CQ_RE = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;

function decodeCQValue(v) {
  return v
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

export function parseCQString(str) {
  const out = [];
  let last = 0;
  let m;
  CQ_RE.lastIndex = 0;
  const pushText = (t) => {
    if (t) out.push(text(decodeCQValue(t)));
  };
  while ((m = CQ_RE.exec(str))) {
    pushText(str.slice(last, m.index));
    const data = {};
    for (const pair of (m[2] || '').split(',').filter(Boolean)) {
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      data[pair.slice(0, idx)] = decodeCQValue(pair.slice(idx + 1));
    }
    out.push({ type: m[1], data });
    last = CQ_RE.lastIndex;
  }
  pushText(str.slice(last));
  return out;
}

/** 统一成消息段数组 */
export function normalizeMessage(message) {
  if (Array.isArray(message)) return message;
  if (typeof message === 'string') return parseCQString(message);
  if (message && typeof message === 'object') return toSegments(message);
  return [];
}

/** 事件里人名的兜底顺序 */
export function senderName(event) {
  const s = event.sender || {};
  return s.card || s.nickname || String(event.user_id ?? '某人');
}

/** 渲染成给人看的纯文本（给模型看的转录、控制台展示都用这个） */
export function plainText(message) {
  const segs = normalizeMessage(message);
  return segs
    .map((seg) => {
      switch (seg.type) {
        case 'text':
          return seg.data?.text ?? '';
        case 'at':
          return seg.data?.qq === 'all' ? '@全体成员' : `@${seg.data?.name || seg.data?.qq || '某人'}`;
        case 'image':
          return '[图片]';
        case 'face':
          return '[表情]';
        case 'mface':
          return '[表情包]';
        case 'record':
          return '[语音]';
        case 'video':
          return '[视频]';
        case 'file':
          return `[文件${seg.data?.name ? `:${seg.data.name}` : ''}]`;
        case 'forward':
          return '[合并转发]';
        case 'reply':
          return '';
        case 'json':
        case 'xml':
          return '[卡片]';
        case 'poke':
          return '[戳一戳]';
        default:
          return '';
      }
    })
    .join('')
    .trim();
}

/** 是否 @ 了我 */
export function mentionsMe(message, selfId) {
  return normalizeMessage(message).some((seg) => seg.type === 'at' && String(seg.data?.qq) === String(selfId));
}

/** 是否在回复某条消息，返回被回复的消息 id */
export function replyTargetOf(message) {
  const seg = normalizeMessage(message).find((s) => s.type === 'reply');
  return seg ? String(seg.data?.id ?? '') : null;
}

/** 图片段里的 url / file 值 */
/** 视频段：file 可以是 base64:// / file:// / http(s):// */
export function video(file, { cover } = {}) {
  return { type: 'video', data: { file: String(file), ...(cover ? { cover: String(cover) } : {}) } };
}

export function imageUrls(message) {
  return normalizeMessage(message)
    .filter((s) => s.type === 'image')
    .map((s) => s.data?.url || s.data?.file)
    .filter(Boolean);
}

/**
 * 图片段的元数据（不下载字节，只留定位信息）——「看图」功能靠它事后回捞。
 * subType 13 是 QQ 的动画表情（gif），summary 里带 [动画表情] 之类的提示。
 */
export function imagesOf(message) {
  return normalizeMessage(message)
    .filter((s) => s.type === 'image')
    .map((s) => ({
      url: String(s.data?.url ?? ''),
      file: String(s.data?.file ?? ''),
      subType: Number(s.data?.sub_type ?? s.data?.subType ?? 0) || 0,
      summary: String(s.data?.summary ?? ''),
    }))
    .filter((m) => m.url || m.file);
}

/**
 * 视频段的元数据（不下载字节，只留定位信息）——「看视频」功能靠它事后回捞。
 * SnowLuma 给的 video 段带 url（multimedia.nt.qq.com.cn 的下载直链，rkey 几天后过期），
 * 没有 url 时退回 file（可能是本地路径或 base64://）。
 */
export function videosOf(message) {
  return normalizeMessage(message)
    .filter((s) => s.type === 'video')
    .map((s) => ({
      url: String(s.data?.url ?? ''),
      file: String(s.data?.file ?? ''),
      cover: String(s.data?.cover ?? ''),
    }))
    .filter((m) => m.url || m.file);
}

/** 合并转发段的 id —— 真正的聊天记录要用 get_forward_msg 现拉 */
export function forwardsOf(message) {
  return normalizeMessage(message)
    .filter((s) => s.type === 'forward')
    .map((s) => ({ id: String(s.data?.id ?? ''), url: String(s.data?.url ?? '') }))
    .filter((m) => m.id || m.url);
}

/** 把过长的回复按标点切成多条，模拟真人连发 */
export function splitReply(content, maxLen) {
  const clean = String(content ?? '')
    .replace(/\r/g, '')
    .trim();
  if (!clean) return [];
  if (!maxLen || clean.length <= maxLen) return [clean];

  const parts = [];
  let buf = '';
  const pushBuf = () => {
    const t = buf.trim();
    if (t) parts.push(t);
    buf = '';
  };

  for (const line of clean.split('\n')) {
    if (!line.trim()) {
      pushBuf();
      continue;
    }
    // 先按句末/句内标点切
    const pieces = line.split(/(?<=[。！？!?…~～])\s*/).filter(Boolean);
    for (const piece of pieces) {
      if (buf.length + piece.length <= maxLen) {
        buf += piece;
      } else {
        pushBuf();
        if (piece.length <= maxLen) {
          buf = piece;
        } else {
          // 还是太长，硬切
          for (let i = 0; i < piece.length; i += maxLen) parts.push(piece.slice(i, i + maxLen));
        }
      }
    }
  }
  pushBuf();
  return parts.length ? parts : [clean];
}

/** 清理模型输出里常见的「角色前缀」「引号」「代码块」 */
export function sanitizeReply(raw) {
  let t = String(raw ?? '');
  // 去掉 1~2 行包裹的 Markdown 代码块
  t = t.replace(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/g, '$1');
  t = t.replace(/^["“「『]+|["”」』]+$/g, '');
  // 去掉 "小雪花：xxx"（用任意冒号前缀开头）
  t = t.replace(/^[^\s：:]{1,12}[：:]\s*/, '');
  // 去掉 (动作) 行、空行压缩
  t = t.replace(/\n{3,}/g, '\n\n');
  // 去掉模型爱加的列表符号
  t = t.replace(/^\s*(?:[-*•]|\d+[.、])\s+/gm, '');
  return t.trim();
}
