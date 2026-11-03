import { createLogger } from './util.mjs';
import { inQuietHours } from './share.mjs';

/**
 * 定时插嘴：每 N 分钟掷一次骰子，中了就自己找话头说一句。
 *
 * 和「被 @ 才回」的区别：这是机器人主动开口，不需要谁叫它。
 * 话题优先级：群里刚在聊什么 → 顺着聊；群里冷清 → 说点自己感兴趣的。
 *
 * 配置（config.json 的 chat.proactiveInterject）：
 *   enabled        开关
 *   chance         每次掷中的概率（0~1，当前 0.5）
 *   everyMinutes   多久掷一次（当前 30 分钟）
 *   groups         对哪些群生效（空 = 所有已加入的群，轮流）
 *   backoffQuiet   群里没人说话时，是不是也开口（false = 冷场就不说话，只顺着聊）
 */
export class InterjectScheduler {
  constructor({ config, bot, log, emitter }) {
    this.cfg = (config.chat && config.chat.proactiveInterject) || {};
    // 主动说话的地方：agent.targets（含私聊）优先，其次旧的 chat.proactiveInterject.groups
    this.targets = config.agent?.targets || this.cfg.targets || [];
    this.chat = config.chat || {};
    this.bot = bot;
    this.log = log || createLogger('interject');
    this.emitter = emitter;
    this.timer = null;
    this.stopped = false;
    this.cursor = 0;
    this.running = false;
    this.lastSaidAt = new Map();
  }

  get enabled() {
    return this.cfg.enabled === true;
  }

  start() {
    if (!this.enabled) {
      this.log.info('定时插嘴未启用（chat.proactiveInterject.enabled=false）');
      return;
    }
    const minutes = Number(this.cfg.everyMinutes ?? 30);
    this.log.info(`定时插嘴已启动：每 ${minutes} 分钟掷一次，命中率 ${Math.round(Number(this.cfg.chance ?? 0.5) * 100)}%`);
    this.#schedule(minutes);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #schedule(minutes) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick().catch((err) => this.log.error(`定时插嘴出错：${err.message}`));
    }, Math.max(60_000, minutes * 60_000));
    this.timer.unref?.();
  }

  /** 掷一次骰子；force=true 时无视概率（手工触发用） */
  async tick({ force = false } = {}) {
    if (this.stopped || this.running) return { ok: false, reason: 'busy-or-stopped' };
    this.running = true;
    try {
      if (!force && inQuietHours(this.chat.quietHours)) return { ok: false, reason: 'quiet-hours' };
      const chance = Number(this.cfg.chance ?? 0.5);
      const roll = Math.random();
      if (!force && roll >= chance) {
        this.emitter?.emit({ type: 'interject-skip', roll, chance, at: Date.now() });
        return { ok: false, reason: `dice(${roll.toFixed(2)} >= ${chance})` };
      }
      const scope = this.#pickScope();
      if (!scope) return { ok: false, reason: 'no-group' };
      return await this.say(scope, { force });
    } finally {
      this.running = false;
      if (!this.stopped) this.#schedule(Number(this.cfg.everyMinutes ?? 30));
    }
  }

  #pickScope() {
    if (this.targets?.length) {
      const list = this.targets.map((t) => (String(t).includes(':') ? String(t) : `group:${t}`));
      const scope = list[this.cursor % list.length];
      this.cursor += 1;
      return scope;
    }
    const configured = (this.cfg.groups || []).map(String);
    if (configured.length) {
      const id = configured[this.cursor % configured.length];
      this.cursor += 1;
      return `group:${id}`;
    }
    const groups = [...(this.bot.groups?.values?.() || [])];
    if (!groups.length) return null;
    // 轮流来，别老在同一个群刷存在感
    const pick = groups[this.cursor % groups.length];
    this.cursor += 1;
    return `group:${pick.group_id}`;
  }

  /** 看群里的上下文，决定说什么 */
  async say(scope, { force = false } = {}) {
    const recent = this.bot.recent(scope, 12).filter((row) => row && row.text);

    // 自问自答护栏：上一条如果就是我自己发的、之后没人接话，就别再开口了
    const lastRow = recent[recent.length - 1];
    if (!force && lastRow && lastRow.role === 'bot') {
      return { ok: false, reason: 'waiting-for-reply' };
    }
    const myName = this.bot.personaName;
    const others = recent.filter((row) => row.role !== 'bot' && row.name !== myName);
    const now = Date.now();
    const FRESH = 45 * 60_000;
    const fresh = others.filter((row) => !row.at || now - Number(row.at) < FRESH);

    let customAsk;
    let mode;
    if (fresh.length >= 2) {
      mode = 'context';
      const transcript = fresh
        .slice(-8)
        .map((row) => `${row.name || '群友'}: ${String(row.text).slice(0, 120)}`)
        .join('\n');
      customAsk =
        `（群里刚才在聊这些：\n${transcript}\n\n` +
        `你自己看着来：要么顺着他们的话题插一句有信息量的话，要么接着其中一个点抖个机灵，总之别像客服、别总结、别客套，也别复述他们说过的话。` +
        `想插话就插，不想接这个话题就自己另起一个你最近在意的话题。` +
        `注意：只发你自己的这一句，别自问自答，别紧接着回答你上一条问过的问题。只输出你要发的那一句话。）`;
    } else {
      mode = 'own-topic';
      if (this.cfg.backoffQuiet === false && !force) {
        return { ok: false, reason: 'group-quiet' };
      }
      customAsk =
        `（群里现在挺安静的，没人说话。你自己想开口说点什么：` +
        `聊点你最近真正在意的东西——比如在玩的游戏、追的番、刚看到的数码新品、某个你最近想不明白的问题。` +
        `就用一两句话把话题抛出来，引起别人想接话那种，不要问"有人在吗"，也不要客套。` +
        `注意：只发这一句，别自己在后面接一句回答或补充。只输出你要发的那一句话。）`;
    }

    const out = await this.bot.brain.generate({
      history: this.bot.recent(scope, 8),
      scopeLabel: 'QQ 群里自己开口',
      triggerReason: 'interject',
      customAsk,
      maxChars: Number(this.chat.maxReplyChars || 120),
    });
    const text = (out.texts || []).join(' ').trim();
    if (!text) return { ok: false, reason: 'empty-generation' };

    const messageId = await this.bot.send(scope, text);
    this.lastSaidAt.set(scope, Date.now());
    this.log.info(`主动插嘴 ${scope}（${mode}）：${text.slice(0, 40)} #${messageId ?? '-'}`);
    this.emitter?.emit({ type: 'interject', scope, mode, text, messageId, at: Date.now() });
    return { ok: true, scope, mode, text, messageId };
  }
}
