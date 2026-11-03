/**
 * 「看图」：把最近消息里的图片抓成模型能直接看的 data URL。
 *
 * 背景：以前的回复路径只有纯文本，"[图片]" 被替换成 "[发了一张图]" 之后模型就再也
 * 接触不到画面——别人甩张表情包调侃它，它只能装作没看见。这里在拼 prompt 时
 * 把最近几张图随消息一起塞给多模态模型（llm.models.chat 必须是能看图的模型，
 * 现在的 gemini-3.8-flash 可以）。
 *
 * 原则：任何一张图失败都只是少看一张，绝不能拖垮整条回复。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { framesFromGif, framesFromVideoUrl, isAnimated, sniffMime } from './media.mjs';

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

function mimeOf(raw, headerType) {
  const type = String(headerType || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) return type;
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(raw || ''));
  return (m && MIME_BY_EXT[m[1].toLowerCase()]) || 'image/jpeg';
}

/** 单张图 → 原始字节 { buf, mime }；拿不到就返回 null */
async function loadBytes(ref, { maxBytes, timeoutMs }) {
  const raw = String(ref?.url || ref?.file || '').trim();
  if (!raw) return null;
  let buf = null;
  let mime = mimeOf(raw, '');

  if (raw.startsWith('base64://')) {
    buf = Buffer.from(raw.slice('base64://'.length), 'base64');
  } else if (raw.startsWith('file://')) {
    buf = fs.readFileSync(fileURLToPath(raw));
  } else if (/^https?:\/\//i.test(raw)) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(raw, {
        signal: ac.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; snowluma-qq)' },
      });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length') || 0);
      // 明显超限的直接放弃，别先下 20MB 再丢掉
      if (len && len > maxBytes) return null;
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) return null;
      buf = Buffer.from(ab);
      mime = mimeOf(raw, res.headers.get('content-type'));
    } finally {
      clearTimeout(timer);
    }
  }
  if (!buf?.length) return null;
  return { buf, mime };
}

/** 单张图 → { mimeType, dataUrl, bytes }；拿不到就返回 null */
async function loadOne(ref, { maxBytes, timeoutMs }) {
  const got = await loadBytes(ref, { maxBytes, timeoutMs });
  if (!got) return null;
  const mime = sniffMime(got.buf) || got.mime;
  return { mimeType: mime, dataUrl: `data:${mime};base64,${got.buf.toString('base64')}`, bytes: got.buf.length };
}

/**
 * 缓存最近抓过的 CDN 图（url → dataUrl）。同一条消息往往连回好几轮，
 * 每次都从 multimedia.nt.qq.com.cn 重拉一遍既慢又给 CDN 添堵。
 */
const URL_CACHE = new Map();
const URL_CACHE_TTL_MS = 120_000;
const URL_CACHE_MAX = 12;

function cacheOf(url) {
  const hit = URL_CACHE.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > URL_CACHE_TTL_MS) {
    URL_CACHE.delete(url);
    return null;
  }
  return hit.value;
}

function rememberUrl(url, value) {
  URL_CACHE.delete(url);
  URL_CACHE.set(url, { at: Date.now(), value });
  while (URL_CACHE.size > URL_CACHE_MAX) URL_CACHE.delete(URL_CACHE.keys().next().value);
}

/**
 * 从最近的聊天记录里挑出最多 maxImages 张图（从新往旧扫，跳过机器人自己发的）。
 * 返回按时间正序排列，带 label（图1、图2…）与来源行，供 prompt 里标注。
 */
