import { createLogger, sleep } from './util.mjs';
import { SOURCE_LABELS, SOURCE_NAMES, cleanUrl, searchSource } from './sources.mjs';

/**
 * 主动分享：隔一阵子自己去 B站/知乎/贴吧/头条 找点有意思的东西，往群里丢一条。
 *
 * 配置（config.json 的 share）：
 *   enabled          总开关
 *   groups           发到哪些群（群号数组；空 = 自动挑最近有动静的群）
 *   sources          来源轮换顺序
 *   topics           关键词池，每次随机挑一个去搜
 *   intervalMinutes  基础间隔
 *   jitterMinutes    随机抖动（0~N 分钟）
 *   maxPerDay        每天最多发几次
 *   quietHours       安静时段，沿用 "01:00-07:00" 写法
 *   minGroupIdleMs   群里安静多久之后才发（避免打断正在聊的话题）
 *   dryRun           true = 只搜+生成，不真发（日志里能看到成品）
 */

function hhmmToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function inQuietHours(ranges, now = new Date()) {
  if (!Array.isArray(ranges) || !ranges.length) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const range of ranges) {
    const [a, b] = String(range).split('-');
    const start = hhmmToMinutes(a);
    const end = hhmmToMinutes(b);
    if (start == null || end == null) continue;
    if (start <= end ? cur >= start && cur < end : cur >= start || cur < end) return true;
  }
  return false;
}

export class ShareScheduler {
  constructor({ config, bot, log, emitter }) {
    this.cfg = config.share || {};
    // 主动说话的地方：agent.targets（含私聊）优先
    this.targets = config.agent?.targets || this.cfg.targets || [];
    this.bot = bot;
    this.log = log || createLogger('share');
    this.emitter = emitter;
    this.timer = null;
    this.stopped = false;
    this.history = []; // 已发送时间戳
    this.cursor = 0; // 来源轮换游标
    this.topicCursor = 0;
    this.running = false;
  }

  get enabled() {
    return this.cfg.enabled === true;
  }

  start() {
    if (!this.enabled) {
      this.log.info('主动分享未启用（share.enabled=false）');
      return;
    }
    this.log.info(
      `主动分享已启动：每 ${this.cfg.intervalMinutes ?? 30} 分钟 ±${this.cfg.jitterMinutes ?? 10} 分钟掷一次，` +
        `命中率 ${Math.round(Number(this.cfg.chance ?? 0.5) * 100)}%，` +
        `来源 ${(this.cfg.sources || SOURCE_NAMES).join('/')}，每天最多 ${this.cfg.maxPerDay ?? 4} 条`,
    );
    this.#schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #schedule() {
    if (this.stopped) return;
    const base = Number(this.cfg.intervalMinutes ?? 30) * 60_000;
    const jitter = Number(this.cfg.jitterMinutes ?? 10) * 60_000 * Math.random();
    const delay = Math.max(60_000, base + jitter);
    this.timer = setTimeout(() => {
      this.tick().catch((err) => this.log.error(`主动分享出错：${err.message}`));
    }, delay);
    this.timer.unref?.();
    this.log.debug(`下一次主动分享约 ${Math.round(delay / 60_000)} 分钟后`);
  }

  /** 定时器到点：做一堆判断，通过就发一条 */
  async tick({ force = false } = {}) {
    if (this.stopped || this.running) return { ok: false, reason: 'busy-or-stopped' };
    const cfg = this.cfg;
    this.running = true;
    try {
      if (!force && inQuietHours(cfg.quietHours)) return { ok: false, reason: 'quiet-hours' };

      const chance = Number(cfg.chance ?? 0.5);
      const roll = Math.random();
      if (!force && roll >= chance) {
        this.emitter?.emit({ type: 'share-skip', roll, chance, at: Date.now() });
        return { ok: false, reason: `dice(${roll.toFixed(2)} >= ${chance})` };
      }

      const perDay = Number(cfg.maxPerDay ?? 4);
      const dayAgo = Date.now() - 24 * 3600_000;
      this.history = this.history.filter((t) => t > dayAgo);
      if (!force && this.history.length >= perDay) return { ok: false, reason: `daily-cap(${perDay})` };

      const scope = await this.#pickScope();
      if (!scope) return { ok: false, reason: 'no-group' };

      const idle = Number(cfg.minGroupIdleMs ?? 0);
      if (!force && idle > 0) {
        const recent = this.bot.recent(scope, 5);
        const lastAt = Number(recent[recent.length - 1]?.at || recent[recent.length - 1]?.time || 0);
        if (lastAt && Date.now() - lastAt < idle) return { ok: false, reason: 'group-busy' };
      }

      // 自问自答护栏：群里最后一条要是自己发的、还没人接，就别再刷一条
      const tail = this.bot.recent(scope, 1);
      if (!force && tail.length && tail[tail.length - 1].role === 'bot') {
        return { ok: false, reason: 'waiting-for-reply' };
      }

      const result = await this.share(scope, { force });
      if (result.ok) this.history.push(Date.now());
      return result;
    } finally {
      this.running = false;
      if (!this.stopped) this.#schedule();
    }
  }

