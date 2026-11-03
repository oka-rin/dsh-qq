/**
 * 短视频：找 30 秒以内的片子、下下来、发出去、删掉。
 *
 * 只跟 B 站打交道：它的搜索接口能列出候选，view 接口给时长和 cid，
 * playurl 给一个匿名可下的 mp4 直链（durl，低码率，够群里看）。
 * 所以这里的「短」是靠 view 的 duration 判的，不看标题。
 */
import fs from 'node:fs';
import path from 'node:path';

const UA =
  process.env.QQ_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const log = { debug() {}, warn() {}, info() {} };

let buvidCache = { value: '', at: 0 };

async function buvid3(timeoutMs = 12_000) {
  if (buvidCache.value && Date.now() - buvidCache.at < 3_600_000) return buvidCache.value;
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json();
    buvidCache = { value: json?.data?.b_3 || '', at: Date.now() };
  } catch (err) {
    log.debug(`取 buvid3 失败：${err.message}`);
  }
  return buvidCache.value;
}

async function biliGet(url, { timeoutMs = 12_000, referer = 'https://www.bilibili.com/' } = {}) {
  const cookie = await buvid3();
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer,
      ...(cookie ? { cookie: `buvid3=${cookie}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.code !== 0) throw new Error(json?.message || `code ${json?.code}`);
  return json.data;
}

/** 搜索接口只给标题和 bvid，时长得再问 view */
export async function fetchView(bvid, opts = {}) {
  const data = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, opts);
  return {
    bvid,
    cid: data?.cid,
    duration: Number(data?.duration) || 0,
    title: String(data?.title || ''),
    author: String(data?.owner?.name || ''),
    pic: String(data?.pic || ''),
  };
}

/** 匿名能拿到的 mp4 直链（durl），通常是 360P，够看 */
export async function fetchPlayurl(bvid, cid, opts = {}) {
  const q = new URLSearchParams({ bvid, cid: String(cid), fnval: '0', qn: '32', platform: 'html5' });
  const data = await biliGet(`https://api.bilibili.com/x/player/playurl?${q}`, opts);
  const durl = Array.isArray(data?.durl) ? data.durl[0] : null;
  if (!durl?.url) throw new Error('拿不到可下载的地址');
  return { url: durl.url, size: Number(durl.size) || 0 };
}

/** 搜索结果里的 duration 是 "1:23" 这种字符串，先在列表层筛一遍再问详情，省请求 */
function parseDuration(text) {
  const m = /^(\d+):(\d{1,2})$/.exec(String(text || '').trim());
  if (!m) return Number.POSITIVE_INFINITY;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function searchPage(keyword, page, opts = {}) {
  const q = new URLSearchParams({ search_type: 'video', keyword, page: String(page) });
  const data = await biliGet(`https://api.bilibili.com/x/web-interface/search/type?${q}`, {
    ...opts,
    referer: 'https://search.bilibili.com/',
  });
  return Array.isArray(data?.result) ? data.result : [];
}

/**
 * 找几条「时长 <= maxSeconds」的短视频。
 * 先用搜索列表自带的 duration 粗筛（便宜），再对少数候选问 view 拿 cid（准）。
 * pages 是愿意翻几页搜索，默认 3 页 ≈ 60 条。
 */
export async function searchShortVideos(keyword, { maxSeconds = 30, limit = 4, pages = 3, probe = 6 } = {}) {
  const rough = [];
  for (let page = 1; page <= Math.max(1, pages); page += 1) {
    let list = [];
    try {
      list = await searchPage(keyword, page);
    } catch (err) {
      log.debug(`搜第 ${page} 页失败：${err.message}`);
      break;
    }
    for (const v of list) {
      if (!v?.bvid || String(v.arcurl || '').includes('/cheese/')) continue;
      const seconds = parseDuration(v.duration);
      if (seconds > maxSeconds) continue;
      rough.push({ v, seconds });
    }
    if (rough.length >= limit * 3) break;
  }
  const out = [];
  for (const { v, seconds } of rough.slice(0, probe)) {
    try {
      const view = await fetchView(v.bvid);
      if (!view.cid || !view.duration || view.duration > maxSeconds) continue;
      out.push({
        title: String(v.title || view.title || '').replace(/<[^>]+>/g, ''),
        url: `https://www.bilibili.com/video/${v.bvid}`,
        desc: [v.author, `播放 ${v.play ?? ''}`.trim(), seconds != null ? `${view.duration}s` : ''].filter(Boolean).join(' · '),
        bvid: v.bvid,
        cid: view.cid,
        duration: view.duration,
        author: v.author || view.author,
      });
      if (out.length >= limit) break;
    } catch (err) {
      log.debug(`看不了 ${v.bvid} 的详情：${err.message}`);
    }
  }
  return out;
}

/**
 * 下载到 dir，返回 { file, size, seconds }。
 * 大小按 maxBytes 兜住（默认 40MB），下完再核一次，超了就地删掉报错。
 */
export async function downloadVideo({ bvid, cid, maxBytes = 40 * 1024 * 1024, dir, timeoutMs = 60_000 } = {}) {
  if (!bvid || !cid) throw new Error('downloadVideo 需要 bvid 和 cid');
  const play = await fetchPlayurl(bvid, cid, { timeoutMs });
  if (play.size && play.size > maxBytes) throw new Error(`视频 ${(play.size / 1048576).toFixed(1)}MB，超过 ${(maxBytes / 1048576).toFixed(0)}MB 上限`);

  const targetDir = dir || path.join(process.cwd(), 'data', 'tmp');
  fs.mkdirSync(targetDir, { recursive: true });
  const file = path.join(targetDir, `bili-${bvid}-${Date.now()}.mp4`);

  const res = await fetch(play.url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载到 0 字节');
  if (buf.length > maxBytes) throw new Error(`视频 ${(buf.length / 1048576).toFixed(1)}MB，超过上限`);
  fs.writeFileSync(file, buf);
  return { file, size: buf.length, bytes: buf.length };
}

export const _internals = { buvid3, biliGet };
