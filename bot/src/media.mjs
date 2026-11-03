/**
 * 多媒体：动图抽帧、视频抽关键帧、合并转发展开成文字。
 *
 * 背景：「看图」以前只认静态图，表情包动图只看到第一帧，视频完全看不见，
 * 合并转发只留下一个「[转发了聊天记录]」——等于什么都没看见。
 * 这里补上三件事：
 *   · 动图（GIF/APNG/动态 WebP）用 ffmpeg 均匀抽 N 帧，按时间顺序交给模型；
 *   · 视频先下到临时文件，ffprobe 读时长，再按「整段均匀 N 帧」抽关键帧（不传整段视频，太贵）；
 *   · 合并转发调 OneBot 的 get_forward_msg，把每条渲染成「说话人：内容」，里面的图/视频照样收进来。
 *
 * 原则和看图一致：任何一步失败都只是少看一点，绝不能拖垮整条回复。
 * ffmpeg/ffprobe 不存在时所有抽帧函数返回空数组，不抛错。
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imagesOf, normalizeMessage, plainText, videosOf } from './segments.mjs';

const UA = 'Mozilla/5.0 (compatible; snowluma-qq)';

function tmpDir(prefix) {
  const dir = path.join(os.tmpdir(), `snowluma-${prefix}-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉也无所谓 */
  }
}

/** 跑一个外部命令（spawn，不经过 shell），超时直接 SIGKILL。 */
function run(bin, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    const finish = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.stdout?.on('data', (d) => {
      stdout = (stdout + d.toString()).slice(-200_000);
    });
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-200_000);
    });
    child.on('error', (err) => {
      stderr += String(err?.message || err);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(-2);
    }, Math.max(1000, timeoutMs));
    timer.unref?.();
  });
}

let FFMPEG_READY = null;

/** ffmpeg/ffprobe 是否可用（只探一次）。没有就安静降级。 */
export function ffmpegReady() {
  if (FFMPEG_READY) return FFMPEG_READY;
  FFMPEG_READY = (async () => {
    const res = await run('ffmpeg', ['-version'], { timeoutMs: 4000 });
    if (res.code !== 0) return false;
    const probe = await run('ffprobe', ['-version'], { timeoutMs: 4000 });
    return probe.code === 0;
  })();
  return FFMPEG_READY;
}

/** 按 magic bytes 判真实格式（QQ 给的 content-type/扩展名经常是错的）。 */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF') {
    const kind = b.subarray(8, 12).toString('ascii');
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'AVI ') return 'video/x-msvideo';
    return '';
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return 'video/mp4';
  }
  if (b.subarray(0, 4).toString('ascii') === 'OggS') return 'video/ogg';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return '';
}

/** 这张图是不是动的（gif / 动态 webp / apng）。 */
export function isAnimated(buf, mime = '') {
  if (!buf?.length) return false;
  const kind = mime || sniffMime(buf);
  if (kind === 'image/gif') return true;
  if (kind === 'image/webp') return buf.includes('ANIM') && buf.includes('ANMF');
  if (kind === 'image/png') return buf.includes('acTL');
  return false;
}

function readJpegs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort()
    .map((f) => {
      try {
        return fs.readFileSync(path.join(dir, f));
      } catch {
        return null;
      }
    })
    .filter((b) => b?.length);
}

function pickIndices(total, n) {
  if (total <= n) return Array.from({ length: total }, (_, i) => i);
  const out = [];
  for (let k = 0; k < n; k += 1) out.push(Math.round((k * (total - 1)) / (n - 1)));
  return [...new Set(out)];
}

/**
 * 动图 → 均匀抽的 N 张 JPEG（按时间顺序）。
 * 抽不出（没 ffmpeg / 解码失败 / 单帧）就返回 []，调用方降级成静态图。
 */
export async function framesFromGif(buf, { maxFrames = 3, width = 480, timeoutMs = 15_000 } = {}) {
  if (!buf?.length) return [];
  if (!(await ffmpegReady())) return [];
  const dir = tmpDir('gif');
  try {
    const src = path.join(dir, 'in.gif');
    fs.writeFileSync(src, buf);
    const probe = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nk=1:nw=1', src],
      { timeoutMs: 10_000 },
    );
    const total = Math.max(0, Number(String(probe.stdout).trim().split(/\s+/).pop()) || 0);
    if (!total) return [];
    const n = Math.max(1, Math.min(Math.max(1, maxFrames), total));
    const expr = pickIndices(total, n).map((i) => `eq(n\\,${i})`).join('+');
    const out = path.join(dir, 'f_%03d.jpg');
    const res = await run(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', src, '-vf', `select=${expr},scale=min(${width}\\,iw):-2`, '-vsync', 'vfr', '-q:v', '4', out],
      { timeoutMs },
    );
    if (res.code !== 0) return [];
    return readJpegs(dir);
  } finally {
    rmrf(dir);
  }
}

/**
 * 视频文件 → 整段均匀抽 N 帧，返回 { frames, durationSec }。
 * 只抽帧不传视频：一分钟的视频直接塞给模型既贵又慢，关键帧足够看懂「在干嘛」。
 */