export async function collectImages(history, cfg, { log } = {}) {
  const v = cfg?.chat?.vision || {};
  if (v.enabled === false) return [];
  const maxImages = Math.max(0, Math.min(6, Number(v.maxImages ?? 3)));
  if (!maxImages) return [];
  const maxBytes = Math.max(64 * 1024, Number(v.maxBytes ?? 2_000_000));
  const timeoutMs = Math.max(1000, Number(v.timeoutMs ?? 12_000));

  const picked = [];
  const seen = new Set(); // 只拍掉同一条消息里重复段（转发常重复同一张），跨消息的图各算各的
  for (let i = (history?.length || 0) - 1; i >= 0 && picked.length < maxImages; i -= 1) {
    const row = history[i];
    if (!row || row.role === 'bot') continue;
    const refs = Array.isArray(row.media) ? row.media : [];
    for (const ref of refs) {
      if (picked.length >= maxImages) break;
      const raw = String(ref?.url || ref?.file || '');
      const key = `${i}|${raw}`;
      if (!raw || seen.has(key)) continue;
      seen.add(key);
      try {
        const cacheable = /^https?:\/\//i.test(String(ref?.url || ''));
        const got = (cacheable && cacheOf(ref.url)) || (await loadOne(ref, { maxBytes, timeoutMs }));
        if (got && cacheable) rememberUrl(ref.url, got);
        if (got) picked.push({ row, from: row.name || '群友', kind: Number(ref.subType) === 13 ? 'face' : 'image', ...got });
      } catch (err) {
        log?.debug?.(`看图失败（${key.slice(0, 80)}）：${err?.message ?? err}`);
      }
    }
  }
  picked.reverse(); // 时间正序：图1 最早
  return picked.map((p, idx) => ({ ...p, label: `图${idx + 1}` }));
}

/**
 * 解析结果缓存（url|位置 → dataUrl 或 frames）：同一条消息往往连回好几轮，
 * 抽帧比下载贵得多，动图/视频尤其不能每轮重抽。
 */
const PARSED_CACHE = new Map();
const PARSED_TTL_MS = 180_000;
const PARSED_MAX = 10;

