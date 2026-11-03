/**
 * 自主学习：把「在群里聊的天」和「从网上收来的资讯」蒸馏成长期笔记，
 * 回话、主动分享、发说说时按当下语境挑几条带进提示词，让它越聊越像个真人。
 *
 * 存储：data/learn/notes.json
 * {
 *   updatedAt, lastRunAt,
 *   lastChat: { "group:123": 1730000000000 },   // 每个会话学到哪了
 *   notes: [{ id, kind: 'chat'|'web', scope, text, tags: [], weight, createdAt, lastSeenAt }]
 * }
 *
 * 与别的模块的分工：
 *   - people.mjs 记「人」，memory.mjs 记「这个群之前发生过什么」，kb.mjs 存「梗百科」；
 *   - 这里记「泛化的经验」：群里的黑话/梗、大家最近关心什么、这个群的说话习惯、网上刚发生的事。
 * 一条笔记必须短（≤120 字）、可复用，不许是流水账。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson } from './util.mjs';
import { LearnDB } from './learn-db.mjs';
import { searchWeb, toutiaoHot } from './sources.mjs';

const NOTE_MAX = 120;
const TEXT_MIN = 4;
const MAX_NOTES = 600;
const SIMILAR = 0.62;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

function grams(text) {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** 2-gram 余弦近似的 Jaccard，用来判「是不是同一件事」 */
export function noteSimilar(a, b) {
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 从模型输出里解析「一句话|关键词,关键词」，也容忍「- 一句话」这种没给关键词的 */
export function parseNotes(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    let t = line.trim();
    if (!t || /^[#>*]+/.test(t) === false && false) continue;
    t = t.replace(/^[-*·\d.、)\s]+/u, '').trim();
    if (!t) continue;
    const bar = t.lastIndexOf('|');
    let text = t;
    let tags = [];
    if (bar > 0) {
      text = t.slice(0, bar).trim();
      tags = t
        .slice(bar + 1)
        .split(/[,，、\s]+/u)
        .map((x) => clean(x).slice(0, 12))
        .filter(Boolean)
        .slice(0, 4);
    }
    text = clean(text).slice(0, NOTE_MAX);
    if ([...text].length < TEXT_MIN) continue;
    if (/^(一句话|笔记|内容)[:：]/u.test(text)) text = text.replace(/^[^:：]+[:：]\s*/u, '');
    if (!text) continue;
    out.push({ text, tags });
  }
  return out;
}

export class LearnBook {
  constructor({ dataDir = 'data', log, maxNotes = MAX_NOTES, embedder = null } = {}) {
    this.dir = ensureDir(path.resolve(dataDir, 'learn'));
    this.file = path.join(this.dir, 'notes.json'); // 旧格式，只在迁移时读
    this.log = log;
    this.maxNotes = Math.max(50, Number(maxNotes) || MAX_NOTES);
    this.db = new LearnDB({ file: path.join(this.dir, 'kb.db'), log });
    this.embedder = embedder; // 没有就纯字面检索
    this.state = null;
    this.migrated = 0;
    this.#migrate();
  }

  /** 老 notes.json 一次性搬进 SQLite，原文件改名留档 */
  #migrate() {
    if (!fs.existsSync(this.file)) return;
    const raw = readJson(this.file, null);
    if (!raw) return;
    const now = Date.now();
    for (const n of Array.isArray(raw?.notes) ? raw.notes : []) {
      if (!n?.text) continue;
      if (this.#findSame(n.text, n.scope || '')) continue;
      this.db.insertNote({
        id: n.id || `m${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        kind: n.kind || 'chat',
        scope: n.scope || '',
        text: String(n.text).slice(0, NOTE_MAX),
        tags: n.tags || [],
        weight: Number(n.weight) || 1,
        createdAt: Number(n.createdAt) || now,
        lastSeenAt: Number(n.lastSeenAt) || now,
      });
      this.migrated += 1;
    }
    if (raw?.lastChat && typeof raw.lastChat === 'object') this.db.setMeta('lastChat', raw.lastChat);
    this.db.setMeta('lastRunAt', Number(raw?.lastRunAt) || 0);
    fs.renameSync(this.file, `${this.file}.migrated`);
    if (this.migrated) this.log?.info?.(`学习笔记迁到 SQLite：${this.migrated} 条`);
  }

  load() {
    if (this.state) return this.state;
    this.state = {
      lastRunAt: Number(this.db.getMeta('lastRunAt', 0)) || 0,
      lastChat: this.db.getMeta('lastChat', {}) || {},
      lastSocial: this.db.getMeta('lastSocial', {}) || {},
      updatedAt: Number(this.db.getMeta('updatedAt', 0)) || 0,
    };
    return this.state;
  }

  save() {
    const st = this.load();
    st.updatedAt = Date.now();
    this.db.setMeta('lastRunAt', st.lastRunAt || 0);
    this.db.setMeta('lastChat', st.lastChat || {});
    this.db.setMeta('lastSocial', st.lastSocial || {});
    this.db.setMeta('updatedAt', st.updatedAt);
    return st;
  }

  get notes() {
    return this.db.allNotes();
  }

  /** 按需检索：这个群（或全局）里跟 context 有关的笔记 */
  search(query, { scope = '', k = 6, kinds = null } = {}) {
    return this.db.searchNotes(query, { scope: scope || null, k, kinds });
  }

  /** 按需检索原话（谁什么时候说过） */
  searchMessages(query, { scope = '', k = 6 } = {}) {
    return this.db.searchMessages(query, { scope: scope || null, k });
  }

  get semanticReady() {
    return Boolean(this.embedder?.enabled);
  }

  /**
   * 补向量：把还没做过向量的笔记/原话批量喂给 embedding 接口。
   * 失败只记日志、不抛（语义召回是加分项，字面检索永远可用）。
   */
  async embedPending({ notes = true, messages = true, limit = 400, onProgress = null } = {}) {
    if (!this.semanticReady) return { notes: 0, messages: 0, skipped: true };
    // 换了 embedding 模型就得整个重做：不同模型的向量空间不互通，混着算余弦没有意义
    const stamp = String(this.embedder.model || 'unknown');
    if (this.db.getMeta('vecModel', '') !== stamp) {
      const dropped = this.db.clearVectors('note') + this.db.clearVectors('message');
      this.db.setMeta('vecModel', stamp);
      if (dropped) this.log?.info?.(`换了 embedding 模型（${stamp}），清掉旧向量 ${dropped} 条重做`);
    }
    const out = { notes: 0, messages: 0 };
    const jobs = [];
    if (notes) jobs.push(['note', Math.min(limit, 200)]);
    if (messages) jobs.push(['message', limit]);
    for (const [kind, cap] of jobs) {
      const todo = this.db.pendingVectors(kind, { limit: cap });
      if (!todo.length) continue;
      try {
        const vecs = await this.embedder.embed(todo.map((t) => t.text));
        const pairs = todo.map((t, i) => ({ id: t.id, vec: vecs[i] }));
        out[kind === 'note' ? 'notes' : 'messages'] = this.db.putVectors(kind, pairs);
        onProgress?.(kind, todo.length);
      } catch (err) {
        this.log?.warn?.(`补向量失败（${kind}）：${err.message}`);
      }
    }
    return out;
  }

  #rrf(lex, sem, k) {
    const score = new Map();
    const bump = (id, s, item) => {
      const cur = score.get(id) || { score: 0, item };
      cur.score += s;
      score.set(id, cur);
    };
    lex.forEach((it, i) => bump(it.id, 1 / (30 + i), it));
    sem.forEach((it, i) => bump(it.id, 1.2 / (30 + i), { ...it, ...(i === 0 ? {} : {}) }));
    return [...score.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((v) => ({ ...v.item, rrf: v.score }));
  }

  /** 字面 + 语义融合检索笔记（语义接口挂了就只剩字面） */
  async searchSmart(query, { scope = '', k = 6, kinds = null, timeoutMs = 1200 } = {}) {
    const lex = this.search(query, { scope, k: k * 3, kinds });
    if (!this.semanticReady || !clean(query)) return lex.slice(0, k);
    let sem = [];
    try {
      const qvec = await Promise.race([
        this.embedder.embedOne(query),
        new Promise((_, reject) => setTimeout(() => reject(new Error('embedding 超时')), timeoutMs)),
      ]);
      sem = this.db.searchNotesByVec(qvec, { scope: scope || null, k: k * 3, kinds });
    } catch (err) {
      this.log?.debug?.(`语义检索跳过：${err.message}`);
    }
    if (!sem.length) return lex.slice(0, k);
    return this.#rrf(lex, sem, k);
  }

  /** 字面 + 语义融合检索原话 */
  async searchMessagesSmart(query, { scope = '', k = 6, timeoutMs = 1200 } = {}) {
    const lex = this.searchMessages(query, { scope, k: k * 3 });
    if (!this.semanticReady || !clean(query)) return lex.slice(0, k);
    let sem = [];
    try {
      const qvec = await Promise.race([
        this.embedder.embedOne(query),
        new Promise((_, reject) => setTimeout(() => reject(new Error('embedding 超时')), timeoutMs)),
      ]);
      sem = this.db.searchMessagesByVec(qvec, { scope: scope || null, k: k * 3 });
    } catch (err) {
      this.log?.debug?.(`语义翻原话跳过：${err.message}`);
    }
    if (!sem.length) return lex.slice(0, k);
    return this.#rrf(lex, sem, k);
  }

  /** 把一批聊天原文落进库里，供以后按需翻 */
  ingest(scope, rows) {
    const now = Date.now();
    return this.db.addMessages(
      (rows || []).map((r) => ({
        scope,
        ts: Number(r.ts) || now,
        speaker: r.name || r.speaker || '',
        uin: r.uin || r.uid || '',
        role: r.role || '',
        text: r.text,
      }))
    );
  }

  #findSame(text, scope) {
    return this.db.allNotes({ scope }).find((n) => noteSimilar(n.text, text) >= SIMILAR) || null;
  }

  /**
   * 加一批笔记；和已有笔记说的是一件事就只加权、不重复存。
   * @returns {{added:number, merged:number}}
   */
  addMany(items, { kind = 'chat', scope = '' } = {}) {
    const now = Date.now();
    let added = 0;
    let merged = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const text = clean(item?.text).slice(0, NOTE_MAX);
      if ([...text].length < TEXT_MIN) continue;
      const tags = (Array.isArray(item?.tags) ? item.tags : []).map((t) => clean(t).slice(0, 12)).filter(Boolean).slice(0, 4);
      const hit = this.#findSame(text, scope || '');
      if (hit) {
        hit.weight = Math.min(20, (Number(hit.weight) || 1) + 1);
        hit.lastSeenAt = now;
        if (tags.length && !hit.tags?.length) hit.tags = tags;
        this.db.updateNote(hit);
        merged += 1;
        continue;
      }
      this.db.insertNote({
        id: `n${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        kind,
        scope: scope || '',
        text,
        tags,
        weight: 1,
        createdAt: now,
        lastSeenAt: now,
      });
      added += 1;
    }
    if (added || merged) {
      const dropped = this.db.pruneNotes(this.maxNotes);
      if (dropped) this.log?.info?.(`学习笔记超上限，裁掉 ${dropped} 条`);
    }
    return { added, merged };
  }

  touch(ids) {
    this.db.touchNotes(ids);
    return ids?.length || 0;
  }

  /**
   * renderFor 的语义版：带硬预算（默认 350ms），embedding 慢就直接用字面结果，
   * 保证回话不会因为「翻笔记本」卡住。
   */
  async renderForSmart({ scope = '', context = '', budget = 520, limit = 6, timeBudget = 350 } = {}) {
    if (!this.semanticReady || !clean(context)) return this.renderFor({ scope, context, budget, limit });
    const hits = await Promise.race([
      this.searchSmart(context, { scope, k: limit * 3, timeoutMs: timeBudget }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeBudget)),
    ]);
    if (!hits || !hits.length) return this.renderFor({ scope, context, budget, limit });
    return this.#render(hits, { scope, budget, limit });
  }

  /**
   * 给提示词挑几条：先用 FTS 按当下这句话检索，不够再按权重+新鲜度补。
   * @returns {string} 空串表示没有可用的
   */
  renderFor({ scope = '', context = '', budget = 520, limit = 6 } = {}) {
    const hits = context ? this.search(context, { scope, k: limit * 3 }) : [];
    return this.#render(hits, { scope, budget, limit });
  }

  #render(hits, { scope = '', budget = 520, limit = 6 } = {}) {
    const pickedAll = [];
    const seen = new Set();
    const push = (n) => {
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      pickedAll.push(n);
    };

    for (const n of hits) push(n);
    // 相处经验优先露一条：怎么跟这些人打交道比记住八卦更重要
    const social = this.db
      .allNotes()
      .filter((n) => n.kind === 'social' && (!n.scope || !scope || n.scope === scope))
      .sort((a, b) => (b.weight || 1) - (a.weight || 1));
    if (social.length) push(social[0]);

    if (pickedAll.length < limit) {
      const now = Date.now();
      const rest = this.db
        .allNotes()
        .filter((n) => !n.scope || !scope || n.scope === scope)
        .map((n) => ({ n, s: Math.min(3, n.weight || 1) * 0.8 - Math.min(6, (now - (n.lastSeenAt || 0)) / (7 * 24 * 3600_000)) }))
        .sort((a, b) => b.s - a.s);
      for (const { n } of rest) push(n);
    }

    const lines = [];
    let used = 0;
    const ids = [];
    for (const n of pickedAll) {
      if (lines.length >= limit) break;
      const line = `· ${n.text}`;
      if (used + line.length > budget) break;
      used += line.length + 1;
      lines.push(line);
      ids.push(n.id);
    }
    if (!lines.length) return '';
    this.touch(ids);
    return lines.join('\n');
  }

  top(limit = 12) {
    const now = Date.now();
    return [...this.db.allNotes()]
      .sort((a, b) => (Number(b.weight) || 1) - (Number(a.weight) || 1) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .slice(0, limit)
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        text: n.text,
        tags: n.tags,
        weight: n.weight,
        ageHours: Math.round((now - (n.createdAt || now)) / 3600_000),
      }));
  }

  stats() {
    const base = this.db.stats();
    return {
      total: base.notes,
      byKind: base.byKind,
      messages: base.messages,
      byScope: base.byScope,
      vectors: { notes: this.db.vectorCount('note'), messages: this.db.vectorCount('message') },
      semantic: this.semanticReady,
      lastRunAt: this.load().lastRunAt,
      updatedAt: this.load().updatedAt,
    };
  }
}