export async function framesFromVideoFile(file, { maxFrames = 4, width = 640, timeoutMs = 30_000 } = {}) {
  if (!file || !fs.existsSync(file)) return { frames: [], durationSec: 0 };
  if (!(await ffmpegReady())) return { frames: [], durationSec: 0 };
  let durationSec = 0;
  try {
    const probe = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file],
      { timeoutMs: 8000 },
    );
    durationSec = Number(String(probe.stdout).trim().split(/\s+/)[0]) || 0;
  } catch {
    /* 读不到时长就按 1fps 抽前几秒 */
  }
  const n = Math.max(1, Math.min(6, Number(maxFrames) || 4));
  // 时长很长时 fps 会很小（如 60s 视频抽 4 帧 = 0.067fps），ffmpeg 照样能均匀取到
  const fps = durationSec > 0.4 ? Math.max(0.02, Math.min(2, n / durationSec)) : 1;
  const dir = tmpDir('vid');
  try {
    const out = path.join(dir, 'f_%03d.jpg');
    const vf = `fps=${String(fps.toFixed(4))},scale=min(${width}\\,iw):-2`;
    const res = await run(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', file, '-vf', vf, '-frames:v', String(n), '-q:v', '4', out],
      { timeoutMs },
    );
    if (res.code !== 0) return { frames: [], durationSec };
    return { frames: readJpegs(dir), durationSec };
  } finally {
    rmrf(dir);
  }
}

/** 把远程媒体流式下到临时文件（体积有上限），返回 { file, bytes, cleanup }。 */
export async function downloadToTemp(url, { maxBytes = 60_000_000, timeoutMs = 25_000 } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const dir = tmpDir('dl');
  const file = path.join(dir, 'media.bin');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) {
      rmrf(dir);
      return null;
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) {
      rmrf(dir);
      return null;
    }
    const stream = fs.createWriteStream(file);
    let streamErr = null;
    stream.on('error', (err) => {
      streamErr = err;
    });
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          rmrf(dir);
          return null;
        }
        if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r));
      }
      await new Promise((resolve) => stream.end(resolve));
      if (streamErr) throw streamErr;
    } catch (err) {
      stream.destroy();
      rmrf(dir);
      if (err?.name === 'AbortError') return null;
      throw err;
    }
    if (!total) {
      rmrf(dir);
      return null;
    }
    return {
      file,
      bytes: total,
      cleanup: () => rmrf(dir),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 远程视频（http(s) 直链）→ 抽帧结果。内部负责下载与清理。 */
export async function framesFromVideoUrl(url, opts = {}) {
  // 下载和抽帧分开计时：QQ 的 4K 原片动辄 40MB，下载 30 秒很常见，
  // 但抽帧本身只要几秒；共用一个超时会把「还没下完」误判成「解不出来」。
  const got = await downloadToTemp(url, {
    maxBytes: opts.maxBytes ?? 60_000_000,
    timeoutMs: opts.downloadTimeoutMs ?? 60_000,
  });
  if (!got) return { frames: [], durationSec: 0, reason: 'download' };
  try {
    const res = await framesFromVideoFile(got.file, opts);
    return res.frames.length ? res : { ...res, reason: 'decode' };
  } finally {
    got.cleanup();
  }
}

/**
 * 展开一条合并转发：调 get_forward_msg，渲染成
 *   [转发了聊天记录·3条]
 *     A：在吗
 *     B：[图片]
 * 并把里面的图/视频原样收集出来（交给「看图」链路继续处理）。
 * 失败返回 null（调用方保留原来的「[合并转发]」占位符）。
 */
export async function expandForward(onebot, id, { maxNodes = 12, maxChars = 1200, timeoutMs = 4000 } = {}) {
  const target = String(id || '');
  if (!target || typeof onebot?.call !== 'function') return null;
  let data = null;
  try {
    data = await onebot.call('get_forward_msg', { id: target }, { timeoutMs: Math.max(1000, timeoutMs) });
  } catch {
    return null;
  }
  const nodes = Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.message) ? data.message : [];
  if (!nodes.length) return null;

  const lines = [];
  const images = [];
  const videos = [];
  let used = 0;
  let chars = 0;
  for (const node of nodes) {
    if (used >= maxNodes || chars >= maxChars) break;
    let segs = [];
    try {
      segs = normalizeMessage(node?.message);
    } catch {
      continue;
    }
    const body = plainText(segs);
    if (!body) continue;
    const name = String(node?.sender?.card || node?.sender?.nickname || node?.sender?.user_id || '某人').slice(0, 24);
    const text = [...body].length > 240 ? `${[...body].slice(0, 240).join('')}…` : body;
    used += 1;
    chars += [...text].length;
    lines.push(`  ${name}：${text}`);
    for (const im of imagesOf(segs)) if (images.length < 6) images.push({ ...im, forwarded: true });
    for (const v of videosOf(segs)) if (videos.length < 2) videos.push({ ...v, forwarded: true });
  }
  if (!lines.length) return null;
  const rest = nodes.length - used;
  const head = `[转发了聊天记录·${nodes.length}条]`;
  const tail = rest > 0 ? `\n  …（后面还有 ${rest} 条没展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, count: nodes.length, used, images, videos };
}
