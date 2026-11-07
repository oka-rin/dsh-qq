/**
 * 人格自微调：蒸馏学完之后，允许它往自己身上加一两条「说话习惯 / 行为规矩」。
 *
 * 边界（代码硬拦，不靠模型自觉）：
 *   - 只追加，不重写；名字、身份不碰。
 *   - 有完整 systemPrompt 时追加在末尾的「自己后来悟到的」小节里，否则追加到 style / rules。
 *   - 每次最多 1 条 style + 1 条 rule，各 ≤ 60 字；24 小时最多改一次。
 *   - 追加后总长度有上限；全部改动留历史，可逐条撤销。
 *
 * 存储：<dataDir>/persona-evolve.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './util.mjs';

const SENSITIVE = /(?:习近平|政治局|共产党|六四|法轮|台独|港独|色情|裸聊|约炮|赌博|博彩|毒品|冰毒|自杀|血腥|枪支|炸弹)/i;
const BAD = /(?:忽略(?:之前|以上)|系统提示|越狱|developer mode|jailbreak)/i;
const MAX_ADD = 60;
const MAX_PROMPT = 6000;
const MAX_STYLE = 1200;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const clip = (v, n) => [...clean(v)].slice(0, n).join('');

export class PersonaEvolver {
  constructor({ dataDir = 'data', brain = null, getPersona, setPersona, log = createLogger('persona-evolve'), enabled = true, minGapMs = 24 * 3600_000 } = {}) {
    this.dataDir = dataDir;
    this.brain = brain;
    this.getPersona = typeof getPersona === 'function' ? getPersona : () => ({});
    this.setPersona = typeof setPersona === 'function' ? setPersona : null;
    this.log = log;
    this.enabled = enabled !== false;
    this.minGapMs = Math.max(3600_000, Number(minGapMs) || 24 * 3600_000);
    this.file = path.join(dataDir, 'persona-evolve.json');
    this.state = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { lastAt: Number(raw.lastAt) || 0, history: Array.isArray(raw.history) ? raw.history : [] };
    } catch {
      return { lastAt: 0, history: [] };
    }
  }

  #save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ lastAt: this.state.lastAt, history: this.state.history.slice(-30) }, null, 2));
    } catch (err) {
      this.log.warn?.(`人格微调记录没存上：${err.message}`);
    }
  }

  history() {
    return this.state.history.slice(-10).reverse();
  }

  status() {
    return { enabled: this.enabled, lastAt: this.state.lastAt || 0, count: this.state.history.length, history: this.history() };
  }

  async maybeEvolve({ notes = [], force = false } = {}) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    if (!this.brain?.complete || !this.setPersona) return { ok: false, reason: 'not-ready' };
    if (!force && Date.now() - (this.state.lastAt || 0) < this.minGapMs) return { ok: false, reason: 'gap' };
    const material = (Array.isArray(notes) ? notes : [])
      .map((n) => clean(n?.text || n))
      .filter(Boolean)
      .slice(0, 10);
    if (!material.length) return { ok: false, reason: 'no-notes' };

    const p = this.getPersona() || {};
    const style = clean(p.style);
    const rules = Array.isArray(p.rules) ? p.rules.map(clean).filter(Boolean) : [];
    const prompt = clean(p.systemPrompt);
    const raw = await this.brain.complete({
      system: '你在回看自己最近学到的东西，只决定要不要往自己的说话方式里加一点东西。只输出 JSON，不要解释。',
      prompt: [
        `你现在的说话风格：${style || '（没单独写，按整段系统提示词来）'}`,
        `现在的行为规矩：${rules.length ? rules.join('；') : '（没单独写）'}`,
        '',
        '最近学到的东西：',
        ...material.map((t) => `- ${t}`),
        '',
        '只允许追加，不许重写。宁可不变，也不要为了变而变。',
        '输出一行 JSON：{"styleAdd":"一句新的说话习惯，不超过60字","rule":"一条新的行为规矩，不超过60字","reason":"为什么"}',
        '不想改就输出 {}。不要碰名字、身份、整段提示词；不要写政治、色情、攻击性内容。',
      ].join('\n'),
      maxChars: 400,
      purpose: 'background',
    }).catch((err) => {
      this.log.warn?.(`人格微调没跑成：${err.message}`);
      return '';
    });

    const parsed = this.#parse(raw);
    const styleAdd = this.#validAdd(parsed.styleAdd, `${style} ${prompt}`);
    const rule = this.#validAdd(parsed.rule, `${rules.join(' ')} ${prompt}`);
    if (!styleAdd && !rule) return { ok: false, reason: 'nothing' };

    const before = { style: p.style || '', rules: Array.isArray(p.rules) ? [...p.rules] : [], systemPrompt: p.systemPrompt || '' };
    const next = { ...p };
    let mode = 'fields';
    let block = '';
    if (String(p.systemPrompt || '').trim()) {
      mode = 'prompt';
      const lines = [];
      if (styleAdd) lines.push(`- 说话上：${styleAdd}`);
      if (rule) lines.push(`- 行为上：${rule}`);
      block = `\n\n【自己后来悟到的】\n${lines.join('\n')}`;
      if (before.systemPrompt.length + block.length > MAX_PROMPT) return { ok: false, reason: 'too-long' };
      next.systemPrompt = before.systemPrompt + block;
    } else {
      if (styleAdd) {
        if ((style + '；' + styleAdd).length > MAX_STYLE) return { ok: false, reason: 'too-long' };
        next.style = style ? `${style.replace(/[；;]\s*$/, '')}；${styleAdd}` : styleAdd;
      }
      if (rule) {
        if (rules.length >= 30) return { ok: false, reason: 'too-many-rules' };
        next.rules = [...rules, rule];
      }
    }

    this.setPersona(next);
    const record = {
      id: `pe${Date.now().toString(36)}`,
      at: Date.now(),
      mode,
      styleAdd,
      rule,
      reason: clip(parsed.reason, 120),
      block,
      before,
    };
    this.state.history.push(record);
    this.state.lastAt = Date.now();
    this.#save();
    this.log.info?.(`人格微调：${[styleAdd, rule].filter(Boolean).join(' / ')}`);
    return { ok: true, ...record };
  }

  /** 撤销一条：只把当时追加的那段拿掉，不动后来别的改动 */
  undo(id) {
    if (!this.setPersona) return { ok: false, reason: 'not-ready' };
    const idx = this.state.history.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, reason: 'not-found' };
    const rec = this.state.history[idx];
    const p = this.getPersona() || {};
    const next = { ...p };
    if (rec.mode === 'prompt') {
      if (!String(p.systemPrompt || '').includes(rec.block)) return { ok: false, reason: 'changed' };
      next.systemPrompt = String(p.systemPrompt).replace(rec.block, '');
    } else {
      if (rec.styleAdd) {
        const add = `；${rec.styleAdd}`;
        if (!String(p.style || '').includes(add)) return { ok: false, reason: 'changed' };
        next.style = String(p.style).replace(add, '');
      }
      if (rec.rule && Array.isArray(p.rules)) {
        if (!p.rules.includes(rec.rule)) return { ok: false, reason: 'changed' };
        next.rules = p.rules.filter((r) => r !== rec.rule);
      }
    }
    this.setPersona(next);
    this.state.history.splice(idx, 1);
    this.#save();
    return { ok: true, persona: next };
  }

  #parse(raw) {
    const text = String(raw || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return {};
    try {
      const obj = JSON.parse(m[0]);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  #validAdd(value, existing) {
    const t = clip(value, MAX_ADD);
    if (!t || [...t].length < 4) return '';
    if (SENSITIVE.test(t) || BAD.test(t)) return '';
    if (existing && existing.includes(t)) return '';
    return t;
  }
}