function parsedOf(key) {
  const hit = PARSED_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PARSED_TTL_MS) {
    PARSED_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function rememberParsed(key, value) {
  PARSED_CACHE.delete(key);
  PARSED_CACHE.set(key, { at: Date.now(), value });
  while (PARSED_CACHE.size > PARSED_MAX) PARSED_CACHE.delete(PARSED_CACHE.keys().next().value);
}

const LABEL_PREFIX = { image: '图', face: '图', gif: '动图', video: '视频' };

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** 视频段 → { frames: [dataUrl...], durationSec }；失败返回 null */
async function videoFramesOf(ref, { maxBytes, timeoutMs, downloadTimeoutMs, maxFrames, width }, log) {
  const url = String(ref?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    if (ref?.file) log?.debug?.(`视频没有可下载的直链，跳过：${String(ref.file).slice(0, 60)}`);
    return null;
  }
  const got = await framesFromVideoUrl(url, { maxBytes, timeoutMs, downloadTimeoutMs, maxFrames, width });
  if (!got.frames.length) {
    // 下载失败多半是文件大 + 超时，或者直链已过期；解码失败是格式问题。分开记，排查时才知道看哪。
    log?.info?.(`视频取帧失败（${got.reason === 'download' ? '下载失败/超时' : '解码失败'}）：${url.slice(0, 80)}`);
    return null;
  }
  return {
    frames: got.frames.map((b) => `data:image/jpeg;base64,${b.toString('base64')}`),
    durationSec: got.durationSec,
  };
}

/**
 * 「提前抽帧」：视频消息一到就开始下载+抽帧，等模型真的要回这条消息时直接用缓存。
 * 44MB 的原片下载要 30 多秒，放在回复路径里会拖成「先沉默半分钟」；放后台就没这个问题。
 * 同一 URL 只会下载一次（INFLIGHT 复用），重复触发无害。
 */
const INFLIGHT = new Map();
// 失败也记一会儿：不然「补话」轮询会对着一个下不动的链接反复重试
const FAILED = new Map();

function videoParsed(key, ref, opts, log) {
  const hit = parsedOf(key);
  if (hit) return Promise.resolve(hit);
  const busy = INFLIGHT.get(key);
  if (busy) return busy;
  const failedAt = FAILED.get(key);
  if (failedAt && Date.now() < failedAt) return Promise.resolve(null);
  const task = (async () => {
    try {
      const got = await videoFramesOf(ref, opts, log);
      if (got) rememberParsed(key, got);
      else FAILED.set(key, Date.now() + 60_000);
      return got;
    } catch (err) {
      log?.debug?.(`抽视频帧失败：${err?.message ?? err}`);
      FAILED.set(key, Date.now() + 60_000);
      return null;
    } finally {
      INFLIGHT.delete(key);
    }
  })();
  INFLIGHT.set(key, task);
  return task;
}

/** 给刚收到的视频消息预热缓存（不阻塞收消息）。返回启动抽帧的视频条数。 */
export async function warmVideos(history, cfg, { log } = {}) {
  const v = cfg?.chat?.vision || {};
  if (v.enabled === false) return 0;
  const vidCfg = v.video || {};
  if (vidCfg.enabled === false) return 0;
  const opts = {
    maxBytes: Math.max(1_000_000, Number(vidCfg.maxBytes ?? 60_000_000)),
    timeoutMs: Math.max(3000, Number(vidCfg.timeoutMs ?? 25_000)),
    downloadTimeoutMs: Math.max(5000, Number(vidCfg.downloadTimeoutMs ?? 60_000)),
    maxFrames: Math.round(clamp(Number(vidCfg.maxFrames ?? 4), 1, 6)),
    width: Math.round(clamp(Number(vidCfg.width ?? 640), 160, 1280)),
  };
  let started = 0;
  for (const row of Array.isArray(history) ? history : []) {
    for (const ref of Array.isArray(row?.videos) ? row.videos : []) {
      const url = String(ref?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const key = `v|${url}`;
      if (parsedOf(key) || INFLIGHT.has(key)) continue;
      videoParsed(key, ref, opts, log);
      started += 1;
    }
  }
  return started;
}

/**
 * 「看懂这一轮」：把最近消息里的图、动图、视频一起收成模型能直接看的多模态附件。
 *
 * 返回按时间正序的条目：
 *   { row, from, kind: 'image'|'face', mimeType, dataUrl, bytes, label: '图1', placeholder }
 *   { row, from, kind: 'gif', frames: [dataUrl...], label: '动图1', placeholder: '[发了一张图]' }
 *   { row, from, kind: 'video', frames: [dataUrl...], durationSec, note, label: '视频1', placeholder: '[发了个视频]' }
 *
 * 预算是「帧总数」（chat.vision.totalFrames）：一张静态图算 1 帧，动图/视频算实际抽的帧数，
 * 免得一条视频 + 几张图就把上下文塞爆。
 */
export async function collectMedia(history, cfg, { log } = {}) {
  const v = cfg?.chat?.vision || {};
  if (v.enabled === false) return [];
  const maxImages = Math.round(clamp(Number(v.maxImages ?? 3), 0, 8));
  const totalFrames = Math.round(clamp(Number(v.totalFrames ?? 8), 1, 16));
  const maxBytes = Math.max(64 * 1024, Number(v.maxBytes ?? 2_000_000));
  const timeoutMs = Math.max(1000, Number(v.timeoutMs ?? 12_000));

  const gifCfg = v.gif || {};
  const gifOn = gifCfg.enabled !== false;
  const gifFramesMax = Math.round(clamp(Number(gifCfg.maxFrames ?? 3), 1, 6));

  const vidCfg = v.video || {};
  const vidOn = vidCfg.enabled !== false;
  const vidMax = Math.round(clamp(Number(vidCfg.maxVideos ?? 1), 0, 3));
  const vidFramesMax = Math.round(clamp(Number(vidCfg.maxFrames ?? 4), 1, 6));
  const vidBytes = Math.max(1_000_000, Number(vidCfg.maxBytes ?? 60_000_000));
  const vidTimeout = Math.max(3000, Number(vidCfg.timeoutMs ?? 25_000));
  const vidDownloadTimeout = Math.max(5000, Number(vidCfg.downloadTimeoutMs ?? 60_000));
  // 视频还没抽完就先等一会儿（用户一般会马上接一句「看这个」），等不到就先用别的信息回
  const vidWait = Math.max(0, Number(vidCfg.waitMs ?? 15_000));
  const vidWidth = Math.round(clamp(Number(vidCfg.width ?? 640), 160, 1280));

  let budget = totalFrames;
  let imageCount = 0;
  let videoCount = 0;
  const picked = [];
  // 同一个 URL 只算一次：转发常重复同一张，机器人偶尔也会把同一条消息存两遍
  const seen = new Set();

  for (let i = (history?.length || 0) - 1; i >= 0 && budget > 0; i -= 1) {
    const row = history[i];
    if (!row || row.role === 'bot') continue;
    const from = row.name || '群友';

    // ---- 视频（抽关键帧，不传整段） ----
    for (const ref of Array.isArray(row.videos) ? row.videos : []) {
      if (!vidOn || videoCount >= vidMax || budget < 1) break;
      const key = `v|${String(ref?.url || ref?.file || '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let got = parsedOf(key);
      if (!got) {
        const task = videoParsed(key, ref, {
          maxBytes: vidBytes,
          timeoutMs: vidTimeout,
          downloadTimeoutMs: vidDownloadTimeout,
          maxFrames: Math.min(vidFramesMax, budget),
          width: vidWidth,
        }, log);
        // waitMs=0 表示「不在这里等」，后台抽完由补话来接；否则最多等这么久
        got = vidWait > 0
          ? await Promise.race([task, new Promise((r) => setTimeout(() => r(null), vidWait))])
          : null;
      }
      if (!got?.frames?.length) continue;
      const use = got.frames.slice(0, Math.max(1, Math.min(vidFramesMax, budget)));
      budget -= use.length;
      videoCount += 1;
      const dur = Math.round(Number(got.durationSec) || 0);
      picked.push({
        row,
        from,
        kind: 'video',
        url: String(ref?.url || ''),
        frames: use,
        durationSec: dur,
        note: dur ? `时长约 ${dur} 秒` : '',
        placeholder: '[发了个视频]',
      });
    }

    // ---- 图 / 动图 ----
    for (const ref of Array.isArray(row.media) ? row.media : []) {
      if (budget < 1 || imageCount >= maxImages) break;
      const raw = String(ref?.url || ref?.file || '');
      if (!raw) continue;
      const key = `m|${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let got = parsedOf(key);
      if (!got) {
        try {
          const cacheable = /^https?:\/\//i.test(String(ref?.url || ''));
          const loaded = await loadBytes(ref, { maxBytes, timeoutMs });
          if (!loaded) continue;
          const mime = sniffMime(loaded.buf) || loaded.mime;
          if (gifOn && isAnimated(loaded.buf, mime)) {
            const frames = await framesFromGif(loaded.buf, { maxFrames: gifFramesMax, width: 480 });
            if (frames.length) {
              got = { kind: 'gif', frames: frames.map((b) => `data:image/jpeg;base64,${b.toString('base64')}`) };
            }
          }
          if (!got) {
            got = {
              kind: Number(ref.subType) === 13 ? 'face' : 'image',
              mimeType: mime,
              dataUrl: `data:${mime};base64,${loaded.buf.toString('base64')}`,
              bytes: loaded.buf.length,
            };
            if (cacheable) rememberUrl(ref.url, got);
          }
        } catch (err) {
          log?.debug?.(`看图失败（${key.slice(0, 80)}）：${err?.message ?? err}`);
        }
        if (got) rememberParsed(key, got);
      }
      if (!got) continue;
      if (got.kind === 'gif') {
        const frames = got.frames.slice(0, Math.max(1, Math.min(got.frames.length, budget)));
        budget -= frames.length;
        imageCount += 1;
        picked.push({ row, from, kind: 'gif', frames, placeholder: '[发了一张图]' });
      } else {
        budget -= 1;
        imageCount += 1;
        picked.push({ ...got, row, from, placeholder: '[发了一张图]' });
      }
    }
  }

  picked.reverse(); // 时间正序：按聊天先后编号
  const counts = new Map();
  for (const it of picked) {
    const n = (counts.get(it.kind) || 0) + 1;
    counts.set(it.kind, n);
    it.label = `${LABEL_PREFIX[it.kind] || '图'}${n}`;
  }
  return picked;
}