/* ------------------------------------------------------------------ 学习器 */

const CHAT_SYSTEM = '你在从群聊里学东西，只输出规定格式，不要寒暄、不要解释。';
const WEB_SYSTEM = '你在把网上的信息压缩成自己用得上的笔记，只输出规定格式，不要寒暄、不要解释。';

const CHAT_ASK = (transcript, isPrivate) =>
  [
    `下面是${isPrivate ? '一段私聊' : '一个 QQ 群'}最近的聊天。你要像人一样从里面「学到点东西」，以后自己说话时用得上。`,
    '',
    '只挑有长期价值的，别复述流水账，别写「有人说」：',
    isPrivate
      ? '- 这个人最近在忙什么/在意什么，他常用的说法、口头禅'
      : '- 群里新冒出来的梗、黑话、外号，以及它们的实际用法\n- 大家最近都在关心/吐槽什么（具体到事，不要「聊了很多」）\n- 这个群的说话习惯：常用词、语气、爱开的玩笑',
    '',
    '输出 2~5 条，一行一条，格式严格为：',
    '一句话（不超过 60 字，必须是能直接复用的经验）|关键词1,关键词2',
    '不需要输出别的，没有可学的就输出「无」。',
    '',
    '聊天记录：',
    transcript,
  ].join('\n');

