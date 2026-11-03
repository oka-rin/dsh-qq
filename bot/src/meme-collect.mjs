/**
 * 自己攒表情包图库：调用 dsh-meme 插件的管理 API（/dsh-memes-api），
 * 让插件做它最擅长的事——AI 识别分类/描述/关键词，然后原样落盘进「我的收藏」。
 *
 * 为什么走插件而不是自己建库：
 *  · 插件已经管着图库目录、索引、去重、面板，自己再建一份两份图库会打架；
 *  · ChatMemeLibrary（memes.mjs）本来就是只读扫 /root/.dsh/meme-packs/*，
 *    插件把新图写进去后，bot 这边下一次 pick() 就能搜到，不需要额外同步；
 *  · 识别用的是插件里的 llm + 当前默认模型，跟面板上传弹窗完全同一条路。
 */

const API = String(process.env.MEME_API || 'http://127.0.0.1:3080/dsh-memes-api');
const MAX_BYTES = 8 * 1024 * 1024; // 插件上限
const EXT_OK = /\.(png|jpe?g|gif|webp)$/i;
const TAG_OK = /^[a-z0-9_-]{1,16}$/;

async function post(body, { timeoutMs = 60_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 让插件认这张图，返回 {tag, caption, keywords, animation}。 */
export async function recognize({ buffer, fileName, timeoutMs } = {}) {
  const data = await post(
    { op: 'recognize', fileName, dataBase64: Buffer.from(buffer).toString('base64') },
    { timeoutMs },
  );
  const tag = String(data.tag || '').trim().toLowerCase();
  if (!TAG_OK.test(tag)) throw new Error('识别结果没有有效分类');
  return {
    tag,
    caption: String(data.caption || '').trim(),
    keywords: String(data.keywords || '').trim(),
    animation: data.animation || null,
  };
}

/** 落盘入库（插件的「我的收藏」图库）。 */
export async function upload({ buffer, fileName, tag, caption = '', keywords = '', timeoutMs } = {}) {
  const data = await post(
    {
      op: 'upload',
      tag,
      fileName,
      dataBase64: Buffer.from(buffer).toString('base64'),
      caption,
      keywords,
    },
    { timeoutMs },
  );
  return data.meme || null;
}

/**
 * 收集一张图：先识别，再入库。识别失败时用兜底分类，保证「先攒下来」不被识别卡住。
 * 返回 {ok:true, tag, caption, keywords} 或 {ok:false, error}。
 */
export async function collect({
  buffer,
  fileName,
  caption = '',
  keywords = '',
  tag = '',
  log = null,
  timeoutMs,
} = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.byteLength) return { ok: false, error: '空图片' };
  if (buf.byteLength > MAX_BYTES) return { ok: false, error: `图片太大（${(buf.byteLength / 1048576).toFixed(1)}MB > 8MB）` };
  // 插件按“声明扩展名 vs 文件头”校验图片类型，QQ 的图常被标错，所以一律以 magic bytes 为准
  const sniffed = sniffExt(buf);
  const fallbackExt = (String(fileName || '').match(EXT_OK) || ['.jpg'])[0];
  const baseName = String(fileName || '').replace(EXT_OK, '') || `meme-${Date.now()}`;
  const name = `${baseName}${sniffed || fallbackExt}`;

  let info = { tag: '', caption, keywords };
  try {
    info = await recognize({ buffer: buf, fileName: name, timeoutMs });
  } catch (err) {
    log?.warn?.(`表情包识别失败，按兜底分类入库：${err.message}`);
  }
  const finalTag = TAG_OK.test(String(tag || '').toLowerCase())
    ? String(tag).toLowerCase()
    : TAG_OK.test(info.tag)
      ? info.tag
      : 'daily';
  const finalCaption = String(info.caption || caption || '').trim().slice(0, 120) || '群里收的表情包';
  const finalKeywords = String(info.keywords || keywords || '').trim().slice(0, 120);

  try {
    const meme = await upload({ buffer: buf, fileName: name, tag: finalTag, caption: finalCaption, keywords: finalKeywords, timeoutMs });
    log?.info?.(`表情包入库：${finalTag} / ${finalCaption}${meme?.path ? ` (${meme.path})` : ''}`);
    return { ok: true, tag: finalTag, caption: finalCaption, keywords: finalKeywords, path: meme?.path || '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 从 URL 拉图（大小受插件上限约束），超限直接拒。 */
// QQ 的图片 CDN 有时把 GIF/PNG 标成 image/jpeg，插件按声明类型校验会失败（Declared image type does not match its bytes），
// 所以按文件头 magic bytes 判真实格式，优先于 content-type。
const MAGIC = [
  { sig: [0x89, 0x50, 0x4e, 0x47], ext: '.png' },
  { sig: [0xff, 0xd8, 0xff], ext: '.jpg' },
  { sig: [0x47, 0x49, 0x46, 0x38], ext: '.gif' },
  { sig: [0x42, 0x4d], ext: '.bmp' },
];
export function sniffExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  for (const m of MAGIC) if (m.sig.every((b, i) => buf[i] === b)) return m.ext;
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return '.avif';
  }
  return '';
}

export async function fetchImage(url, { maxBytes = MAX_BYTES, timeoutMs = 15_000 } = {}) {
  const u = new URL(String(url || ''));
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http(s) 图片地址');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(u, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) throw new Error(`图片太大（${(len / 1048576).toFixed(1)}MB > ${(maxBytes / 1048576).toFixed(0)}MB）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`图片太大（${(buf.byteLength / 1048576).toFixed(1)}MB）`);
    const ct = String(res.headers.get('content-type') || '');
    const extByName = (u.pathname.match(EXT_OK) || [])[0] || '';
    const extByType = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[ct.split(';')[0].trim()] || '';
    const ext = sniffExt(buf) || extByType || extByName || '.jpg';
    return { buffer: buf, fileName: `meme-${Date.now()}${ext}`, contentType: ct };
  } finally {
    clearTimeout(timer);
  }
}
