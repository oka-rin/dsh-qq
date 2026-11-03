import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './util.mjs';

/**
 * 资讯来源：B站 / 知乎 / 贴吧 / 今日头条。
 *
 * 全部用公开接口或必应 RSS，不依赖 API Key：
 *   bilibili —— 官方搜索接口（先取 buvid3 cookie 过风控）
 *   zhihu    —— 必应 RSS 搜「知乎 <关键词>」再按域名筛
 *   tieba    —— 必应 RSS 搜「<关键词> 贴吧」再按域名筛
 *   toutiao  —— 先按域名筛，筛不到就退化成头条热榜
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT = 12_000;

export const SOURCE_LABELS = {
  bilibili: 'B站',
  zhihu: '知乎',
  tieba: '贴吧',
  toutiao: '今日头条',
  web: '网页',
};

export const SOURCE_NAMES = Object.keys(SOURCE_LABELS);

function httpUrl(raw) {
  try {
    const text = String(raw);
    // URL() normalizes backslashes and control characters; do not accept those
    // ambiguous spellings as search-result links or allow embedded credentials.
    if (!/^https?:\/\//i.test(text) || /[\\\u0000-\u0020\u007f]/.test(text)) return null;
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

const withinDomain = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

/** Validate the parsed host and content path, never a domain substring in a URL. */
export function isSourceUrl(source, raw) {
  const url = httpUrl(raw);
  if (!url) return false;
  const { hostname, pathname } = url;
  switch (source) {
    case 'bilibili':
      return withinDomain(hostname, 'bilibili.com') && /^\/video\/(?:BV[A-Za-z0-9]+|av\d+)\/?$/.test(pathname);
    case 'zhihu':
      return withinDomain(hostname, 'zhihu.com') && /^\/(?:p\/\d+|question\/\d+(?:\/answer\/\d+)?)\/?$/.test(pathname);
    case 'tieba':
      return withinDomain(hostname, 'tieba.baidu.com') && /^\/p\/\d+\/?$/.test(pathname);
    case 'toutiao':
      return withinDomain(hostname, 'toutiao.com') && /^(?:\/(?:trending|article|w|i|group)\/[A-Za-z0-9_-]+|\/i\d+)\/?$/.test(pathname);
    case 'web': {
      // 全网搜：不限平台，只要是个能读的页面；把搜索页/跳转页/导航页排除掉
      if (!/^https?:$/.test(url.protocol)) return false;
      if (BLOCKED_HOSTS.some((h) => withinDomain(hostname, h))) return false;
      if (pathname === '/' || pathname === '') return false;
      if (/^\/(?:search|s\?|web\?)/i.test(pathname + (url.search || ''))) return false;
      return true;
    }
    default:
      return false;
  }
}

/** 全网搜时不要的站：搜索引擎自身、跳转壳、纯导航 */
const BLOCKED_HOSTS = [
  'bing.com', 'cn.bing.com', 'baidu.com', 'so.com', 'sogou.com', 'google.com',
  'duckduckgo.com', 'zhihu.com/search', 'passport.jd.com', 'login.taobao.com',
];

/** Shared by direct source searches and the scheduler boundary; pure for tests. */
export function filterSourceItems(source, items) {
  return items.filter((item) => item?.title && isSourceUrl(source, item.url));
}

const log = createLogger('sources', process.env.QQ_LOG_LEVEL || 'info');

