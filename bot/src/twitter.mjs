/**
 * 推特（X）取图/取视频。
 *
 * 背景：这台机器直连 x.com / pbs.twimg.com / video.twimg.com 全部超时，
 * 只有 api.fxtwitter.com（元数据，无搜索）可达。所以：
 *   - 元数据：先用 fetch 直连 fxtwitter，失败再走代理
 *   - 媒体：一律走代理（默认本机 SSH SOCKS5 隧道 127.0.0.1:1080，出口是美国中转机）
 *
 * 没有「按关键词搜推特」的能力：X 的搜索走登录态 GraphQL，guest token 已失效。
 * 这里只做「给我一个推文链接 → 我把它变成能发出去的图/视频」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 默认代理：本机 SSH 隧道（systemd: qq-proxy-tunnel.service） */
export const DEFAULT_SOCKS = process.env.QQ_SOCKS5 || 'socks5h://127.0.0.1:1080';

/** 允许下载的媒体域名（防止模型把任意 URL 当图片源，变成 SSRF） */
const MEDIA_HOSTS = ['pbs.twimg.com', 'video.twimg.com'];

/** 从各种形态的推文地址里抠出 status id；抠不到返回 null */
export function parseTweetUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{15,25}$/.test(s)) return s;
  const m = s.match(/(?:^|[/.])(?:x|twitter)\.com\/(?:[^/]+\/)?(?:i\/web\/)?(?:[^/]+\/)?status(?:es)?\/(\d{15,25})/i)
    || s.match(/status(?:es)?\/(\d{15,25})/i);
  return m ? m[1] : null;
}

function socksHostPort(socks) {
  const raw = String(socks || '').trim();
  if (!raw) return null;
  const noScheme = raw.replace(/^socks5h?:\/\//i, '').replace(/^http:\/\//i, '');
  return noScheme.includes(':') ? noScheme : `${noScheme}:1080`;
}

/** 走代理抓 URL 到内存（curl，--socks5-hostname 让域名在远端解析） */
export async function proxyGet(url, { socks = DEFAULT_SOCKS, timeoutMs = 20_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const hp = socksHostPort(socks);
  if (!hp) throw new Error('没有配置代理');
  const args = [
    '-sS',
    '-L',
    '--socks5-hostname',
    hp,
    '-A',
    UA,
    '-m',
    String(Math.ceil(timeoutMs / 1000)),
    '--max-filesize',
    String(maxBytes),
    url,
  ];
  try {
    const { stdout } = await execFileP('curl', args, {
      maxBuffer: maxBytes + 1024 * 1024,
      timeout: timeoutMs + 3000,
      encoding: 'buffer',
    });
    if (!stdout || !stdout.length) throw new Error('代理返回空响应');
    return Buffer.from(stdout);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err);
    throw new Error(`代理抓取失败：${msg.split('\n')[0].slice(0, 160)}`);
  }
}

/** 取推文元数据（标题文字、作者、媒体列表） */
export async function tweetMeta(id, { timeoutMs = 15_000, socks = DEFAULT_SOCKS, allowProxy = true } = {}) {
  const url = `https://api.fxtwitter.com/i/status/${id}`;
  const direct = async () => {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  let data;
  try {
    data = await direct();
  } catch (err) {
    if (!allowProxy) throw new Error(`取推文失败：${err.message}`);
    const buf = await proxyGet(url, { socks, timeoutMs });
    data = JSON.parse(buf.toString('utf8'));
  }
  const tweet = data?.tweet;
  if (!tweet) throw new Error(`推文 ${id} 取不到（可能已删或受保护）`);
  return tweet;
}

/**
 * 从元数据里挑一个最值得发的媒体。
 * 视频优先（时长不超过 maxSeconds），否则选最大的图。
 */
export function pickTweetMedia(tweet, { maxSeconds = 30 } = {}) {
  const media = tweet?.media?.all || [];
  const videos = media.filter((m) => m.type === 'video' || m.type === 'gif');
  for (const v of videos) {
    const dur = Number(v.duration ?? 0);
    if (dur && dur > maxSeconds) continue;
    const list = (v.variants || []).filter((x) => x.url && /\.mp4(\?|$)/i.test(x.url));
    if (!list.length) continue;
    list.sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
    return { kind: 'video', url: list[0].url, durationSec: dur || null, thumb: v.thumbnail_url || null };
  }
  const photos = media.filter((m) => m.type === 'photo' && m.url);
  if (photos.length) {
    const best = photos.slice().sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
    return { kind: 'photo', url: best.url, width: best.width || null, height: best.height || null };
  }
  return null;
}

/** 下载媒体到本地（默认 data/tmp），调用方负责用完删除 */
export async function downloadMedia(url, { dir, maxBytes = 30 * 1024 * 1024, socks = DEFAULT_SOCKS, timeoutMs = 60_000 } = {}) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    throw new Error(`不是合法的媒体地址：${String(url).slice(0, 80)}`);
  }
  if (!MEDIA_HOSTS.includes(host)) throw new Error(`不认识的媒体域名：${host}`);

  const targetDir = dir || path.join(process.cwd(), 'data', 'tmp');
  fs.mkdirSync(targetDir, { recursive: true });
  const ext = /\.mp4/i.test(url) ? 'mp4' : 'jpg';
  const file = path.join(targetDir, `tw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);

  const hp = socksHostPort(socks);
  const args = [
    '-sS',
    '-L',
    '--socks5-hostname',
    hp,
    '-A',
    UA,
    '-m',
    String(Math.ceil(timeoutMs / 1000)),
    '--max-filesize',
    String(maxBytes),
    '-o',
    file,
    url,
  ];
  try {
    await execFileP('curl', args, { timeout: timeoutMs + 5000 });
  } catch (err) {
    fs.rmSync(file, { force: true });
    const msg = String(err?.stderr || err?.message || err);
    throw new Error(`下载失败：${msg.split('\n')[0].slice(0, 160)}`);
  }
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.size) {
    fs.rmSync(file, { force: true });
    throw new Error('下载到 0 字节');
  }
  if (stat.size > maxBytes) {
    fs.rmSync(file, { force: true });
    throw new Error(`文件 ${(stat.size / 1048576).toFixed(1)}MB，超过上限`);
  }
  return { file, size: stat.size, kind: ext === 'mp4' ? 'video' : 'photo' };
}

/**
 * 一步到位：推文链接 → { kind, file, text, author, id }
 * 出错抛异常，调用方负责把错误说给模型听。
 */
export async function fetchTweetMedia(input, { dir, maxBytes = 30 * 1024 * 1024, maxSeconds = 30, socks = DEFAULT_SOCKS } = {}) {
  const id = parseTweetUrl(input);
  if (!id) throw new Error('这不像一条推文链接（要 /<user>/status/<id> 这种）');
  const tweet = await tweetMeta(id, { socks });
  const picked = pickTweetMedia(tweet, { maxSeconds });
  if (!picked) throw new Error(`这条推文没有能发的图或 ${maxSeconds} 秒以内的视频`);

  const got = await downloadMedia(picked.url, { dir, maxBytes, socks });
  return {
    id,
    kind: got.kind,
    file: got.file,
    size: got.size,
    text: String(tweet.text || '').trim(),
    author: tweet.author?.screen_name || '',
    durationSec: picked.durationSec || null,
  };
}

export const _internals = { socksHostPort, MEDIA_HOSTS };
