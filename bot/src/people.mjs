// 人物画像：认识群里和它说话的人
//
// 每个 QQ 号一个文件：data/people/<uin>.json
//   { uin, names[], firstSeen, lastSeen, msgs, learnedAt, learnings, summary, facts[], style, tags[], pending[] }
//
// 机制：来一条消息就记一笔（pending 里留最近原文），攒够 everyMessages 条、
// 且距上次学习超过 minGapMs，就让模型读这些原文，总结「这人是干嘛的 / 关心什么 /
// 说话什么调 / 跟我的关系 / 值得记住的事」，写成 summary + facts。
// 之后每次回复或主动说话，把在场几个人的画像塞进上下文，它就知道在跟谁讲话。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { createLogger } from './util.mjs';

const MAX_PENDING = 120;
// 事实不设上限：一条都不丢（用户要求「保留所有记忆点」）。注入时按当下对话挑几条，
// 剩下的留在硬盘上，想不起来的时候用 recall_person 工具现查。
const MAX_NOTES = 400;
const MAX_ROSTER_CHARS = 1400;

export class PeopleBook {
  constructor({ dataDir = 'data', brain = null, log = createLogger('people'), everyMessages = 10, minGapMs = 3 * 3600_000 } = {}) {
    this.dir = path.resolve(dataDir, 'people');
    this.brain = brain;
    this.log = log;
    this.everyMessages = everyMessages;
    this.minGapMs = minGapMs;
    this.cache = new Map();
    this.busy = new Set();
  }

  #listCache = null;

  /** 名册/找人用：读全量画像（10 秒内缓存一次，别每条消息都扫盘） */
  listCached(ttl = 10000) {
    if (this.#listCache && Date.now() - this.#listCache.at < ttl) return this.#listCache.rows;
    const rows = this.list();
    this.#listCache = { at: Date.now(), rows };
    return rows;
  }

  static key(uin) {
    return String(uin || '').replace(/[^\d]/g, '') || 'unknown';
  }

  #file(uin) {
    return path.join(this.dir, `${PeopleBook.key(uin)}.json`);
  }

  read(uin) {
    const key = PeopleBook.key(uin);
    if (this.cache.has(key)) return this.cache.get(key);
    let data = null;
    try {
      const raw = fs.readFileSync(this.#file(key), 'utf8');
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (!data) {
      data = {
        uin: key,
        names: [],
        firstSeen: Date.now(),
        lastSeen: 0,
        msgs: 0,
        learnedAt: 0,
        learnings: 0,
        summary: '',
        facts: [],
        style: '',
        tags: [],
        pending: [],
      };
    }
    this.cache.set(key, data);
    return data;
  }

  #write(uin, data) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.#file(uin), JSON.stringify(data, null, 2) + '\n', 'utf8');
      this.cache.set(PeopleBook.key(uin), data);
      this.#listCache = null;
    } catch (err) {
      this.log.warn(`存人物画像失败：${err.message}`);
    }
  }

  /** 记下这个人说过的一句话（只记文字，别的都丢掉） */
  note({ uin, name, text, at = Date.now(), scope = '' }) {
    const key = PeopleBook.key(uin);
    if (!key || key === 'unknown') return null;
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 1) return null;
    const data = this.read(key);
    const old = this.cache.get(key);
    if (!old) this.cache.set(key, data);

    data.msgs += 1;
    data.lastSeen = Math.max(data.lastSeen || 0, at);
    if (name && !data.names.includes(name)) {
      data.names = [name, ...data.names].slice(0, 6);
    }
    data.pending = [...(data.pending || []), { at, text: clean.slice(0, 160), scope }].slice(-MAX_PENDING);
    // 上次学完之后又说了几句（决定要不要再学，跟 pending 池子大小无关）
    data.sinceLearn = (data.sinceLearn || 0) + 1;

