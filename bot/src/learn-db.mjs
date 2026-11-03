/**
 * 学习知识库：一个本地 SQLite（Node 22 自带 node:sqlite，零依赖）。
 *
 * 为什么要换个库：以前笔记全塞 notes.json，学多了就是「整文件读进内存、全量重写」，
 * 几千条就会卡，也没法按需检索。现在分三张表：
 *   notes      —— 蒸馏出来的短笔记（群里的梗、网上的事、相处经验）
 *   messages   —— 所有聊过的原话（只说「谁在什么时候说了什么」），按需检索用
 *   meta       —— 学习游标（每个会话学到哪了、上次跑的时间）
 * 检索用 SQLite 自带的 FTS5：中文按 bigram 切词（显/卡/涨价 → 显 卡 涨 价 ...），
 * BM25 排序，几万条也是毫秒级。
 * 另有 notes_vec / messages_vec 两张表存语义向量（阿里云 text-embedding-v4，1024 维）：
 * 字面检索找不全同义说法，向量补这一块；两路结果用 RRF 融合，向量缺失就只用 FTS。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from './util.mjs';
import { cosine, packVec, unpackVec } from './embed.mjs';

const BATCH = 500;

/** 中文按二元切词、英文数字按词切，拼成 FTS 的 token 串 */
export function ftsTokens(text) {
  const raw = String(text ?? '').toLowerCase();
  const out = [];
  for (const m of raw.matchAll(/[a-z0-9]+|[\u4e00-\u9fff]+/gu)) {
    const chunk = m[0];
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length > 1) out.push(chunk);
      continue;
    }
    if (chunk.length === 1) {
      out.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length - 1; i += 1) out.push(chunk.slice(i, i + 2));
  }
  return out.join(' ');
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

export class LearnDB {
  constructor({ file, log } = {}) {
    if (!file) throw new Error('LearnDB 需要 file');
    ensureDir(path.dirname(file));
    this.file = file;
    this.log = log;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.#schema();
  }

  #schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'chat',
        scope TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        weight REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(toks, scope UNINDEXED, kind UNINDEXED, tokenize="unicode61");
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL DEFAULT 0,
        speaker TEXT NOT NULL DEFAULT '',
        uin TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(toks, scope UNINDEXED, tokenize="unicode61");
      CREATE INDEX IF NOT EXISTS idx_messages_scope_ts ON messages(scope, ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes_vec (note_id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS messages_vec (msg_id INTEGER PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL);
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes(scope)');
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 已关 */
    }
  }