const WEB_ASK = (material, topic) =>
  [
    topic
      ? `下面是刚在网上搜到的关于「${topic}」的信息。把它变成你以后用得上的笔记。`
      : '下面是今天网上的热点和资讯。把它们变成你以后用得上的笔记。',
    '',
    '只写你真的看懂了、以后聊天或发说说可能用得上的：谁/什么事/为什么会火/梗从哪来。别编，拿不准的别写。',
    '输出 2~4 条，一行一条，格式严格为：',
    '一句话（不超过 60 字）|关键词1,关键词2',
    '没有值得记的就输出「无」。',
    '',
    '素材：',
    material,
  ].join('\n');

const SOCIAL_SYSTEM = '你在观察一个 QQ 群里的人怎么相处，只输出规定格式，不要寒暄。';
const SOCIAL_ASK = (transcript) =>
  [
    '下面是群里最近的一段聊天（每条都标了谁说的）。你要学的不是事实，是「怎么跟这些人相处」。',
    '',
    '重点看：',
    '- 谁跟谁关系铁、爱互怼，互怼到哪一步是玩笑、哪一步会真生气',
    '- 谁容易被开玩笑、谁不能惹；谁说话有分量、谁会起哄',
    '- 这个群的社交规矩：被点名要不要应、插话的时机、刷屏/斗图的规矩、求赞/求红包怎么接',
    '- 谁总在自嘲、谁爱抬杠、谁只潜水偶尔冒一句',
    '',
    '输出 2~5 条，一行一条，格式严格为：',
    '一句话（不超过 70 字，写成以后能直接照着做的经验）|关键词1,关键词2',
    '没有可学的就输出「无」。',
    '',
    '聊天记录：',
    transcript,
  ].join('\n');


