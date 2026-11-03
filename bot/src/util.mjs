import fs from 'node:fs';
import path from 'node:path';

/** 毫秒延时 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** [min, max] 之间的随机整数 */
export const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/** 带抖动的延时，让机器人更像真人打字 */
export const humanPause = (baseMs, jitter = 0.35) =>
  sleep(Math.round(baseMs * (1 + (Math.random() * 2 - 1) * jitter)));

export const nowIso = () => new Date().toISOString();

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免进程被杀时留下半个 JSON */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** 读 JSONL 末尾 n 行（文件可能很大，从尾部按块读） */
export function readJsonlTail(file, n = 20) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = 64 * 1024;
    let readSize = Math.min(size, chunk);
    let text = '';
    let pos = size;
    while (pos > 0) {
      pos = Math.max(0, pos - readSize);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      text = buf.toString('utf8') + text;
      if (text.split('\n').length > n + 1) break;
      readSize = Math.min(chunk * 4, pos) || 1;
      if (pos === 0) break;
    }
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 极简 logger：默认 info，可用 QQ_LOG_LEVEL=debug 打开 */
export function createLogger(name = 'qq', level = process.env.QQ_LOG_LEVEL || 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, args) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${lvl.toUpperCase().padEnd(5)} [${name}]`;
    console[lvl === 'debug' ? 'log' : lvl](line, ...args);
  };
  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    child: (sub) => createLogger(`${name}:${sub}`, level),
  };
}

/** 极简事件总线，用于把运行日志推给控制台 SSE */
export class Emitter {
  #listeners = new Set();

  on(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.#listeners) {
      try {
        fn(event);
      } catch {
        /* 监听器自己出错不影响主流程 */
      }
    }
  }
}

export function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** 用于给消息文本做长度裁剪（按 Unicode 码点，避免切坏 emoji） */
export function truncate(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

export function scopeKey(scope) {
  if (!scope || typeof scope !== 'string') throw new Error('scope 必须形如 group:123 或 private:456');
  const m = /^(group|private):(\d+)$/.exec(scope.trim());
  if (!m) throw new Error(`无法识别的 scope：${scope}（应为 group:群号 或 private:QQ号）`);
  return { type: m[1], id: Number(m[2]), key: `${m[1]}:${m[2]}` };
}

/** 两段中文短文本的相似度（去标点后按字符 bigram 的 Jaccard），用于检测复读 */
/** 包含度：短的那句有多大比例被长的那句覆盖（改写/压缩后仍能抓到重复） */
export function containment(a, b) {
  const norm = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  const grams = (t) => {
    const x = norm(t);
    if (x.length < 2) return new Set([x]);
    const set = new Set();
    for (let i = 0; i < x.length - 1; i += 1) set.add(x.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  const small = Math.min(ga.size, gb.size);
  return small ? hit / small : 0;
}

function ngrams(text, n) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  if (norm.length < n) return new Set([norm]);
  const set = new Set();
  for (let i = 0; i <= norm.length - n; i += 1) set.add(norm.slice(i, i + n));
  return set;
}

function containN(a, b, n) {
  const ga = ngrams(a, n);
  const gb = ngrams(b, n);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / Math.min(ga.size, gb.size);
}

/** 宽松相似度：Jaccard、二字包含、三字包含取大者（换说法、压缩句子时更灵） */
export function similarityLoose(a, b) {
  return Math.max(similarity(a, b), 0.9 * containment(a, b), containN(a, b, 3));
}

export function similarity(a, b) {
  const norm = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  const grams = (t) => {
    const x = norm(t);
    if (x.length < 2) return new Set([x]);
    const set = new Set();
    for (let i = 0; i < x.length - 1; i += 1) set.add(x.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}