  /* ----------------------------------------------------------- meta */

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value ?? null));
  }

  /* --------------------------------------------------------- notes */

  get noteCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n) || 0;
  }

  allNotes({ scope = null } = {}) {
    const rows = scope
      ? this.db.prepare('SELECT * FROM notes WHERE scope = ? ORDER BY created_at DESC').all(scope)
      : this.db.prepare('SELECT * FROM notes ORDER BY created_at DESC').all();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      scope: r.scope,
      text: r.text,
      tags: JSON.parse(r.tags || '[]'),
      weight: r.weight,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  insertNote({ id, kind, scope, text, tags, weight, createdAt, lastSeenAt }) {
    this.db
      .prepare(
        'INSERT INTO notes(id, kind, scope, text, tags, weight, created_at, last_seen_at) VALUES(?,?,?,?,?,?,?,?)'
      )
      .run(id, kind, scope || '', text, JSON.stringify(tags || []), weight || 1, createdAt, lastSeenAt || createdAt);
    this.#ftsInsertNote(id, text, scope || '', kind);
  }

  updateNote(note) {
    this.db
      .prepare('UPDATE notes SET tags = ?, weight = ?, last_seen_at = ? WHERE id = ?')
      .run(JSON.stringify(note.tags || []), note.weight || 1, note.lastSeenAt || Date.now(), note.id);
  }

  touchNotes(ids) {
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE notes SET weight = MIN(20, weight + 1), last_seen_at = ? WHERE id = ?');
    for (const id of ids || []) stmt.run(now, id);
    return ids?.length || 0;
  }

  /** 超上限就按「权重高、最近还有用」裁掉尾巴 */
  pruneNotes(maxNotes, ageDays = 0) {
    const limit = Math.max(50, Number(maxNotes) || 600);
    if (this.noteCount <= limit) return 0;
    const existingToks = this.db
      .prepare('SELECT id, text FROM notes ORDER BY (weight * 3 - (? - last_seen_at) / 86400000.0) DESC LIMIT ?')
      .all(Date.now(), limit);
    const keep = new Set(existingToks.map((r) => r.id));
    const drop = this.db.prepare('SELECT id, text, scope, kind FROM notes').all().filter((r) => !keep.has(r.id));
    for (const r of drop) this.#ftsDeleteNote(r.id, r.text, r.scope, r.kind);
    const del = this.db.prepare('DELETE FROM notes WHERE id = ?');
    const delVec = this.db.prepare('DELETE FROM notes_vec WHERE note_id = ?');
    for (const r of drop) {
      del.run(r.id);
      delVec.run(r.id);
    }
    return drop.length;
  }

  searchNotes(query, { scope = null, k = 6, kinds = null } = {}) {
    const toks = ftsTokens(query);
    if (!toks.trim()) return [];
    const match = toks.split(' ').slice(0, 24).map((t) => `"${t}"`).join(' OR ');
    let rows = [];
    try {
      rows = this.db
        .prepare(
          `SELECT n.*, bm25(notes_fts) AS rank FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ? AND (? IS NULL OR n.scope = '' OR n.scope = ?)
            ORDER BY rank LIMIT ?`
        )
        .all(match, scope, scope, Math.max(1, k * 4));
    } catch (err) {
      this.log?.debug?.(`笔记检索失败：${err.message}`);
      return [];
    }
    const out = rows
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        scope: r.scope,
        text: r.text,
        tags: JSON.parse(r.tags || '[]'),
        weight: r.weight,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        rank: r.rank,
      }))
      .filter((r) => !kinds || kinds.includes(r.kind));
    out.sort((a, b) => scoreOf(a, scope) - scoreOf(b, scope));
    return out.slice(0, k);
  }

  /* ------------------------------------------------------ messages */

  addMessages(rows) {
    const list = (rows || []).filter((r) => r && String(r.text || '').trim());
    if (!list.length) return 0;
    const insert = this.db.prepare(
      'INSERT INTO messages(scope, ts, speaker, uin, role, text) VALUES(?,?,?,?,?,?)'
    );
    const fts = this.db.prepare('INSERT INTO messages_fts(rowid, toks, scope) VALUES(?,?,?)');
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of list) {
        const text = clean(r.text).slice(0, 600);
        const info = insert.run(String(r.scope || ''), Number(r.ts) || 0, clean(r.speaker || r.name || ''), String(r.uin || ''), String(r.role || ''), text);
        fts.run(Number(info.lastInsertRowid), ftsTokens(text), String(r.scope || ''));
        n += 1;
        if (n % BATCH === 0) {
          this.db.exec('COMMIT');
          this.db.exec('BEGIN');
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    return n;
  }

  get messageCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n) || 0;
  }

  /** 按需翻原话：谁在什么时候说过类似的话 */
  searchMessages(query, { scope = null, k = 6, since = 0 } = {}) {
    const toks = ftsTokens(query);
    if (!toks.trim()) return [];
    const match = toks.split(' ').slice(0, 20).map((t) => `"${t}"`).join(' OR ');
    try {
      const rows = this.db
        .prepare(
          `SELECT m.*, bm25(messages_fts) AS rank FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
            WHERE messages_fts MATCH ? AND (? IS NULL OR m.scope = ?) AND m.ts >= ?
            ORDER BY rank LIMIT ?`
        )
        .all(match, scope, scope, Number(since) || 0, Math.max(1, k * 3));
      return rows
        .map((r) => ({ id: r.id, scope: r.scope, ts: r.ts, speaker: r.speaker, uin: r.uin, role: r.role, text: r.text, rank: r.rank }))
        .slice(0, k);
    } catch (err) {
      this.log?.debug?.(`原话检索失败：${err.message}`);
      return [];
    }
  }

  stats() {
    const byKind = {};
    for (const r of this.db.prepare('SELECT kind, COUNT(*) AS n FROM notes GROUP BY kind').all()) byKind[r.kind] = r.n;
    const byScope = {};
    for (const r of this.db.prepare('SELECT scope, COUNT(*) AS n FROM messages GROUP BY scope').all()) byScope[r.scope] = r.n;
    return { notes: this.noteCount, byKind, messages: this.messageCount, byScope };
  }

  /* -------------------------------------------------------- 向量 */

  /** 存一批向量；kind = 'note' | 'message' */
  putVectors(kind, pairs) {
    const list = (pairs || []).filter((p) => p && p.vec?.length);
    if (!list.length) return 0;
    const sql =
      kind === 'message'
        ? 'INSERT INTO messages_vec(msg_id, dim, vec) VALUES(?,?,?) ON CONFLICT(msg_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec'
        : 'INSERT INTO notes_vec(note_id, dim, vec) VALUES(?,?,?) ON CONFLICT(note_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec';
    const stmt = this.db.prepare(sql);
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const p of list) {
        stmt.run(kind === 'message' ? Number(p.id) : String(p.id), p.vec.length, packVec(p.vec));
        n += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    return n;
  }

  /** 还没做向量的条目（拿去喂 embedding） */
  pendingVectors(kind, { limit = 400 } = {}) {
    if (kind === 'message') {
      return this.db
        .prepare(
          `SELECT m.id AS id, m.text AS text FROM messages m
             LEFT JOIN messages_vec v ON v.msg_id = m.id
            WHERE v.msg_id IS NULL ORDER BY m.id DESC LIMIT ?`
        )
        .all(Math.max(1, limit))
        .map((r) => ({ id: Number(r.id), text: r.text }));
    }
    return this.db
      .prepare(
        `SELECT n.id AS id, n.text AS text FROM notes n
           LEFT JOIN notes_vec v ON v.note_id = n.id
          WHERE v.note_id IS NULL ORDER BY n.rowid DESC LIMIT ?`
      )
      .all(Math.max(1, limit))
      .map((r) => ({ id: String(r.id), text: r.text }));
  }

  /** 清空某个 kind 的全部向量（换 embedding 模型时必须清，向量空间不通用） */
  clearVectors(kind) {
    const table = kind === 'message' ? 'messages_vec' : 'notes_vec';
    const n = this.vectorCount(kind);
    this.db.exec(`DELETE FROM ${table}`);
    return n;
  }

  vectorCount(kind) {
    const table = kind === 'message' ? 'messages_vec' : 'notes_vec';
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) || 0;
  }

  /** 语义检索笔记 */
  searchNotesByVec(qvec, { scope = null, k = 6, kinds = null } = {}) {
    if (!qvec?.length) return [];
    let rows = [];
    try {
      rows = this.db
        .prepare(
          `SELECT n.*, v.vec AS vec FROM notes_vec v JOIN notes n ON n.id = v.note_id
            WHERE (? IS NULL OR n.scope = '' OR n.scope = ?)`
        )
        .all(scope, scope);
    } catch (err) {
      this.log?.debug?.(`笔记向量检索失败：${err.message}`);
      return [];
    }
    const scored = [];
    for (const r of rows) {
      if (kinds && !kinds.includes(r.kind)) continue;
      const sim = cosine(qvec, unpackVec(r.vec));
      if (sim < 0.2) continue;
      scored.push({
        id: r.id,
        kind: r.kind,
        scope: r.scope,
        text: r.text,
        tags: JSON.parse(r.tags || '[]'),
        weight: r.weight,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        sim,
      });
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, k);
  }

  /** 语义检索原话 */
  searchMessagesByVec(qvec, { scope = null, k = 6, since = 0 } = {}) {
    if (!qvec?.length) return [];
    let rows = [];
    try {
      rows = this.db
        .prepare(
          `SELECT m.*, v.vec AS vec FROM messages_vec v JOIN messages m ON m.id = v.msg_id
            WHERE (? IS NULL OR m.scope = ?) AND m.ts >= ?`
        )
        .all(scope, scope, Number(since) || 0);
    } catch (err) {
      this.log?.debug?.(`原话向量检索失败：${err.message}`);
      return [];
    }
    const scored = [];
    for (const r of rows) {
      const sim = cosine(qvec, unpackVec(r.vec));
      if (sim < 0.25) continue;
      scored.push({ id: r.id, scope: r.scope, ts: r.ts, speaker: r.speaker, uin: r.uin, role: r.role, text: r.text, sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, k);
  }

  /* ------------------------------------------------------ fts 维护 */

  #ftsInsertNote(id, text, scope, kind) {
    try {
      this.db.prepare('INSERT INTO notes_fts(rowid, toks, scope, kind) VALUES(?,?,?,?)').run(this.#rowidOf(id), ftsTokens(text), scope || '', kind || 'chat');
    } catch (err) {
      this.log?.debug?.(`笔记索引失败：${err.message}`);
    }
  }

  #ftsDeleteNote(id, text, scope, kind) {
    try {
      this.db
        .prepare("INSERT INTO notes_fts(notes_fts, rowid, toks, scope, kind) VALUES('delete', ?, ?, ?, ?)")
        .run(this.#rowidOf(id), ftsTokens(text), scope || '', kind || 'chat');
    } catch (err) {
      this.log?.debug?.(`笔记反索引失败：${err.message}`);
    }
  }

  /** FTS 用 rowid 定位笔记：把字符串 id 映射成整数，反查走 notes 表 */
  #rowidOf(id) {
    const row = this.db.prepare("SELECT rowid FROM notes WHERE id = ?").get(id);
    return Number(row?.rowid) || 0;
  }
}

/** BM25 是负数、越小越相关；这里换成越大越相关 */
function scoreOf(note, scope) {
  const rank = Number(note.rank) || 0;
  let s = -rank * 10;
  if (scope && note.scope === scope) s += 6;
  else if (!note.scope) s += 1;
  s += Math.min(3, Number(note.weight) || 1) * 0.8;
  s -= Math.min(6, (Date.now() - (note.lastSeenAt || 0)) / (7 * 24 * 3600_000));
  return -s;
}

export default LearnDB;