async function getOnce(url, headers, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 带重试的 GET：必应偶发 ECONNRESET，退避两次基本能过 */
async function get(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await getOnce(url, headers, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** 有些站按 TLS 指纹拦 Node（360 就是），这种只能借 curl 拿页面 */
const execFileP = promisify(execFile);
async function curlGet(url, { timeoutMs = 15_000 } = {}) {
  const { stdout } = await execFileP(
    'curl',
    ['-s', '--compressed', '-m', String(Math.ceil(timeoutMs / 1000)), '-A', UA, '-H', 'accept-language: zh-CN,zh;q=0.9', url],
    { maxBuffer: 12 * 1024 * 1024, timeout: timeoutMs + 3_000 },
  );
  if (!stdout || stdout.length < 200) throw new Error(`curl 返回内容过短（${stdout?.length ?? 0}B）`);
  return stdout;
}

/* 结果缓存：同一关键词 10 分钟内不重复打对方接口（也避免被风控） */
const cache = new Map();
function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = Promise.resolve()
    .then(producer)
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, { at: Date.now(), value });
  return value;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ 必应 RSS */

export async function bingRss(query, { limit = 8 } = {}) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
  const xml = await cached(`bing:${url}`, 10 * 60_000, () => get(url));
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const title = stripTags((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = decodeEntities(((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim());
    const desc = stripTags((block.match(/<description>([\s\S]*?)<\/description>/) || [])[1]).slice(0, 160);
    if (title && /^https?:\/\//.test(link)) items.push({ title, url: link, desc });
    if (items.length >= limit) break;
  }
  return items;
}

/* -------------------------------------------------------------------- B 站 */

let buvidCache = { value: '', at: 0 };

async function buvid3() {
  if (buvidCache.value && Date.now() - buvidCache.at < 3_600_000) return buvidCache.value;
  try {
    const json = JSON.parse(await get('https://api.bilibili.com/x/frontend/finger/spi'));
    buvidCache = { value: json?.data?.b_3 || '', at: Date.now() };
  } catch (err) {
    log.debug(`取 buvid3 失败：${err.message}`);
  }
  return buvidCache.value;
}

export async function searchBilibili(keyword, { limit = 6 } = {}) {
  const cookie = await buvid3();
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1`;
  const json = JSON.parse(
    await get(url, {
      headers: {
        referer: 'https://search.bilibili.com/',
        ...(cookie ? { cookie: `buvid3=${cookie}` } : {}),
      },
    }),
  );
  const list = Array.isArray(json?.data?.result) ? json.data.result : [];
  return list
    // 课堂/付费课程（cheese）和没 bvid 的条目一律不要，只要真视频
    .filter((v) => v.bvid && !String(v.arcurl || '').includes('/cheese/'))
    .slice(0, limit)
    .map((v) => ({
      title: stripTags(v.title).replace(/<em[^>]*>|<\/em>/g, ''),
      url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : String(v.arcurl || ''),
      desc: [v.author, v.play != null ? `播放 ${v.play}` : '', v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : '']
        .filter(Boolean)
        .join(' · '),
      // 封面图：B站图片都在 i0/i1/i2.hdslb.com，能直接下
      pic: String(v.pic || '').startsWith('http') ? String(v.pic) : String(v.pic || '').replace(/^\/\//, 'https://'),
    }))
    .filter((x) => isSourceUrl('bilibili', x.url));
}

/* ------------------------------------------------------------------ 搜狗搜索 */

/** 跟随一次跳转，拿到真实落地地址（搜狗结果都是 /link?url=… 的包装） */
async function resolveRedirect(href, base = 'https://www.sogou.com') {
  const url = /^https?:\/\//.test(href) ? href : base + href;
  try {
    const { stdout } = await execFileP('curl', ['-s', '-L', '-o', '/dev/null', '-w', '%{url_effective}', '-m', '10', '-A', UA, url], {
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
    });
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

/**
 * 搜狗搜索：结果标题是可靠的，链接要跟一次跳转才知道落到哪。
 * predicate 用来只保留某个域名的结果（比如只留知乎、只留贴吧）。
 */
export async function sogouSearch(query, { limit = 6, predicate = () => true, resolveLimit = 6 } = {}) {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  const html = await cached(`sogou:${url}`, 10 * 60_000, () => curlGet(url));
  const raw = [];
  const re = /<h3 class="vr-title[^"]*"[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && raw.length < resolveLimit) {
    const href = (/href="([^"]+)"/.exec(m[1]) || [])[1];
    const title = stripTags(m[2]);
    if (!href || !title) continue;
    raw.push({ title, href });
  }
  const resolved = await Promise.all(
    raw.map(async (item) => ({ title: item.title, url: await resolveRedirect(item.href) })),
  );
  return resolved.filter((x) => /^https?:\/\//.test(x.url) && predicate(x.url)).slice(0, limit).map((x) => ({ ...x, desc: '' }));
}

/* ------------------------------------------------------------------ 360 搜索 */

/** 360 搜索（so.com）：结果里的 data-mdurl 就是真实地址，比必应中文靠谱得多 */
export async function so360(query, { limit = 10 } = {}) {
  const url = `https://www.so.com/s?q=${encodeURIComponent(query)}`;
  const html = await cached(`so360:${url}`, 10 * 60_000, () => curlGet(url));
  const items = [];
  const re = /<h3 class="res-title"[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && items.length < limit) {
    const attrs = m[1];
    const md = /data-mdurl="([^"]+)"/.exec(attrs);
    const target = md ? decodeEntities(md[1]) : '';
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(target)) continue;
    if (target.includes('so.com/link')) continue;
    items.push({ title, url: target, desc: '' });
  }
  return items;
}

/* --------------------------------------------------------------- 知乎/贴吧 */


export async function searchZhihu(keyword, { limit = 6 } = {}) {
  let hit = [];
  try {
    hit = await sogouSearch(`${keyword} 知乎`, { limit, predicate: (u) => isSourceUrl('zhihu', u) });
  } catch (err) {
    log.debug(`搜狗搜知乎失败：${err.message}`);
  }
  if (hit.length < 2) {
    try {
      const items = await so360(`${keyword} 知乎`, { limit: limit * 4 });
      hit = hit.concat(items.filter((x) => isSourceUrl('zhihu', x.url)));
    } catch (err) {
      log.debug(`360 搜知乎失败：${err.message}`);
    }
  }
  if (hit.length < 2) {
    // 360 没货，再问一次必应
    try {
      const extra = await bingRss(`${keyword} 知乎`, { limit: limit * 4 });
      hit = hit.concat(extra.filter((x) => isSourceUrl('zhihu', x.url)));
    } catch (err) {
      log.debug(`必应搜知乎失败：${err.message}`);
    }
  }
  const seen = new Set();
  return hit
    .filter((x) => (seen.has(x.url) ? false : seen.add(x.url)))
    .slice(0, limit)
    .map((x) => ({ ...x, title: x.title.replace(/[-_]?\s*知乎\s*$/, '').trim() }));
}

export async function searchTieba(keyword, { limit = 6 } = {}) {
  let hit = [];
  try {
    hit = await sogouSearch(`${keyword} 贴吧`, { limit, predicate: (u) => isSourceUrl('tieba', u) });
  } catch (err) {
    log.debug(`搜狗搜贴吧失败：${err.message}`);
  }
  if (hit.length < 2) {
    try {
      const items = await so360(`${keyword} 贴吧`, { limit: limit * 4 });
      hit = hit.concat(items.filter((x) => isSourceUrl('tieba', x.url)));
    } catch (err) {
      log.debug(`360 搜贴吧失败：${err.message}`);
    }
  }
  if (hit.length < 2) {
    try {
      const extra = await bingRss(`${keyword} 贴吧`, { limit: limit * 4 });
      hit = hit.concat(extra.filter((x) => isSourceUrl('tieba', x.url)));
    } catch (err) {
      log.debug(`必应搜贴吧失败：${err.message}`);
    }
  }
  const seen = new Set();
  return hit
    .filter((x) => (seen.has(x.url) ? false : seen.add(x.url)))
    .slice(0, limit)
    .map((x) => ({ ...x, title: x.title.replace(/[-_]?\s*(百度)?贴吧\s*$/, '').trim() }));
}

/* ---------------------------------------------------------------- 今日头条 */

export async function searchToutiao(keyword, { limit = 6 } = {}) {
  let hit = [];
  try {
    const items = await so360(`${keyword} 今日头条`, { limit: limit * 4 });
    hit = items.filter((x) => isSourceUrl('toutiao', x.url));
  } catch (err) {
    log.debug(`360 搜头条失败：${err.message}`);
  }
  if (hit.length < 2) {
    try {
      const extra = await bingRss(`今日头条 ${keyword}`, { limit: limit * 4 });
      hit = hit.concat(extra.filter((x) => isSourceUrl('toutiao', x.url)));
    } catch (err) {
      log.debug(`必应搜头条失败：${err.message}`);
    }
  }
  if (hit.length >= 2) {
    return hit.slice(0, limit).map((x) => ({ ...x, title: x.title.replace(/[-_]?\s*今日头条\s*$/, '').trim() }));
  }
  // 搜不到就退化成热榜（不挑关键词，直接看今天大家在聊什么）
  return toutiaoHot({ limit });
}

export async function toutiaoHot({ limit = 6 } = {}) {
  const json = JSON.parse(await get('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc'));
  const list = Array.isArray(json?.data) ? json.data : [];
  return list
    .slice(0, limit)
    .map((x) => ({ title: stripTags(x.Title), url: String(x.Url || ''), desc: x.Label || '' }))
    .filter((x) => isSourceUrl('toutiao', x.url));
}

/* ------------------------------------------------------------------ 全网 */

/** 全网搜：不限平台，模型想找什么就找什么（先必应 RSS，拿不到再退 360） */
export async function searchWeb(keyword, { limit = 8 } = {}) {
  const out = [];
  const push = (items) => {
    for (const it of items || []) {
      const url = httpUrl(it?.url);
      if (!url) continue;
      if (!isSourceUrl('web', url)) continue;
      if (out.some((x) => x.url === url.toString())) continue;
      out.push({ title: stripTags(it.title || ''), url: url.toString(), desc: stripTags(it.desc || '') });
    }
  };
  for (const fn of [bingRss, so360]) {
    if (out.length >= limit) break;
    try {
      push(await fn(keyword, { limit }));
    } catch (err) {
      log.warn(`全网搜（${fn.name}）失败：${err.message}`);
    }
  }
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ 图片 */

/**
 * 搜图片：必应图片搜索，拿回一批能直接下载的图片直链。
 * 只收 jpg/png/webp/gif 这类真图片地址，过滤掉站点图标、占位图。
 */
/**
 * B 站的「图」：搜索结果里的视频封面（i0.hdslb.com）。
 * 擦边向的关键词在 B 站常常只有封面能看，正文是视频。
 */
export async function searchBiliCovers(keyword, { limit = 6 } = {}) {
  const items = await searchBilibili(keyword, { limit: limit * 2 });
  const out = [];
  for (const it of items) {
    const pic = String(it.pic || '');
    if (!/^https?:\/\/[^/]*hdslb\.com\//.test(pic)) continue;
    out.push({ title: it.title, url: pic, page: it.url, from: 'bilibili' });
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchImages(keyword, { limit = 8 } = {}) {
  const q = encodeURIComponent(String(keyword || '').trim());
  if (!q) return [];
  const html = await get(`https://cn.bing.com/images/search?q=${q}&form=HDRSC2&first=1&qft=+filterui:imagesize-large&adlt=off`, {
    headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
    timeoutMs: 15_000,
  });
  const out = [];
  const seen = new Set();
  const re = /murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit * 4) {
    let raw = m[1];
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* 保持原样 */
    }
    const url = httpUrl(raw);
    if (!url) continue;
    if (!/\.(?:jpe?g|png|webp|gif)(?:$|\?)/i.test(url.pathname + url.search)) continue;
    if (/favicon|logo|sprite|placeholder|avatar/i.test(url.pathname)) continue;
    let href = url.toString();
    // 缩略图（duitang 的 .thumb.400_0 这类）换成正图
    if (/\.thumb\./i.test(href)) {
      const deThumb = href.replace(/\.thumb\.\d+_\d+(\.[a-z]+)$/i, '$1');
      const fixed = httpUrl(deThumb);
      if (!fixed || fixed.toString() === href) continue;
      href = fixed.toString();
    }
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ title: String(keyword).trim(), url: href, desc: '' });
    if (out.length >= limit) break;
  }
  // 再补几张 B 站封面（B站图都在 hdslb，能直接下；擦边向内容常只在封面能看）
  if (out.length < limit) {
    try {
      const covers = await searchBiliCovers(keyword, { limit: limit - out.length });
      for (const c of covers) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        out.push({ title: c.title, url: c.url, desc: 'B站封面', page: c.page, from: 'bilibili' });
      }
    } catch {
      /* 封面拿不到就算了，不影响主流程 */
    }
  }
  return out;
}

/* ---------------------------------------------------------------- URL 清洗 */

/** 去掉跟踪参数，别让群里出现一条两百字符的链接 */
export function cleanUrl(raw) {
  try {
    const u = new URL(String(raw));
    // 只删已知跟踪字段，保留 p（B站多P页码）、t 等会改变内容语义的参数。
    for (const key of [...u.searchParams.keys()]) {
      if (/^(?:utm_|share_|spm)/i.test(key) || /^(log_pb|from|source|vd_source|bbid|ts|unique_k|plat_id|up_id)$/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.hash = '';
    return u.toString();
  } catch {
    return String(raw);
  }
}

/* ------------------------------------------------------------------- 调度 */

const SEEKERS = {
  bilibili: searchBilibili,
  zhihu: searchZhihu,
  tieba: searchTieba,
  toutiao: searchToutiao,
  web: searchWeb,
};

/** 按来源搜一批素材，失败返回空数组而不是抛错 */
export async function searchSource(source, keyword, { limit = 6 } = {}) {
  const fn = SEEKERS[source];
  if (!fn) throw new Error(`未知来源：${source}`);
  try {
    const items = await fn(keyword, { limit });
    return filterSourceItems(source, items);
  } catch (err) {
    log.warn(`${SOURCE_LABELS[source] || source} 搜索失败：${err.message}`);
    return [];
  }
}
