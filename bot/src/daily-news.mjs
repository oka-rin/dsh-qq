import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, appendJsonl } from './util.mjs';
import { createHash } from 'node:crypto';
import { fetchScheduledNews, NEWS_SOURCES, NEWS_SOURCE_TIMES } from './daily-catalog.mjs';

export const DAILY_NEWS_DEFAULTS = {
  enabled: false,
  time: '10:00',
  timeZone: 'Asia/Shanghai',
  retryMinutes: 10,
  catchUpMinutes: 120,
  sources: ['ithome', 'ai', '60s'],
  sourceTimes: {},
  deduplicate: true,
  sourceGapMs: 1500,
  dryRun: false,
};

export function localNewsTime(now, timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

// 明确空 targets 表示全部取消：绝不重新并入 legacy groups 或私聊。
export function selectedNewsGroups(config) {
  const targets = Array.isArray(config.agent?.targets) ? config.agent.targets : [];
  const chat = config.chat || {};
  const excluded = new Set([...(chat.blacklistGroups || []), ...(chat.muteGroups || [])].map(String));
  const whitelist = new Set((chat.whitelistGroups || []).map(String));
  return [...new Set(targets.map(String).filter((s) => /^group:[1-9]\d*$/.test(s)))].filter((scope) => {
    const id = scope.slice(6);
    return !excluded.has(id) && (!whitelist.size || whitelist.has(id));
  });
}

function newsConfig(config) { return { ...DAILY_NEWS_DEFAULTS, ...config.dailyNews }; }

function sourceInWindow(cfg, source, minute) {
  // Keep the original three-source time override backwards compatible; new sources
  // have their recommended slot even when an old config only expands `sources`.
  const time = cfg.sourceTimes?.[source] ?? (['60s', 'ai', 'ithome'].includes(source) ? cfg.time : NEWS_SOURCE_TIMES[source] ?? cfg.time);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`dailyNews 的 ${source} 时间必须是 HH:mm`);
  const [hour, min] = time.split(':').map(Number);
  const elapsed = minute - hour * 60 - min;
  return elapsed >= 0 && elapsed < Math.max(1, Number(cfg.catchUpMinutes) || 120);
}

function fingerprint(news) {
  // Exclude presentation dates for adapters without a content identity.
  const payload = news.dedupeKey || news.text.replaceAll(news.sourceDate, '<date>');
  return createHash('sha256').update(payload).digest('hex');
}

/** 固定订阅独立于 AgentLoop 的概率/额度；不调用模型、不发私聊或空间。 */
export class DailyNewsScheduler {
  constructor({ config, getConfig = () => config, bot, log, emitter, fetchNews = fetchScheduledNews, now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.getConfig = getConfig;
    this.bot = bot;
    this.log = log;
    this.emitter = emitter;
    this.fetchNews = fetchNews;
    this.now = now;
    this.wait = wait;
    this.file = path.join(config.storage.dataDir, 'daily-news-state.json');
    this.logFile = path.join(config.storage.dataDir, 'daily-news-log.jsonl');
    this.running = false;
    this.stopped = false;
    this.timer = null;
    this.lastAttempts = new Map();
    // 损坏的回执不能当空账本，否则可能重发一整天。
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { receipts: {} };
    if (!this.state || typeof this.state.receipts !== 'object' || Array.isArray(this.state.receipts) || !this.state.receipts
      || (this.state.latest !== undefined && (!this.state.latest || typeof this.state.latest !== 'object' || Array.isArray(this.state.latest)))) {
      throw new Error('daily-news-state 回执格式损坏，已停止推送以防重复');
    }
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.log.info('每日资讯调度已启动（按配置时区与时间，只向勾选群推送）');
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(async () => {
        try { await this.tick(); } catch (error) { this.log.error(`每日资讯：${error.message}`); }
        finally { this.timer = null; schedule(); }
      }, 15_000);
      this.timer.unref?.();
    };
    schedule();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }

