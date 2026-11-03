/**
 * 小红书：把「笔记链接」变成能发出去的图/视频。
 *
 * 说明：小红书的搜索接口要登录态 + x-s 签名，没有账号搜不了（实测 code -101）。
 * 所以这里只做「有人甩了笔记链接 → 解析出图/视频 → 发出去」。
 * 图片和视频都在 sns-*.xhscdn.com，CDN 本身不需要登录，直连就能下。
 */
import fs from 'node:fs';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MEDIA_HOST_RE = /(^|\.)(xhscdn\.com|xhscdn\.net)$/i;

/** 支持 /explore/<id>、/discovery/item/<id>、xhslink.com 短链 */
export function parseXhsUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{24}$/i.test(s)) return { id: s, short: false };
  if (/xhslink\.com/i.test(s)) return { url: s, short: true };
  const m = s.match(/xiaohongshu\.com\/(?:explore|discovery\/item|note)\/([0-9a-f]{20,32})/i);
  return m ? { id: m[1], url: s, short: false } : null;
}

function mediaUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s.startsWith('//') ? `https:${s}` : s);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (!MEDIA_HOST_RE.test(u.hostname)) return '';
    return u.toString();
  } catch {
    return '';
  }
}

/** 从页面 HTML 里的 __INITIAL_STATE__ 挖出笔记的图和视频 */
export function extractNote(html, noteId) {
  const src = String(html || '');
  const m = src.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1].replace(/\bundefined\b/g, 'null'));
  } catch {
    return null;
  }

  const pick = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    // 常见结构：feed.noteDetailMap[id].note
    const detail = obj?.feed?.noteDetailMap?.[noteId]?.note || null;
    if (detail) return detail;
    // 兜底：任何带 imageList / video 的对象
    const seen = new Set();
    const stack = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur.imageList) || cur.video) return cur;
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
    return null;
  };

  const note = pick(data);
  if (!note) return null;

  const images = (note.imageList || [])
    .map((it) => mediaUrl(it?.urlDefault || it?.urlPre || (it?.infoList || [])[0]?.url || ''))
    .filter(Boolean);
  const videoRaw =
    note?.video?.media?.stream?.h264?.[0]?.masterUrl ||
    note?.video?.media?.stream?.h264?.[0]?.backupUrls?.[0] ||
    note?.video?.consumer?.originVideoKey
      ? note?.video?.media?.stream?.h264?.[0]?.masterUrl
      : '';
  const video = mediaUrl(videoRaw || '');

  return {
    id: noteId,
    title: String(note.title || '').trim(),
    desc: String(note.desc || '').trim(),
    author: String(note?.user?.nickname || '').trim(),
    images,
    video: video || '',
  };
}

export async function fetchNoteHtml(url, { timeoutMs = 20_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`打开笔记失败 HTTP ${res.status}`);
  const finalUrl = res.url || url;
  const html = await res.text();
  const id = parseXhsUrl(finalUrl)?.id || parseXhsUrl(url)?.id || '';
  return { html, finalUrl, id };
}

export async function downloadCdn(url, { dir, maxBytes = 30 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
  if (!MEDIA_HOST_RE.test(new URL(url).hostname)) throw new Error(`不认识的媒体域名：${url.slice(0, 60)}`);
  const targetDir = dir || path.join(process.cwd(), 'data', 'tmp');
  fs.mkdirSync(targetDir, { recursive: true });
  const ext = /\.mp4(\?|$)/i.test(url) ? 'mp4' : 'jpg';
  const file = path.join(targetDir, `xhs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.xiaohongshu.com/' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载到 0 字节');
  if (buf.length > maxBytes) throw new Error(`文件 ${(buf.length / 1048576).toFixed(1)}MB 超过上限`);
  fs.writeFileSync(file, buf);
  return { file, size: buf.length, kind: ext === 'mp4' ? 'video' : 'photo' };
}

/** 一步到位：笔记链接 → { kind, file, title, desc, author } */
export async function fetchNoteMedia(input, { dir, maxBytes = 30 * 1024 * 1024 } = {}) {
  const parsed = parseXhsUrl(input);
  if (!parsed) throw new Error('这不像一条小红书笔记链接');
  const target = parsed.url || `https://www.xiaohongshu.com/explore/${parsed.id}`;
  const { html, finalUrl, id } = await fetchNoteHtml(target);
  const note = extractNote(html, id || parsed.id || '');
  if (!note) throw new Error('没能从页面里读到笔记内容（可能需要登录，或这条笔记已删除）');
  const wantVideo = Boolean(note.video);
  const url = wantVideo ? note.video : note.images[0];
  if (!url) throw new Error('这条笔记里没有能发的图或视频');
  const got = await downloadCdn(url, { dir, maxBytes });
  return { kind: got.kind, file: got.file, size: got.size, title: note.title, desc: note.desc, author: note.author, pageUrl: finalUrl };
}

export const _internals = { mediaUrl, MEDIA_HOST_RE };
