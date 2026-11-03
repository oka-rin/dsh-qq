import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './util.mjs';
import { searchHistory } from './archive.mjs';

/**
 * 群记忆：把归档里的流水压缩成「我记住的事」。
 *
 * 归档是逐条流水（永远都在），这份是它的摘要索引——每次主动开口前只看摘要，
 * 想不起细节再用 search_history 回去翻原文。这样既有跨天记忆，又不用把几万条塞进上下文。
 *
 * 存储：data/memory/group_10000003.json
 * {
 *   scope, updatedAt, coveredUntilTs, coveredLines,
 *   summary: "一段总述",
 *   facts: ["短句", ...]        // 最新的在后面
 * }
 */
export class ScopeMemory {
  constructor({ dataDir, brain, log, everyHours = 12, minNewLines = 30, maxFacts = 40 }) {
    this.dataDir = dataDir;
    this.brain = brain;
    this.log = log;
    this.everyHours = everyHours;
    this.minNewLines = minNewLines;
    this.maxFacts = maxFacts;
    this.dir = ensureDir(path.join(dataDir, 'memory'));
    this.cache = new Map(); // scope -> mem（避免每条消息都读盘）
  }

  #file(scope) {
    return path.join(this.dir, `${String(scope).replace(':', '_')}.json`);
  }

  load(scope) {
    if (this.cache.has(scope)) return this.cache.get(scope);
    const mem = readJson(this.#file(scope), null);
    this.cache.set(scope, mem);
    return mem;
  }

  save(scope, mem) {
    writeJsonAtomic(this.#file(scope), mem);
    this.cache.set(scope, mem);
    return mem;
  }

  list() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(path.join(this.dir, f), null))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 给提示词用的一段文字；没记忆时返回空串 */
  render(scope) {
    const mem = this.load(scope);
    if (!mem || (!mem.summary && !mem.facts?.length)) return '';
    const when = mem.updatedAt ? new Date(mem.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
    const isPrivate = String(scope).startsWith('private:');
    const lines = [`你记得${isPrivate ? '跟这个人的私聊' : '这个群'}之前的事（整理于 ${when}，覆盖 ${mem.coveredLines || 0} 条消息）：`];
    if (mem.summary) lines.push(`总述：${mem.summary}`);
    for (const f of mem.facts || []) lines.push(`- ${f}`);
    return lines.join('\n');
  }

  /** 是否该整理了 */
  shouldRefresh(scope, { force = false } = {}) {
    if (force) return true;
    const mem = this.load(scope);
    const since = mem?.coveredUntilTs ?? 0;
    const rows = this.#rowsSince(scope, since);
    if (rows.length < this.minNewLines) return false;
    if (!mem) return true;
    return Date.now() - (mem.updatedAt || 0) >= this.everyHours * 3600_000 || rows.length >= this.minNewLines * 3;
  }

  #rowsSince(scope, since) {
    // searchHistory 是 async，但这里只用来判断条数，改用同步粗读
    const file = path.join(this.dataDir, 'history', `${String(scope).replace(':', '_')}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if ((row.ts || 0) > since) rows.push(row);
      } catch {
        /* 跳过坏行 */
      }
    }
    return rows;
  }

  /**
   * 把 since 之后的新消息压缩进记忆。
   * @returns {Promise<{ok:boolean, reason?:string, facts?:string[], summary?:string}>}
   */
  async refresh(scope, { force = false, maxRows = 400 } = {}) {
    if (!force && !this.shouldRefresh(scope)) return { ok: false, reason: 'not-due' };
    const mem = this.load(scope);
    const since = mem?.coveredUntilTs ?? 0;
    const rows = this.#rowsSince(scope, since).slice(-maxRows);
    if (!rows.length) return { ok: false, reason: 'no-new-rows' };

    const transcript = rows
      .map((r) => {
        const who = r.role === 'bot' ? `我(${r.name || '哈基米'})` : r.name || '群友';
        const t = new Date(r.ts || 0).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `${t} ${who}: ${r.text}`;
      })
      .join('\n');

    const isPrivate = String(scope).startsWith('private:');
    const where = isPrivate ? '这是一对一私聊（不是群聊）' : '这是一个群';
    const ask = [
      `下面是${where}最近发生的一段聊天。请你以「我」的第一人称，把值得记住的东西整理成记忆。`,
      '',
      '要求：',
      '- 输出 4~8 条短句，每条不超过 40 字，一行一条，用「- 」开头',
      isPrivate
        ? '- 只记真的值得记的：对方是个什么样的人、他关心什么、我们聊过什么、他托付过什么、我们之间有没有约定或梗'
        : '- 只记真的值得记的：群里的人在聊什么/关心什么、谁是谁（外号或特点）、我问过或答应过什么、踩过的雷、重复出现的话题',
      isPrivate ? '- 这是私聊，别写「群里」「群友」这种词，直接说「他」或名字' : '- 不要复述具体哪句话，不要写「有人说」这种废话，不要写时间和流水账',
      '- 不要复述具体哪句话，不要写「有人说」这种废话，不要写时间和流水账',
      '- 第一行单独写一句总述（不超过 50 字），格式：总述：xxx',
      '- 不要输出别的解释',
      '',
      '聊天记录：',
      transcript,
    ].join('\n');

    const text = await this.brain
      .complete({ system: '你在整理聊天记忆，只输出规定格式的内容，不要寒暄不要解释。', prompt: ask, maxChars: 1200 })
      .catch((err) => {
        this.log?.warn?.(`整理记忆失败：${err.message}`);
        return '';
      });
    if (!text) return { ok: false, reason: 'model-failed' };
    let summary = '';
    const facts = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^总述[:：]\s*(.+)$/.exec(line);
      if (m) {
        summary = m[1].trim();
        continue;
      }
      const f = /^[-*·]\s*(.+)$/.exec(line);
      if (f) facts.push(f[1].trim());
      else if (!summary && !facts.length && line.length <= 80) summary = line;
    }
    if (!facts.length && !summary) return { ok: false, reason: 'unparsable', raw: text.slice(0, 300) };

    const merged = [...(mem?.facts || []), ...facts].slice(-this.maxFacts);
    const next = {
      scope,
      updatedAt: Date.now(),
      coveredUntilTs: rows[rows.length - 1].ts || Date.now(),
      coveredLines: (mem?.coveredLines || 0) + rows.length,
      summary: summary || mem?.summary || '',
      facts: merged,
    };
    this.save(scope, next);
    this.log?.info?.(`${scope} 记忆已更新：${facts.length} 条新事实（累计 ${merged.length} 条，覆盖 ${next.coveredLines} 条消息）`);
    return { ok: true, facts, summary: next.summary, covered: next.coveredUntilTs };
  }
}