export class Learner {
  constructor({
    dataDir = 'data',
    brain = null,
    log,
    book = null,
    scopes = () => [],
    enabled = true,
    everyHours = 6,
    minLines = 20,
    maxRows = 300,
    maxNotes = MAX_NOTES,
    hotLimit = 8,
  } = {}) {
    this.dataDir = dataDir;
    this.brain = brain;
    this.log = log;
    this.book = book || new LearnBook({ dataDir, log, maxNotes });
    this.scopesOf = typeof scopes === 'function' ? scopes : () => scopes || [];
    this.enabled = enabled !== false;
    this.everyHours = Math.max(1, Number(everyHours) || 6);
    this.minLines = Math.max(1, Number(minLines) || 20);
    this.maxRows = Math.max(50, Number(maxRows) || 300);
    this.hotLimit = Math.max(3, Number(hotLimit) || 8);
    this.running = false;
  }

  get due() {
    const st = this.book.load();
    return Date.now() - (st.lastRunAt || 0) >= this.everyHours * 3600_000;
  }

  /** 定时调用：到点了才真的学 */
  async maybeRun({ force = false } = {}) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    if (!force && !this.due) return { ok: false, reason: 'not-due' };
    return this.run({ force });
  }

  /** 完整跑一轮：先学聊天，再学网上 */
  async run({ force = false } = {}) {
    if (this.running) return { ok: false, reason: 'busy' };
    if (!this.enabled && !force) return { ok: false, reason: 'disabled' };
    this.running = true;
    try {
      const chat = await this.learnChats({ force });
      const social = await this.learnSocial({ force });
      const web = await this.learnWeb();
      const st = this.book.load();
      st.lastRunAt = Date.now();
      this.book.save();
      // 新笔记/新原话补上向量，语义检索才有的用（失败不影响主流程）
      const vec = await this.book.embedPending({ limit: 400 });
      const out = { ok: true, chat, social, web, vec, total: this.book.notes.length };
      this.log?.info?.(`学习完成：聊天 +${chat.added}、相处 +${social.added}、网上 +${web.added}（累计 ${out.total} 条）`);
      return out;
    } catch (err) {
      this.log?.warn?.(`学习失败：${err.message}`);
      return { ok: false, reason: 'error', error: err.message };
    } finally {
      this.running = false;
    }
  }

  #historyFile(scope) {
    return path.join(this.dataDir, 'history', `${String(scope).replace(':', '_')}.jsonl`);
  }

  /** 把某个会话的历史全部读出来（回填用，不分页） */
  rowsAll(scope) {
    const file = this.#historyFile(scope);
    if (!fs.existsSync(file)) return [];
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.text) rows.push(row);
      } catch {
        /* 坏行跳过 */
      }
    }
    return rows;
  }

  /** 读某个会话在 since 之后的聊天（同步粗读，够用） */
  rowsSince(scope, since = 0, maxRows = this.maxRows) {
    const file = this.#historyFile(scope);
    if (!fs.existsSync(file)) return [];
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row?.text) continue;
        if ((Number(row.ts) || 0) > since) rows.push(row);
      } catch {
        /* 坏行跳过 */
      }
    }
    return rows.slice(-maxRows);
  }

  async learnChats({ force = false } = {}) {
    const st = this.book.load();
    const total = { added: 0, merged: 0, scopes: 0 };
    for (const scope of this.scopesOf() || []) {
      if (!scope) continue;
      const since = Number(st.lastChat?.[scope]) || 0;
      const rows = this.rowsSince(scope, since);
      if (rows.length) this.book.ingest(scope, rows); // 原话先落库，供以后按需翻
      if (rows.length < (force ? 5 : this.minLines)) continue;
      const isPrivate = String(scope).startsWith('private:');
      const transcript = rows
        .filter((r) => r.text && !/^\[(画了一张图|发了一张图)/.test(r.text))
        .map((r) => `${r.role === 'bot' ? `我(${r.name || '哈基米'})` : r.name || '群友'}: ${String(r.text).slice(0, 120)}`)
        .join('\n');
      if (!transcript.trim()) continue;
      const raw = await this.brain?.complete({
        system: CHAT_SYSTEM,
        prompt: CHAT_ASK(transcript, isPrivate),
        maxChars: 0,
        purpose: 'background',
      }).catch((err) => {
        this.log?.warn?.(`学聊天失败（${scope}）：${err.message}`);
        return '';
      });
      const notes = parseNotes(raw);
      if (notes.length) {
        const res = this.book.addMany(notes, { kind: 'chat', scope });
        total.added += res.added;
        total.merged += res.merged;
      }
      // 学到了哪里记下来：不管这轮有没有产出，都推进游标，免得同一段反复喂
      st.lastChat[scope] = Number(rows[rows.length - 1].ts) || Date.now();
      this.book.save();
      total.scopes += 1;
      if (notes.length) this.log?.info?.(`从 ${scope} 学到 ${notes.length} 条（新增 ${total.added}）`);
    }
    return total;
  }

  /** 网上这批：头条热榜 + 最近推过的资讯 */
  #webMaterial() {
    const bits = [];
    const newsLog = path.join(this.dataDir, 'daily-news-log.jsonl');
    if (fs.existsSync(newsLog)) {
      const lines = fs.readFileSync(newsLog, 'utf8').split('\n').filter(Boolean).slice(-40);
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          const title = row?.title || row?.item?.title;
          if (title) bits.push(`资讯：${String(title).slice(0, 80)}`);
        } catch {
          /* 坏行 */
        }
      }
    }
    return bits.slice(-20);
  }

  async learnWeb({ force = false } = {}) {
    const total = { added: 0, merged: 0 };
    let hot = [];
    try {
      hot = await toutiaoHot({ limit: this.hotLimit });
    } catch (err) {
      this.log?.debug?.(`热榜没取到：${err.message}`);
    }
    const material = [
      ...hot.map((h) => `热榜：${String(h.title || h.name || '').slice(0, 80)}`),
      ...this.#webMaterial(),
    ]
      .filter(Boolean)
      .join('\n');
    if (!material.trim()) return total;
    const raw = await this.brain?.complete({
      system: WEB_SYSTEM,
      prompt: WEB_ASK(material),
      maxChars: 0,
      purpose: 'background',
    }).catch((err) => {
      this.log?.warn?.(`学网上信息失败：${err.message}`);
      return '';
    });
    const notes = parseNotes(raw);
    if (notes.length) {
      const res = this.book.addMany(notes, { kind: 'web', scope: '' });
      Object.assign(total, res);
      this.log?.info?.(`网上学到 ${notes.length} 条（新增 ${total.added}）`);
    }
    return total;
  }


  /** 学「怎么跟这些人相处」：谁跟谁互怼、谁能开玩笑、群里的规矩 */
  async learnSocial({ force = false } = {}) {
    const st = this.book.load();
    const total = { added: 0, merged: 0, scopes: 0 };
    for (const scope of this.scopesOf() || []) {
      if (!scope) continue;
      const since = Number(st.lastSocial?.[scope]) || 0;
      const rows = this.rowsSince(scope, since, Math.max(this.maxRows, 400));
      if (rows.length < (force ? 10 : 40)) continue;
      const transcript = rows
        .filter((r) => r.text && !/^\[(画了一张图|发了一张图)/.test(r.text))
        .map((r) => `${r.role === 'bot' ? `我(${r.name || '哈基米'})` : r.name || '群友'}: ${String(r.text).slice(0, 120)}`)
        .join('\n');
      if (!transcript.trim()) continue;
      const raw = await this.brain?.complete({
        system: SOCIAL_SYSTEM,
        prompt: SOCIAL_ASK(transcript),
        maxChars: 0,
        purpose: 'background',
      }).catch((err) => {
        this.log?.warn?.(`学相处失败（${scope}）：${err.message}`);
        return '';
      });
      const notes = parseNotes(raw);
      if (notes.length) {
        const res = this.book.addMany(notes, { kind: 'social', scope });
        total.added += res.added;
        total.merged += res.merged;
      }
      st.lastSocial = st.lastSocial || {};
      st.lastSocial[scope] = Number(rows[rows.length - 1].ts) || Date.now();
      this.book.save();
      total.scopes += 1;
      if (notes.length) this.log?.info?.(`从 ${scope} 学到 ${notes.length} 条相处经验`);
    }
    return total;
  }

  /**
   * 回填：把历史聊天全部灌进库里；distill 时再分段蒸馏成笔记。
   * 不蒸馏只入库是纯本地操作，不花模型钱。
   */
  async backfill({ distill = false, chunk = 150, log } = {}) {
    const out = { scopes: 0, messages: 0, notes: 0, merged: 0, calls: 0 };
    for (const scope of this.scopesOf() || []) {
      if (!scope) continue;
      const rows = this.rowsAll(scope);
      if (!rows.length) continue;
      out.messages += this.book.ingest(scope, rows);
      out.scopes += 1;
      if (!distill) continue;
      const isPrivate = String(scope).startsWith('private:');
      for (let i = 0; i < rows.length; i += chunk) {
        const part = rows.slice(i, i + chunk);
        const transcript = part
          .filter((r) => r.text && !/^\[(画了一张图|发了一张图)/.test(r.text))
          .map((r) => `${r.role === 'bot' ? `我(${r.name || '哈基米'})` : r.name || '群友'}: ${String(r.text).slice(0, 120)}`)
          .join('\n');
        if (!transcript.trim()) continue;
        out.calls += 1;
        const raw = await this.brain?.complete({
          system: CHAT_SYSTEM,
          prompt: CHAT_ASK(transcript, isPrivate),
          maxChars: 0,
          purpose: 'background',
        }).catch((err) => {
          this.log?.warn?.(`回填蒸馏失败（${scope} 第 ${i} 行起）：${err.message}`);
          return '';
        });
        const notes = parseNotes(raw);
        if (notes.length) {
          const res = this.book.addMany(notes, { kind: 'chat', scope });
          out.notes += res.added;
          out.merged += res.merged;
        }
        log?.(`${scope} 回填进度 ${Math.min(i + chunk, rows.length)}/${rows.length}`);
      }
      const st = this.book.load();
      st.lastChat[scope] = Number(rows[rows.length - 1].ts) || Date.now();
      this.book.save();
    }
    const vec = await this.book.embedPending({ limit: 600 });
    out.vec = vec;
    this.log?.info?.(`回填入库 ${out.messages} 条原话（${out.scopes} 个会话），蒸馏新增 ${out.notes} 条笔记`);
    return out;
  }

  /** 现学一个话题（agent 的 study 工具用） */
  async learnTopic(topic, { limit = 6 } = {}) {
    const q = clean(topic).slice(0, 40);
    if ([...q].length < 2) return { ok: false, reason: 'empty-topic' };
    let items = [];
    try {
      items = await searchWeb(q, { limit });
    } catch (err) {
      this.log?.warn?.(`搜「${q}」失败：${err.message}`);
    }
    if (!items.length) return { ok: false, reason: 'no-result', topic: q };
    const material = items
      .map((it) => `${String(it.title || '').slice(0, 80)}：${String(it.desc || it.description || it.snippet || '').slice(0, 120)}`)
      .join('\n');
    const raw = await this.brain?.complete({
      system: WEB_SYSTEM,
      prompt: WEB_ASK(material, q),
      maxChars: 0,
      purpose: 'background',
    }).catch(() => '');
    const notes = parseNotes(raw);
    const res = notes.length ? this.book.addMany(notes, { kind: 'web', scope: '' }) : { added: 0, merged: 0 };
    return { ok: true, topic: q, found: items.length, learned: notes.length, ...res };
  }
}