    // 落盘别每条都写：每 5 条写一次，或者第一次见面立刻写
    if (data.msgs <= 1 || data.msgs % 5 === 0) this.#write(key, data);
    else this.cache.set(key, data);
    return data;
  }

  /** 够不够格去「学」一次 */
  shouldLearn(uin, { force = false } = {}) {
    const data = this.read(uin);
    if (force) return true;
    const fresh = data.sinceLearn ?? (data.pending || []).length;
    if (fresh < this.everyMessages) return false;
    if (Date.now() - (data.learnedAt || 0) < this.minGapMs) return false;
    return true;
  }

  /** 让模型读这个人的话，总结出画像 */
  async learn(uin, { force = false } = {}) {
    const key = PeopleBook.key(uin);
    if (!this.brain?.complete) return { ok: false, reason: 'no-brain' };
    if (this.busy.has(key)) return { ok: false, reason: 'busy' };
    if (!this.shouldLearn(key, { force })) return { ok: false, reason: 'not-enough' };

    const data = this.read(key);
    const rows = (data.pending || []).slice(-MAX_PENDING);
    if (rows.length < 3) return { ok: false, reason: 'not-enough' };
    const knownFacts = (data.facts || []).slice(0, 12);
    const knownBlock = [
      data.summary ? `总述：${data.summary}` : '',
      data.style ? `印象：${data.style}` : '',
      ...knownFacts.map((f) => `- ${f}`),
    ].filter(Boolean).join('\n') || '（还没有）';

    this.busy.add(key);
    try {
      const sample = rows.map((r) => `- ${r.text}`).join('\n');
      const text = await this.brain.complete({
        system: '你是一个观察者，任务是从聊天记录里给一个人建立档案。只根据给出的原话推断，别编造，拿不准就不写。',
        prompt: `下面是 ${data.names[0] || '这个人'}（QQ ${key}）在群里说过的一些话，共 ${rows.length} 条：

${sample}

你以前给他建过的档案（**旧信息没被推翻就必须保留**，别因为这次没提到就删掉）：
${knownBlock}

请据此更新档案，格式严格如下（不要别的内容）：
总述：一句话说清这人是谁、在干嘛、这段时间在意什么（不超过 60 字，旧总述里对的地方要留着，只改过时的）
印象：一句话说他的说话风格（比如爱阴阳、话少、爱玩梗）
- 一条具体事实（比如「在准备考研」「养了只布偶猫」「经常半夜打游戏」）
- 再写这次**新发现或需要修正**的事实，最多 6 条，每条不超过 30 字，只写有依据的
- 以前记过、这次又提到的事别重复写
`,
        maxChars: 700,
      });
      const parsed = PeopleBook.parseProfile(text);
      if (!parsed.summary && !parsed.facts.length) return { ok: false, reason: 'parse-empty' };

      const next = this.read(key);
      const before = { summary: next.summary || '', facts: [...(next.facts || [])] };
      next.summary = parsed.summary || next.summary;
      next.style = parsed.style || next.style;
      // 全部留着，不截断：宁可文件大一点，也不能忘了前面记过的事
      const merged = PeopleBook.mergeFacts(parsed.facts, next.facts || []);
      next.facts = merged;
      // 每次学习的档案快照也写进 notes：硬盘上一条都不丢
      next.notes = [
        ...(next.notes || []),
        { at: Date.now(), summary: next.summary, added: parsed.facts.filter((f) => !before.facts.includes(f)) },
      ].slice(-MAX_NOTES);
      next.learnedAt = Date.now();
      next.learnings = (next.learnings || 0) + 1;
      next.pending = rows.slice(-20); // 留一点最近的话，剩下的丢掉
      next.sinceLearn = 0;
      this.#write(key, next);
      this.log.info(`人物画像更新：${next.names[0] || key}（${parsed.facts.length} 条事实）`);
      return { ok: true, uin: key, name: next.names[0], summary: next.summary, facts: next.facts };
    } catch (err) {
      this.log.warn(`学习画像失败（${key}）：${err.message}`);
      return { ok: false, reason: err.message };
    } finally {
      this.busy.delete(key);
    }
  }

  /** 新事实在前、旧事实在后，去掉重复/被包含/高度重合的（「养了只布偶猫」和「养了布偶猫」算一条） */
  static mergeFacts(fresh = [], old = []) {
    const norm = (x) => String(x || '').replace(/[\s，。、！？,.!?「」“”"'']/g, '').toLowerCase();
    const out = [];
    for (const f of [...fresh, ...old]) {
      const n = norm(f);
      if (!n) continue;
      const dup = out.some((g) => {
        const m = norm(g);
        return m === n || m.includes(n) || n.includes(m) || PeopleBook.factSimilar(g, f) >= 0.5;
      });
      if (dup) continue;
      out.push(String(f).trim());
    }
    return out;
  }

  /** 两条事实的 2-gram Jaccard 相似度（0~1） */
  static factSimilar(a, b) {
    const grams = (t) => {
      const s = String(t || '').replace(/[\s\p{P}]/gu, '');
      const set = new Set();
      for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
      return set;
    };
    const A = grams(a);
    const B = grams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter += 1;
    return inter / (A.size + B.size - inter);
  }

  static parseProfile(text) {
    const out = { summary: '', style: '', facts: [] };
    for (const line of String(text || '').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^总述[:：]/.test(t)) out.summary = t.replace(/^总述[:：]\s*/, '').slice(0, 120);
      else if (/^印象[:：]/.test(t)) out.style = t.replace(/^印象[:：]\s*/, '').slice(0, 80);
      else if (/^[-·*]\s*/.test(t)) out.facts.push(t.replace(/^[-·*]\s*/, '').slice(0, 60));
    }
    return out;
  }

  /** 给提示词用的一段话；没画像就返回空串 */
  render(uin, { maxFacts = 6, preferName = '', context = '' } = {}) {
    const data = this.read(uin);
    const names = Array.isArray(data.names) ? data.names.filter(Boolean) : [];
    // 用「此刻群里显示的那个名字」当主名：同一人换过名片/昵称时，画像不能跟对话里的名字对不上
    const latest = names[names.length - 1];
    const name = preferName || latest || data.uin;
    const aliases = names.filter((n) => n && n !== name);
    const nameLine = aliases.length ? `${name}（也叫 ${aliases.join('、')}）` : name;
    const bits = [];
    if (data.summary) {
      const days = data.learnedAt ? Math.floor((Date.now() - Number(data.learnedAt)) / 86400000) : 0;
      // 画像会过时：标一句「多旧」，免得模型把三天前的状态当成现在
      const stale = days >= 3 ? `（这份印象是 ${days} 天前的，可能已经变了）` : '';
      bits.push(`${data.summary}${stale}`);
    }
    if (data.style) bits.push(`说话风格：${data.style}`);
    // 事实攒到几十条了，按当下这句话挑最相关的几条（挑剩下的也还在硬盘上）
    const all = data.facts || [];
    const facts = context ? PeopleBook.rankFacts(all, context).slice(0, maxFacts) : all.slice(0, maxFacts);
    if (facts.length) bits.push(facts.map((f) => `· ${f}`).join('\n'));
    if (!bits.length) {
      // 还没学过，但至少让他知道这人叫什么、说过多少话
      if (!data.msgs) return '';
      return `${nameLine}（QQ ${data.uin}）：已经跟你聊过 ${data.msgs} 次，你对他还不太熟。`;
    }
    return `${nameLine}（QQ ${data.uin}）：\n${bits.join('\n')}`;
  }

  /** 按和这一句的 2-gram 重合度排事实；一样相关就按新到旧 */
  static rankFacts(facts = [], context = '') {
    const grams = (t) => {
      const s = String(t || '').replace(/[\s\p{P}]/gu, '');
      const out = new Set();
      for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
      return out;
    };
    const ctx = grams(context);
    return facts
      .map((f, i) => {
        const g = grams(f);
        let hit = 0;
        for (const x of g) if (ctx.has(x)) hit += 1;
        return { f, i, hit };
      })
      .sort((a, b) => (b.hit - a.hit) || (a.i - b.i))
      .map((x) => x.f);
  }

  /**
   * 名册：认识的所有人，一人一行（名字 · 聊过多少 · 一句话）。
   * 人再多也不至于「忘了前面认识谁」——预算内全列，超了按 聊得多 + 最近说过话 排序。
   */
  renderRoster({ budget = MAX_ROSTER_CHARS, exclude = [] } = {}) {
    const skip = new Set((exclude || []).map((u) => PeopleBook.key(u)));
    const now = Date.now();
    const rows = this.listCached()
      .filter((p) => p && p.uin && !skip.has(String(p.uin)))
      .filter((p) => p.summary || p.style || (p.facts || []).length || p.msgs)
      .map((p) => {
        const days = p.lastSeen ? Math.floor((now - p.lastSeen) / 86400000) : 999;
        const score = (p.msgs || 0) + Math.max(0, 30 - Math.min(30, days)) + (p.learnings || 0) * 2;
        const names = (p.names || []).filter(Boolean);
        const name = names[names.length - 1] || '';
        const who = name && name !== p.uin ? `${name}（QQ ${p.uin}）` : `QQ ${p.uin}`;
        const one = (p.summary || (p.facts || [])[0] || p.style || '').replace(/\s+/g, ' ').slice(0, 40);
        return { p, score, line: `${who} · 聊过 ${p.msgs || 0} 次${one ? ` · ${one}` : ''}` };
      })
      .sort((a, b) => b.score - a.score);
    const lines = [];
    let used = 0;
    for (const r of rows) {
      if (used + r.line.length + 1 > budget) break;
      lines.push(r.line);
      used += r.line.length + 1;
    }
    const rest = rows.length - lines.length;
    const tail = rest > 0 ? `（还有 ${rest} 个认识的人没列出来，硬盘上都存着）` : '';
    return { text: lines.join('\n'), total: rows.length, shown: lines.length, rest, tail };
  }

  /** 这句话里提到了谁（不在场的老熟人也能被想起来） */
  findByName(text, { limit = 3, exclude = [] } = {}) {
    const hay = String(text || '');
    if (!hay) return [];
    const skip = new Set((exclude || []).map((u) => PeopleBook.key(u)));
    const hits = [];
    for (const p of this.listCached()) {
      const key = String(p.uin);
      if (skip.has(key)) continue;
      const names = (p.names || []).filter(Boolean);
      const name = names.find((n) => n.length >= 2 && hay.includes(n));
      if (name) hits.push({ uin: key, name, score: (p.msgs || 0) + name.length });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * 查档案：按名字 / QQ 号 / 关键词（能搜到事实与总述里的话）。
   * 名册装不下的人、或者想不起来某个细节时用它——硬盘上记着的都能翻出来。
   */
  lookup(query, { limit = 3 } = {}) {
    const q = String(query || '').trim().replace(/^@/, '');
    if (!q) return [];
    const digits = q.replace(/[^\d]/g, '');
    const scored = [];
    for (const p of this.listCached()) {
      const key = String(p.uin);
      const names = (p.names || []).filter(Boolean);
      const facts = p.facts || [];
      let score = 0;
      let hitFacts = [];
      if (digits && digits === key) score += 100;
      for (const n of names) {
        if (n === q) score += 60;
        else if (q.includes(n) && n.length >= 2) score += 30 + n.length;
        else if (n.includes(q) && q.length >= 2) score += 20;
      }
      if (q.length >= 2) {
        if ((p.summary || '').includes(q)) score += 25;
        if ((p.style || '').includes(q)) score += 10;
        hitFacts = facts.filter((f) => String(f).includes(q) || PeopleBook.factSimilar(f, q) >= 0.34);
        score += Math.min(24, hitFacts.length * 8);
      }
      if (score > 0) scored.push({ p, score, hitFacts });
    }
    return scored
      .sort((a, b) => (b.score - a.score) || ((b.p.msgs || 0) - (a.p.msgs || 0)))
      .slice(0, limit)
      .map(({ p, hitFacts }) => ({
        uin: String(p.uin),
        name: (p.names || []).filter(Boolean).pop() || '',
        names: (p.names || []).filter(Boolean),
        summary: p.summary || '',
        style: p.style || '',
        msgs: p.msgs || 0,
        learnings: p.learnings || 0,
        lastSeen: p.lastSeen || 0,
        facts: hitFacts.length
          ? [...hitFacts, ...(p.facts || []).filter((f) => !hitFacts.includes(f))]
          : (p.facts || []),
      }));
  }

  /** 把一个人的完整档案排成一段话（工具返回给模型看；命中事实排在最前） */
  renderFull(uin, { maxFacts = 30 } = {}) {
    const data = this.read(uin);
    const names = (data.names || []).filter(Boolean);
    const name = names[names.length - 1] || data.uin;
    const bits = [];
    if (data.summary) bits.push(`总述：${data.summary}`);
    if (data.style) bits.push(`说话风格：${data.style}`);
    const facts = data.facts || [];
    if (facts.length) {
      bits.push(`记下的事共 ${facts.length} 条，这里是前 ${Math.min(maxFacts, facts.length)} 条：\n${facts.slice(0, maxFacts).map((f) => `- ${f}`).join('\n')}`);
    }
    if (!bits.length) return `${name}（QQ ${data.uin}）：还没学到什么，只记下聊过 ${data.msgs || 0} 次。`;
    return `${name}（QQ ${data.uin}）· 聊过 ${data.msgs || 0} 次 · 学过 ${data.learnings || 0} 次\n${bits.join('\n')}`;
  }

  /**
   * 拼给模型看的「认识的人」三段：名册全量 / 在场的人详细 / 话里提到的老熟人。
   * present=在场的人，nameOf=他们此刻的显示名，said=这一句，recent=最近几轮的话。
   */
  composeFor({ present = [], nameOf = new Map(), said = '', recent = '', rosterChars = MAX_ROSTER_CHARS, maxFacts = 6 } = {}) {
    const presentUins = [...new Set((present || []).map((u) => PeopleBook.key(u)).filter((k) => k && k !== 'unknown'))];
    const context = `${said} ${recent}`.trim();
    const sections = [];
    const roster = this.renderRoster({ exclude: presentUins, budget: rosterChars });
    if (roster.text) sections.push(`【名册·你认识的所有人】\n${roster.text}${roster.rest ? `\n${roster.tail}` : ''}`);
    const detail = presentUins
      .map((u) => this.render(u, { maxFacts, preferName: nameOf.get(u) || '', context }))
      .filter(Boolean)
      .join('\n\n');
    if (detail) sections.push(`【现在就这几个人在说话】\n${detail}`);
    const mentioned = this.findByName(said, { exclude: presentUins });
    if (mentioned.length) {
      const text = mentioned
        .map((m) => this.render(m.uin, { maxFacts: 4, preferName: m.name, context }))
        .filter(Boolean)
        .join('\n\n');
      if (text) sections.push(`【这话里提到的、不在场的人】\n${text}`);
    }
    return sections.join('\n\n');
  }

  /** 一次给好几个人，去掉重复的 */
  renderMany(uins, opts) {
    const seen = new Set();
    const parts = [];
    for (const uin of uins || []) {
      const key = PeopleBook.key(uin);
      if (!key || key === 'unknown' || seen.has(key)) continue;
      seen.add(key);
      const text = this.render(key, opts);
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }

  list() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    } catch {
      return [];
    }
  }

  /** 把硬盘上已有的聊天记录倒进来（role=user 的每一条都是某个人说过的原话） */
  async backfill(dataDir) {
    const dir = path.resolve(dataDir, 'history');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /\.jsonl(\.gz)?$/.test(f));
    } catch {
      return { rows: 0, people: 0 };
    }
    let rows = 0;
    for (const f of files) {
      const file = path.join(dir, f);
      const stream = fs.createReadStream(file);
      const input = f.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream;
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row.role === 'bot' || !row.userId) continue;
        this.note({ uin: row.userId, name: row.name, text: row.text, at: row.ts || row.at, scope: row.scope });
        rows += 1;
      }
    }
    // 全部落盘（note 里是每 5 条写一次）
    for (const p of this.list()) this.#write(p.uin, p);
    return { rows, people: this.list().length };
  }

  /** 顺手把攒够的人学一遍（定时或每条消息后调用都行，内部有门槛） */
  async sweep(limit = 2) {
    let done = 0;
    for (const p of this.list()) {
      if (done >= limit) break;
      if (!this.shouldLearn(p.uin)) continue;
      const r = await this.learn(p.uin).catch(() => ({ ok: false }));
      if (r?.ok) done += 1;
    }
    return done;
  }
}
