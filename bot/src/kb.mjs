/**
 * 梗知识库：每周全网扫一遍，攒成可检索的条目。
 *
 * 存两条线：
 *   data/kb/memes.jsonl   一条一行，按 name 去重（同名只更新不重复）
 *   data/kb/state.json    { lastScanAt, lastCount }
 *
 * 条目形状：{name, meaning, origin, usage, example, heat, source, url, firstSeen, updatedAt}
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME_MAX = 14;
const TEXT_MAX = 400;

const clean = (v, max = TEXT_MAX) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawName = String(raw.name ?? raw.name_ ?? '').replace(/\s+/g, ' ').trim();
  if (!rawName || rawName.length > NAME_MAX) return null; // 太长的是整句话，不是梗
  const name = rawName;
  // 质量闸：纯数字、纯符号、一个字、整句话都不要
  if (name.length < 2) return null;
  if (/^[\d\s.．。、,，!！?？~～\-—_=+*/\\|:：;；'"“”‘’()（）[\]【】]+$/u.test(name)) return null;
  if (/[。！？!?]$/u.test(name)) return null;
  const heat = Number(raw.heat);
  return {
    name,
    meaning: clean(raw.meaning ?? raw.meaning_ ?? ''),
    origin: clean(raw.origin),
    usage: clean(raw.usage),
    example: clean(raw.example),
    heat: Number.isFinite(heat) ? Math.max(0, Math.min(100, Math.round(heat))) : 50,
    source: clean(raw.source, 40),
    url: clean(raw.url, 300),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => clean(t, 20)).filter(Boolean).slice(0, 6) : [],
  };
}

export class MemeKB {
  constructor({ dataDir = 'data', log } = {}) {
    this.dir = path.resolve(dataDir, 'kb');
    this.file = path.join(this.dir, 'memes.jsonl');
    this.stateFile = path.join(this.dir, 'state.json');
    this.log = log;
    this.map = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t);
          if (row?.name) this.map.set(row.name, row);
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    this.loaded = true;
    return this;
  }

  /** 写前先并一次磁盘：多个进程（bot + 采集脚本）同时写时，谁都不该把别人刚写的条目抹掉 */
  #mergeFromDisk() {
    try {
      if (!fs.existsSync(this.file)) return;
      const text = fs.readFileSync(this.file, 'utf8');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let row;
        try {
          row = JSON.parse(t);
        } catch {
          continue;
        }
        if (!row?.name) continue;
        const mine = this.map.get(row.name);
        if (!mine || (row.updatedAt || 0) > (mine.updatedAt || 0)) this.map.set(row.name, row);
      }
    } catch {
      /* 读不到就按手里的写，不能因此丢数据 */
    }
  }

  #rewrite() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body = [...this.map.values()].map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(tmp, body ? `${body}\n` : '');
    fs.renameSync(tmp, this.file);
  }

  /** 批量写入，同名合并（保留旧的 firstSeen，更新其余字段） */
  addMany(items = []) {
    this.load();
    let added = 0;
    let updated = 0;
    const now = Date.now();
    for (const raw of items) {
      const entry = normalizeEntry(raw);
      if (!entry) continue;
      const old = this.map.get(entry.name);
      if (old) {
        this.map.set(entry.name, {
          ...old,
          ...entry,
          // 空字段不要覆盖已有的
          meaning: entry.meaning || old.meaning,
          origin: entry.origin || old.origin,
          usage: entry.usage || old.usage,
          example: entry.example || old.example,
          url: entry.url || old.url,
          heat: Math.max(old.heat || 0, entry.heat),
          firstSeen: old.firstSeen || now,
          updatedAt: now,
        });
        updated += 1;
      } else {
        this.map.set(entry.name, { ...entry, firstSeen: now, updatedAt: now });
        added += 1;
      }
    }
    if (added || updated) {
      this.#mergeFromDisk();
      this.#rewrite();
    }
    this.log?.info?.(`梗库：新增 ${added} 条，更新 ${updated} 条，共 ${this.map.size} 条`);
    return { added, updated, total: this.map.size };
  }

  /** 清掉不合格的老条目（纯数字、整句话之类） */
  prune() {
    this.load();
    const removed = [];
    for (const [name, row] of [...this.map.entries()]) {
      const ok = normalizeEntry(row);
      if (!ok || ok.name !== name) {
        this.map.delete(name);
        removed.push(name);
      }
    }
    if (removed.length) this.#rewrite();
    this.log?.info?.(`梗库：清掉 ${removed.length} 条不合格条目`);
    return removed;
  }

  all() {
    this.load();
    return [...this.map.values()].sort((a, b) => (b.heat || 0) - (a.heat || 0) || b.updatedAt - a.updatedAt);
  }

  /** 用出去被人接住了：热度 +delta，并打个 hit 标记（学什么样的梗有人吃） */
  bump(name, delta = 5) {
    const key = String(name || '').trim();
    const row = this.map.get(key);
    if (!row) return null;
    row.heat = Math.max(0, Math.min(100, Math.round((row.heat || 0) + delta)));
    const tags = new Set(Array.isArray(row.tags) ? row.tags : []);
    tags.add('hit');
    row.tags = [...tags];
    row.updatedAt = Date.now();
    try {
      this.#mergeFromDisk();
      this.#rewrite();
    } catch {
      /* 写不进去不影响说话 */
    }
    return row;
  }

  search(query, { limit = 8 } = {}) {
    this.load();
    const q = clean(query, 40);
    if (!q) return [];
    const hit = [];
    for (const row of this.map.values()) {
      const hay = `${row.name} ${row.meaning} ${row.origin} ${row.usage} ${row.example} ${(row.tags || []).join(' ')}`;
      if (hay.includes(q)) hit.push({ row, score: row.heat || 0 });
    }
    return hit
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => h.row);
  }

  /** 给模型看的简报：名字 + 一句含义 */
  brief({ limit = 12 } = {}) {
    const rows = this.all().slice(0, limit);
    return rows.map((r) => `- ${r.name}：${r.meaning || r.origin || '（暂无释义）'}`).join('\n');
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return { lastScanAt: 0, lastCount: 0 };
    }
  }

  writeState(patch) {
    fs.mkdirSync(this.dir, { recursive: true });
    const next = { ...this.readState(), ...patch };
    fs.writeFileSync(this.stateFile, JSON.stringify(next, null, 2));
    return next;
  }

  stats() {
    this.load();
    const rows = [...this.map.values()];
    const tags = new Map();
    for (const r of rows) for (const t of r.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    return {
      total: rows.length,
      lastScanAt: this.readState().lastScanAt || 0,
      top: rows.sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, 5).map((r) => r.name),
      tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => `${t}(${n})`),
    };
  }
}