  async #pickScope() {
    // targets 写完整 scope（group:xxx / private:xxx），对私聊一样适用
    if (this.targets?.length) {
      const list = this.targets.map((t) => (String(t).includes(':') ? String(t) : `group:${t}`));
      const scope = list[this.cursor % list.length];
      this.cursor += 1;
      return scope;
    }
    const configured = (this.cfg.groups || []).map(String);
    if (configured.length) {
      const scope = `group:${configured[this.cursor % configured.length]}`;
      this.cursor += 1;
      return scope;
    }
    const groups = [...(this.bot.groups?.values?.() || [])];
    if (!groups.length) return null;
    // 没配置就挑一个人少、不炸群的：优先 3~30 人的群
    const sorted = groups.sort((a, b) => (a.member_count || 0) - (b.member_count || 0));
    const pick = sorted[Math.min(sorted.length - 1, this.cursor % Math.max(1, sorted.length))];
    this.cursor += 1;
    return `group:${pick.group_id}`;
  }

  /** 话题不再按顺序轮：让模型从兴趣池里挑一个它此刻真想看的 */
  async #pickTopic() {
    const pool = Array.isArray(this.cfg.interests) && this.cfg.interests.length
      ? this.cfg.interests
      : Array.isArray(this.cfg.topics) && this.cfg.topics.length
        ? this.cfg.topics
        : ['新番', '显卡', '装机'];
    try {
      const out = await this.bot.brain.generate({
        history: [],
        scopeLabel: '自己挑想看的东西',
        triggerReason: 'share',
        customAsk:
          `（你现在想去网上翻点东西看看。可选的兴趣：${pool.join('、')}。\n` +
          `挑一个你此刻最想搜的关键词，只输出这个词本身，不要标点、不要解释。）`,
        maxChars: 12,
      });
      const picked = (out.texts || []).join('').replace(/[「」"'“”\s]/g, '').trim();
      if (picked && picked.length <= 12) return picked;
    } catch (err) {
      this.log.debug(`挑话题失败：${err.message}`);
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** 真干活：搜 → 挑一条 → 让模型写一句点评 → 拼链接发出去 */
  async share(scope, { force = false } = {}) {
    const sources = (Array.isArray(this.cfg.sources) && this.cfg.sources.length ? this.cfg.sources : SOURCE_NAMES).filter(
      (s) => SOURCE_NAMES.includes(s),
    );
    const topic = await this.#pickTopic();

    let items = [];
    let usedSource = null;
    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[(this.cursor + i) % sources.length];
      const found = (await searchSource(source, topic, { limit: 6 })).filter(
        (x) => x.title && x.title.replace(/[\s\p{P}]/gu, '').length >= 6,
      );
      const need = Number(this.cfg.minItems ?? 2);
      if (found.length >= need) {
        items = found;
        usedSource = source;
        this.cursor += 1;
        break;
      }
      this.log.debug(`${SOURCE_LABELS[source]} 搜「${topic}」只有 ${found.length} 条（需要 ${need}），换下一个来源`);
    }
    if (!usedSource) {
      this.log.info(`这轮没搜到合适素材（关键词「${topic}」），跳过`);
      return { ok: false, reason: 'no-material' };
    }

    // 挑一条：优先有描述的，随机取前 5 里的一个
    const pool = items.slice(0, 5);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const list = pool.map((x, i) => `${i + 1}. ${x.title}${x.desc ? `（${x.desc}）` : ''}`).join('\n');

    const customAsk =
      `（你刚在刷${SOURCE_LABELS[usedSource]}，搜「${topic}」看到这些：\n${list}\n\n` +
      `你决定发这条：${pick.title}\n` +
      `就这条写一句你自己的吐槽或点评（别写成别的标题，别看错），口气自然、像随手打的一句，` +
      `别写成新闻播报，别说"我刚搜了""给大家分享"这类话，也别贴链接（链接我会另起一行附上）。\n` +
      `如果这几条你一条都不感兴趣，就只回复两个字：跳过。）`;

    let comment = '';
    try {
      const out = await this.bot.brain.generate({
        history: this.bot.recent(scope, 6),
        scopeLabel: 'QQ 群里主动丢东西',
        triggerReason: 'share',
        customAsk,
        maxChars: 80,
      });
      comment = (out.texts || []).join(' ').trim();
    } catch (err) {
      this.log.warn(`生成点评失败：${err.message}`);
    }
    if (/^(跳过|skip|不感兴趣)[。！!]?$/i.test(comment)) {
      this.log.info(`这轮素材都不合口味（${SOURCE_LABELS[usedSource]}·${topic}），跳过`);
      return { ok: false, reason: 'not-interested', source: usedSource, topic };
    }
    if (!comment) comment = pick.title.slice(0, 40);

    const message = `${comment}\n${cleanUrl(pick.url)}`;
    if (this.cfg.dryRun) {
      this.log.info(`[dryRun] ${scope} → ${message}`);
      return { ok: true, dryRun: true, scope, message, source: usedSource, topic };
    }

    const messageId = await this.bot.send(scope, message);
    this.log.info(`已分享到 ${scope}（${SOURCE_LABELS[usedSource]}·${topic}）：${pick.title} #${messageId ?? '-'}`);
    this.emitter?.emit({
      type: 'share',
      scope,
      source: usedSource,
      topic,
      title: pick.title,
      url: cleanUrl(pick.url),
      messageId,
      at: Date.now(),
    });
    return { ok: true, scope, messageId, message, source: usedSource, topic, title: pick.title, url: cleanUrl(pick.url) };
  }
}