  #record(event) {
    const row = { at: this.now(), ...event };
    appendJsonl(this.logFile, row);
    this.emitter?.emit({ type: 'daily-news', ...row });
    this.log.info(`每日资讯 ${event.date || ''} ${event.scope || ''} ${event.source || ''}：${event.status}${event.error ? ` ${event.error}` : ''}`);
  }

  #save() { writeJsonAtomic(this.file, this.state); }

  status() {
    const config = this.getConfig();
    const cfg = newsConfig(config);
    const { date } = localNewsTime(this.now(), cfg.timeZone);
    return {
      ...cfg, groups: selectedNewsGroups(config), running: this.running,
      lastAttempts: Object.fromEntries(this.lastAttempts),
      today: Object.fromEntries(Object.entries(this.state.receipts).filter(([key]) => key.startsWith(`${date}/`))),
      recent: Object.fromEntries(Object.entries(this.state.receipts).sort((a, b) => Number(b[1].at) - Number(a[1].at)).slice(0, 48)),
    };
  }

  async tick() {
    if (this.stopped) return { ok: false, reason: 'stopped' };
    if (this.running) return { ok: false, reason: 'busy' };
    this.running = true;
    try { return await this.#run(); } finally { this.running = false; }
  }

  async #run() {
    const config = this.getConfig();
    const cfg = newsConfig(config);
    if (!cfg.enabled) return { ok: true, reason: 'disabled' };
    const now = this.now();
    const { date, minute } = localNewsTime(now, cfg.timeZone);
    if (cfg.notBeforeDate && date < cfg.notBeforeDate) return { ok: true, reason: 'not-started' };
    const targets = selectedNewsGroups(config);
    if (!targets.length) return { ok: true, reason: 'no-selected-groups' };
    const configured = [...new Set(cfg.sources || [])].filter((s) => NEWS_SOURCES.includes(s));
    if (!configured.length) return { ok: true, reason: 'no-sources' };
    const due = configured.filter((s) => sourceInWindow(cfg, s, minute));
    if (!due.length) return { ok: true, reason: 'outside-window' };
    const pending = (scope, source) => !Object.hasOwn(this.state.receipts, `${date}/${scope}/${source}`);
    const todo = due.filter((source) => targets.some((scope) => pending(scope, source)));
    if (!todo.length) return { ok: true, reason: 'already-sent' };
    const sources = todo.filter((source) => {
      const attempt = this.lastAttempts.get(source);
      return !attempt || now - attempt >= Math.max(1, Number(cfg.retryMinutes) || 10) * 60_000;
    });
    if (!sources.length) return { ok: true, reason: 'retry-wait' };
    // 断线不占回执；启动时未登录也能通过只读身份查询自行恢复。
    const dry = Boolean(cfg.dryRun || config.agent?.dryRun);
    const ready = () => {
      const s = this.bot.status();
      return /^[1-9]\d*$/.test(String(s.selfId || '')) && s.transport?.http === 'ok';
    };
    if (!dry && !ready()) {
      try {
        const info = await this.bot.onebot?.loginInfo();
        const id = String(info?.user_id ?? info?.uin ?? '');
        if (/^[1-9]\d*$/.test(id)) {
          this.bot.selfId = id;
          this.bot.nickname = info.nickname || this.bot.nickname || '';
        }
      } catch (error) { this.log.info(`每日资讯等待桥接恢复：${error.message}`); }
      if (!ready()) return { ok: false, reason: 'offline' };
    }
    const results = [];
    let attempted = false;
    for (const source of sources) {
      if (this.stopped) break;
      if (!targets.some((scope) => pending(scope, source))) continue;
      if (attempted) await this.wait(Math.max(0, Number(cfg.sourceGapMs) || 0));
      if (this.stopped) break;
      attempted = true;
      this.lastAttempts.set(source, this.now());
      let news;
      try {
        news = await this.fetchNews(source, { date, apiKey: source === 'games' ? process.env.RAWG_API_KEY : undefined });
        if (!news || news.sourceDate !== date || typeof news.text !== 'string' || !news.text.trim() || news.text.length > 4000) {
          throw new Error('资讯日期/正文无效（不会发送旧日报或超长正文）');
        }
      } catch (error) {
        this.#record({ date, source, status: 'source-error', error: error.message });
        results.push({ source, ok: false, error: error.message });
        continue;
      }
      const hash = fingerprint(news);
      for (const scope of targets) {
        // 获取/生成期间用户可取消群，或开启演练；出站前再次核对。
        const latest = this.getConfig();
        const freshCfg = newsConfig(latest);
        const freshTime = localNewsTime(this.now(), freshCfg.timeZone);
        if (this.stopped || !freshCfg.enabled || freshTime.date !== date
          || !sourceInWindow(freshCfg, source, freshTime.minute)
          || (freshCfg.notBeforeDate && date < freshCfg.notBeforeDate)) break;
        if (!(freshCfg.sources || []).includes(source) || !selectedNewsGroups(latest).includes(scope) || !pending(scope, source)) continue;
        const currentDry = Boolean(freshCfg.dryRun || latest.agent?.dryRun);
        if (currentDry) {
          this.#record({ date, scope, source, status: 'dry', preview: news.text });
          results.push({ scope, source, dry: true, ok: true });
          continue;
        }
        const key = `${date}/${scope}/${source}`;
        const previous = this.state.latest?.[`${scope}/${source}`];
        if (freshCfg.deduplicate !== false && previous?.hash === hash) {
          const receipt = { status: 'unchanged', at: this.now(), hash, previousAt: previous.at };
          this.state.receipts[key] = receipt;
          this.#save();
          this.#record({ date, scope, source, ...receipt });
          results.push({ scope, source, ok: true, ...receipt });
          continue;
        }
        if (!ready()) { results.push({ scope, source, ok: false, error: 'offline' }); continue; }
        // 先写发送意图，再出站：崩溃/超时返回不明时宁可漏一条，不自动重发造成刷屏。
        this.state.receipts[key] = { status: 'sending', at: this.now() };
        this.#save();
        let receipt;
        try {
          const id = await this.bot.send(scope, news.text);
          const validId = (typeof id === 'number' && Number.isSafeInteger(id) && id !== 0)
            || (typeof id === 'string' && /^-?[1-9]\d*$/.test(id));
          receipt = validId
            ? { status: 'sent', messageId: String(id), at: this.now() }
            : { status: 'uncertain', error: '未取得message_id，禁止自动重发；请人工核查', at: this.now() };
        } catch (error) {
          receipt = { status: 'uncertain', error: error.message, at: this.now() };
        }
        this.state.receipts[key] = { ...receipt, hash };
        if (receipt.status === 'sent') {
          this.state.latest ||= {};
          this.state.latest[`${scope}/${source}`] = { hash, at: receipt.at };
        }
        this.#save();
        this.#record({ date, scope, source, ...receipt, hash, sourceUrl: news.sourceUrl, sourceDate: news.sourceDate });
        results.push({ scope, source, ok: receipt.status === 'sent', ...receipt });
      }
    }
    // 仅保留近14天，保留整个今日的确认/不确定回执。
    const cutoff = new Date(now - 14 * 86400_000).toISOString().slice(0, 10);
    for (const key of Object.keys(this.state.receipts)) if (key.slice(0, 10) < cutoff) delete this.state.receipts[key];
    this.#save();
    return { ok: results.every((r) => r.ok), date, results };
  }
}
