import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

/**
 * 归档检索：按需从 data/history/*.jsonl 里捞历史，不需要预先做摘要。
 *
 * 文件是一行一条 JSON（{ts, role, name, text, messageId, scope}），
 * 所以检索就是流式扫一遍——几万行也就几十毫秒，不占内存，也不用建索引。
 */

export function archiveDir(dataDir) {
  return path.join(dataDir, 'history');
}

/** 列出所有归档过的会话 */
export function listArchives(dataDir) {
  const dir = archiveDir(dataDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'));
  } catch {
    return [];
  }
  return names
    .map((f) => {
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      const base = f.replace(/\.jsonl(\.gz)?$/, '').replace(/\.\d{8}-\d{6}(-\d+)?$/, '');
      return {
        scope: base.replace('_', ':'),
        file,
        gz: f.endsWith('.gz'),
        lines: countLines(file),
        bytes: st.size,
        modifiedAt: st.mtimeMs,
      };
    })
    .sort((a, b) => a.modifiedAt - b.modifiedAt);
}

function countLines(file) {
  try {
    const raw = fs.readFileSync(file);
    const buf = file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw;
    let n = 0;
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) n += 1;
    return n;
  } catch {
    return 0;
  }
}

function scopeFiles(dataDir, scope) {
  const dir = archiveDir(dataDir);
  const base = String(scope).replace(':', '_');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f === `${base}.jsonl` || (f.startsWith(`${base}.`) && f.endsWith('.jsonl.gz')));
  } catch {
    return [];
  }
  return names.sort().map((f) => path.join(dir, f));
}

/**
 * 按条件捞历史。
 * @param {object} opts
 * @param {string} [opts.scope]    只查某个会话（不限就查全部）
 * @param {string} [opts.query]    关键词（不区分大小写，命中 text 或 name）
 * @param {number} [opts.days]     只查最近 N 天
 * @param {number} [opts.since]    起始时间戳（ms），优先于 days
 * @param {number} [opts.until]    截止时间戳（ms）
 * @param {string} [opts.name]     只看某个人说的（模糊匹配 name）
 * @param {boolean} [opts.onlyMe]  只看我自己说的
 * @param {number} [opts.limit]    最多返回多少条（默认 50，从最新的往回取）
 * @param {number} [opts.context]  每条命中前后各带几条上下文（默认 0）
 */
export async function searchHistory(dataDir, opts = {}) {
  const {
    scope,
    query,
    days,
    since,
    until,
    name,
    onlyMe = false,
    limit = 50,
    context = 0,
  } = opts;
  const sinceTs = since ?? (days ? Date.now() - days * 86400_000 : 0);
  const untilTs = until ?? Number.MAX_SAFE_INTEGER;
  const q = query ? String(query).toLowerCase() : '';
  const nameLike = name ? String(name) : '';

  const files = scope ? scopeFiles(dataDir, scope) : listArchives(dataDir).map((a) => a.file);
  const hits = [];

  for (const file of files) {
    const rows = [];
    const stream = fs.createReadStream(file);
    const input = file.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream;
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      rows.push(row);
    }
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const ts = row.ts || 0;
      if (ts < sinceTs || ts > untilTs) continue;
      if (onlyMe && row.role !== 'bot') continue;
      if (nameLike && !String(row.name || '').includes(nameLike)) continue;
      if (q) {
        const hay = `${row.text || ''} ${row.name || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const slice = context
        ? rows.slice(Math.max(0, i - context), Math.min(rows.length, i + context + 1)).map((r) => ({
            ts: r.ts,
            who: r.role === 'bot' ? '我' : r.name,
            text: r.text,
          }))
        : null;
      hits.push({
        scope: row.scope || path.basename(file).replace(/\.jsonl$/, '').replace('_', ':'),
        ts,
        who: row.role === 'bot' ? '我' : row.name,
        role: row.role,
        text: row.text,
        messageId: row.messageId || '',
        ...(slice ? { context: slice } : {}),
      });
    }
  }

  hits.sort((a, b) => a.ts - b.ts);
  const total = hits.length;
  const kept = limit > 0 ? hits.slice(Math.max(0, hits.length - limit)) : hits;
  return { total, returned: kept.length, hits: kept };
}

/** 统计一下归档规模，给「我现在记得多少」用 */
export function archiveStats(dataDir) {
  const list = listArchives(dataDir);
  const byScope = {};
  let lines = 0;
  let bytes = 0;
  for (const a of list) {
    const cur = byScope[a.scope] || { lines: 0, bytes: 0, segments: 0, modifiedAt: 0 };
    cur.lines += a.lines;
    cur.bytes += a.bytes;
    cur.segments += 1;
    cur.modifiedAt = Math.max(cur.modifiedAt, a.modifiedAt);
    byScope[a.scope] = cur;
    lines += a.lines;
    bytes += a.bytes;
  }
  return { scopes: Object.keys(byScope).length, lines, bytes, byScope };
}
