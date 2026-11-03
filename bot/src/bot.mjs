// 只拦「越线」的：骂家人、动手威胁、往死里咒。普通的还嘴脏话（煞笔/滚/有病）不再拦——
// 用户明确要「像人一样回怼、可以骂人，只要别敏感」，护栏再拦就变成没脾气的客服了。
export const TONE_GUARD = [
  /(你妈|你爸|你全家|死全家|全家死|祖宗|去死|弄死|杀了你|打死你|信不信我|收拾你|抽你|扇你|挠你|卸你)/i,
];

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger, Emitter, fmtDuration, humanPause, scopeKey, similarity, sleep, truncate } from './util.mjs';
import {
  at,
  forwardsOf,
  image,
  imagesOf,
  mentionsMe,
  normalizeMessage,
  plainText,
  reply,
  replyTargetOf,
  senderName,
  splitReply,
  text,
  video,
  videosOf,
} from './segments.mjs';
import { parseSkip, parseMeme, splitMemeWish } from './brain.mjs';
import { collectMedia, warmVideos } from './vision.mjs';
import { expandForward } from './media.mjs';
import { collect as collectMeme, fetchImage } from './meme-collect.mjs';
import { lookupIfNeeded } from './websearch.mjs';
import { drawPromptOf, generateImage, wantsDraw, wantsRedraw, wantsResend, wantsWait } from './imagegen.mjs';
import { refinePrompt } from './promptbrain.mjs';

const ADMIN_MUTE = /^(闭嘴|别说了|安静|安静点|别bb|停下|shut ?up)[!！。.~]*$/i;
const ADMIN_UNMUTE = /^(开聊|说话|继续说|出来|继续)[!！。.~]*$/i;
const ADMIN_STATUS = /^(状态|status)[?？!！。.]*$/i;

/**
 * QQ 会话大脑：收事件 → 判断该不该说话 → 调模型 → 发出去。
 * 也对外暴露 send/autochat 等方法，供控制台、MCP、CLI 复用。
 */
export class Bot {
  constructor({ config, onebot, store, brain, scopeMemory = null, people = null, decisions = null, memes = null, learn = null, log = createLogger('bot'), emitter = new Emitter() }) {
    this.cfg = config;
    this.onebot = onebot;
    this.store = store;
    this.brain = brain;
    this.scopeMemory = scopeMemory; // 群记忆（ScopeMemory），与下面按会话缓存的 this.memory 不是一回事
    this.people = people; // 人物画像（PeopleBook）
    this.learn = learn; // 自主学习笔记（LearnBook）
    this.decisions = decisions; // 「为什么没说话」账本
    this.memes = memes; // 表情包图库（MemeLibrary），发图时用
    this.memeHashes = new Set(); // 收集去重：最近入库过的图片内容哈希
    this.memeCollectDay = '';
    this.memeCollectCount = 0;
    this.memeCollectAt = 0;
    this.log = log;
    this.emitter = emitter;

    this.startedAt = Date.now();
    this.selfId = String(config.onebot.selfId || '');
    this.nickname = '';
    this.groups = new Map(); // groupId -> { group_id, group_name, member_count }
    this.memory = new Map(); // scope -> rows[]
    this.sentIds = new Set();
    this.seenIds = new Set();
    this.queues = new Map(); // scope -> { busy, pending }
    this.userCooldown = new Map();
    this.groupCooldown = new Map();
    this.recentReplies = []; // 时间戳数组，控制每分钟回复数
    // 群里有人 @ 过我之后，他接着说的话（不带 @）也算在对我说：scope → { uin, name, since, until }
    this.followUps = new Map();
    this.videoFollowed = new Map(); // scope -> 已经补过话的视频 URL，避免同一条反复补
    this.drawState = new Map(); // 每个会话今天画了几张、上次画是什么时候、上一张图存在哪
    this.#loadDrawState();
    this.tweetLinks = new Map(); // scope → 最近甩过的推特链接 [{url, from, at}]
    this.xhsLinks = new Map(); // scope → 最近甩过的小红书笔记链接 [{url, from, at}]
    this.seenCount = new Map(); // scope -> 观察到的消息条数
    this.lastInterjectAt = new Map();
    this.unsubs = [];
    this.inflight = new Set(); // 正在生成/发送的回复，stop() 时等它们收尾
    this.stopped = false;
  }

  get personaName() {
    return this.store.persona()?.name || this.cfg.persona.name;
  }

  /* ------------------------------------------------------------ 生命周期 */

  async start() {
    const info = await this.onebot.loginInfo().catch((err) => {
      this.log.warn(`获取登录信息失败（不影响继续）：${err.message}`);
      return null;
    });
    if (info) {
      this.selfId = String(info.user_id ?? this.onebot.state.selfId ?? this.selfId);
      this.nickname = info.nickname || '';
      this.log.info(`以 ${this.nickname}(${this.selfId}) 身份接入`);
    }
    await this.refreshGroups();

    this.unsubs.push(this.onebot.onEvent((event) => this.onEvent(event)));
    this.unsubs.push(this.onebot.connectEvents());

    const timer = setInterval(() => void this.refreshGroups(), 10 * 60 * 1000);
    timer.unref?.();
    this.unsubs.push(() => clearInterval(timer));
    return this;
  }

  /** 停止：断开事件流，并等正在进行的回复把手上的话说完 */
  async stop() {
    this.stopped = true;
    for (const off of this.unsubs.splice(0)) {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    }
    if (this.inflight.size) {
      await Promise.race([Promise.allSettled([...this.inflight]), sleep(5000)]);
    }
  }

  async refreshGroups() {
    try {
      const list = await this.onebot.call('get_group_list');
      if (Array.isArray(list)) {
        this.groups.clear();
        for (const g of list) this.groups.set(String(g.group_id), g);
        this.log.debug(`群列表已刷新：${this.groups.size} 个群`);
      }
    } catch (err) {
      this.log.debug(`刷新群列表失败：${err.message}`);
    }
    return [...this.groups.values()];
  }

  /* -------------------------------------------------------------- 事件 */

  onEvent(event) {
    if (this.stopped) return;
    if (event?.post_type !== 'message') {
      this.emitter.emit({ type: 'event', post_type: event?.post_type, at: Date.now() });
      return;
    }
    this.store.state.stats.events = (this.store.state.stats.events ?? 0) + 1;
    this.onMessage(event).catch((err) => this.log.error('处理消息出错：', err?.stack || err));
  }

  #scopeOf(event) {
    return event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id}`;
  }

  #memoryOf(scope) {
    if (!this.memory.has(scope)) {
      this.memory.set(scope, this.store.tail(scope, this.cfg.chat.historyTurns));
    }
    return this.memory.get(scope);
  }

  /** 这轮回复要用到的图（最近几张，抓不下来就少看几张，绝不抛给调用方） */
  /**
   * 自己攒图库：群友发表情包时顺手收一张（走 dsh-meme 插件识别+入库，
   * 落在「我的收藏」，面板里能看见，send_meme 也能直接搜到）。
   * 只收动画表情/内联表情（sub_type 13），截图和原图不搬，免得图库变垃圾场；
   * 有每日上限和内容哈希去重，同一个梗反复发不会收十几份。
   */
  async #maybeCollectMeme(scope, mediaRefs, from) {
    const cfg = this.cfg.chat?.memeCollect || {};
    if (cfg.enabled === false) return;
    const refs = (mediaRefs || []).filter((r) => /^https?:\/\//.test(String(r?.url || '')));
    if (!refs.length) return;
    // 表情类图片：1=表情、7=热门表情、13=动画表情（GIF）。sub_type 0 是普通图片，默认不收，
    // 免得把群友发的照片/截图也塞进图库；要全收就把 chat.memeCollect.allImages 设成 true。
    const STICKER_SUBTYPES = new Set([1, 7, 13]);
    const stickers = refs.filter((r) => STICKER_SUBTYPES.has(Number(r.subType)));
    const targets = cfg.allImages === true ? refs : stickers;
    if (!targets.length) return;

    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); // 按北京时间算天
    if (this.memeCollectDay !== today) {
      this.memeCollectDay = today;
      this.memeCollectCount = 0;
    }
    const maxPerDay = Number(cfg.maxPerDay ?? 8);
    if (this.memeCollectCount >= maxPerDay) return;
    const last = this.memeCollectAt || 0;
    if (Date.now() - last < Number(cfg.minIntervalMs ?? 30_000)) return;

    const ref = targets[0];
    let img;
    try {
      img = await fetchImage(ref.url, { maxBytes: Number(cfg.maxBytes ?? 8_000_000) });
    } catch (err) {
      this.log?.debug?.(`表情包没收下来（${from}）：${err.message}`);
      return;
    }
    const hash = createHash('sha256').update(img.buffer).digest('hex').slice(0, 24);
    if (this.memeHashes.has(hash)) return;
    this.memeHashes.add(hash);
    if (this.memeHashes.size > 800) this.memeHashes.delete(this.memeHashes.values().next().value);

    const r = await collectMeme({
      buffer: img.buffer,
      fileName: img.fileName,
      caption: '',
      keywords: from ? `群友 ${from} 发的表情` : '',
      log: this.log,
    });
    if (r.ok) {
      this.memeCollectCount += 1;
      this.memeCollectAt = Date.now();
      this.emitter.emit({ type: 'meme-collected', scope, tag: r.tag, caption: r.caption, at: Date.now() });
    } else {
      this.log?.debug?.(`表情包入库失败：${r.error}`);
    }
  }

  /** 当前会话最近一张图的直链（收集表情包时用）。 */
  lastMediaUrl(scope) {
    const rows = this.#memoryOf(scope) || [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const media = rows[i]?.media;
      if (Array.isArray(media) && media.length) {
        const hit = media.find((m) => /^https?:\/\//.test(String(m?.url || '')));
        if (hit) return String(hit.url);
      }
    }
    return '';
  }

  async #visionImages(scope) {
    try {
      return await collectMedia(this.#memoryOf(scope), this.cfg, { log: this.log });
    } catch (err) {
      this.log.debug(`整理图片/动图/视频失败：${err.message}`);
      return [];
    }
  }

  /**
   * 就地展开合并转发：把「[合并转发]」换成「转发了聊天记录·N条」+ 每条「名字：内容」，
   * 里面的图/视频并进同一行的 media/videos，后面 collectMedia 会一起送去看。
   * 拿不到（超时/接口失败）就保留占位符，绝不拖住整条回复。
   */
  async #expandForwards(row, segs) {
    const refs = forwardsOf(segs);
    if (!refs.length) return;
    const fwd = this.cfg.chat?.vision?.forward || {};
    if (fwd.enabled === false) return;
    const opts = {
      maxNodes: Math.max(1, Number(fwd.maxNodes ?? 12)),
      maxChars: Math.max(100, Number(fwd.maxChars ?? 1200)),
      timeoutMs: Math.max(500, Number(fwd.timeoutMs ?? 4000)),
    };
    const blocks = [];
    for (const ref of refs.slice(0, 2)) {
      if (!ref.id) continue;
      try {
        const got = await expandForward(this.onebot, ref.id, opts);
        if (got) blocks.push(got);
      } catch (err) {
        this.log?.debug?.(`展开合并转发失败：${err?.message ?? err}`);
      }
    }
    if (!blocks.length) return;
    let body = String(row.text || '');
    for (const block of blocks) {
      const pos = body.indexOf('[合并转发]');
      body = pos >= 0
        ? `${body.slice(0, pos)}${block.text}${body.slice(pos + '[合并转发]'.length)}`
        : `${body}${body ? '\n' : ''}${block.text}`;
      for (const im of block.images || []) (row.media ||= []).push(im);
      for (const v of block.videos || []) (row.videos ||= []).push(v);
    }
    row.text = body.slice(0, 4000);
    row.forwards = blocks.map((b) => ({ count: b.count, used: b.used }));
    this.log?.debug?.(`展开合并转发 ${blocks.length} 条，共 ${blocks.reduce((n, b) => n + (b.count || 0), 0)} 条消息`);
  }

  async onMessage(event) {
    const scope = this.#scopeOf(event);
    const selfId = String(event.self_id || this.selfId);
    if (String(event.user_id) === selfId) return; // 自己发的

    const messageId = event.message_id != null ? String(event.message_id) : '';
    if (messageId) {
      if (this.seenIds.has(messageId)) return; // 重连重复投递
      this.seenIds.add(messageId);
      if (this.seenIds.size > 2000) {
        const first = this.seenIds.values().next().value;
        this.seenIds.delete(first);
      }
    }

    const segs = normalizeMessage(event.message);
    const body = plainText(segs);
    const name = senderName(event);
    const row = {
      role: 'user',
      name,
      userId: String(event.user_id),
      messageId,
      text: body,
      scope,
      at: event.time ? event.time * 1000 : Date.now(),
    };
    // 记下图片/视频位置（只留定位信息，不下载）：回复时要把最近的图真的塞给模型看，见 vision.mjs
    const mediaRefs = imagesOf(segs);
    if (mediaRefs.length) row.media = mediaRefs.slice(0, 3);
    const videoRefs = videosOf(segs);
    if (videoRefs.length) row.videos = videoRefs.slice(0, 2);
    // 合并转发：当场拉一次聊天记录，把「[合并转发]」换成真实内容，
    // 否则模型只看见「转发了聊天记录」四个字，等于什么都没看见。
    await this.#expandForwards(row, segs);
    const mem = this.#memoryOf(scope);
    mem.push(row);
    if (mem.length > this.cfg.chat.historyTurns * 2) mem.splice(0, mem.length - this.cfg.chat.historyTurns);
    this.store.append(scope, row);
    // 视频先下后抽帧要几十秒：收到就开跑，别等模型要回答这条消息时才现下
    if (Array.isArray(row.videos) && row.videos.length) {
      warmVideos([row], this.cfg, { log: this.log }).catch((e) => this.log?.debug?.(`视频预热失败：${e?.message}`));
    }
    if (mediaRefs.length) this.#maybeCollectMeme(scope, mediaRefs, name).catch((e) => this.log?.warn?.('收表情包崩了：' + e.message));
    // 群里有人甩推特链接：记下来，让 agent 知道「可以把它发出来」
    for (const link of extractTweetLinks(body)) {
      const list = this.tweetLinks.get(scope) || [];
      list.push({ url: link, from: name, at: row.at });
      this.tweetLinks.set(scope, list.slice(-5));
    }
    // 小红书笔记链接同样记下来
    for (const link of extractXhsLinks(body)) {
      const list = this.xhsLinks.get(String(scope)) || [];
      list.push({ url: link, from: name, at: row.at });
      this.xhsLinks.set(String(scope), list.slice(-5));
    }
    // 记人物画像：谁说了什么（只记文字，不发出去）
    try {
      this.people?.note({ uin: row.userId, name: row.name, text: body, at: row.at, scope });
      // 每 12 条消息顺手看看有没有人攒够了，攒够了就让模型学一次（内部有门槛，不会频繁炸模型）
      if ((this.seenCount.get(scope) || 0) % 12 === 0) this.people?.sweep(1).catch(() => {});
    } catch (err) {
      this.log.debug(`记画像失败：${err.message}`);
    }
    // 有没有人在直接跟我说话：@ 我 / 引用我的消息 / 私聊
    const replyTarget = replyTargetOf(segs);
    const addressed =
      event.message_type === 'private' ||
      mentionsMe(segs, this.selfId) ||
      Boolean(replyTarget && this.sentIds.has(String(replyTarget)));
    const followMs = Number(this.cfg.chat.followUpWindowMs ?? 5 * 60_000);
    if (addressed && followMs > 0) {
      this.followUps.set(scope, { uin: String(event.user_id), name, since: Date.now(), until: Date.now() + followMs });
    }

    this.seenCount.set(scope, (this.seenCount.get(scope) || 0) + 1);
    this.emitter.emit({ type: 'message', scope, from: name, text: truncate(body, 200), at: Date.now() });

    // ---- 管理指令（私聊或管理员，优先于一切） ----
    if (await this.#tryAdminCommand({ event, scope, body, segs, name })) return;

    // 用展开后的文本判触发：转发里提到关键词也算数（body 仍是原始文本，管理指令不受影响）
    const { trigger, reason } = this.#decideTrigger({ event, scope, segs, body: row.text });
    if (!trigger) {
      this.log.debug(`不回复 ${scope}：${reason}`);
      this.decisions?.record({ scope, kind: 'passive', reason, detail: truncate(body, 40) });
      return;
    }
    await this.#enqueueReply(scope, reason, { event, name });
  }

  async #tryAdminCommand({ event, scope, body, segs, name }) {
    const admins = (this.cfg.chat.admins || []).map(String);
    const isPrivate = event.message_type === 'private';
    const authorized = isPrivate || admins.includes(String(event.user_id));
    if (!authorized) return false;
    const cmd = body.trim();
    if (ADMIN_MUTE.test(cmd)) {
      this.store.setScopeAutochat(scope, false);
      this.log.info(`${name} 让 ${scope} 闭嘴`);
      await this.#sendText(scope, '行，那我先潜水 👀', { quote: event.message_id });
      this.emitter.emit({ type: 'admin', scope, action: 'mute', by: name, at: Date.now() });
      return true;
    }
    if (ADMIN_UNMUTE.test(cmd)) {
      this.store.setScopeAutochat(scope, true);
      this.log.info(`${name} 让 ${scope} 说话`);
      await this.#sendText(scope, '来了来了', { quote: event.message_id });
      this.emitter.emit({ type: 'admin', scope, action: 'unmute', by: name, at: Date.now() });
      return true;
    }
    if (ADMIN_STATUS.test(cmd)) {
      const s = this.status();
      await this.#sendText(
        scope,
        `在线 ${fmtDuration(Date.now() - s.startedAt)}｜群 ${s.groups}｜已回复 ${s.stats.replies} 条｜模型 ${s.llmMode}`,
        { quote: event.message_id },
      );
      return true;
    }
    return false;
  }

  #inQuietHours() {
    const ranges = this.cfg.chat.quietHours || [];
    if (!ranges.length) return false;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const range of ranges) {
      const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(range).trim());
      if (!m) continue;
      const start = Number(m[1]) * 60 + Number(m[2]);
      const end = Number(m[3]) * 60 + Number(m[4]);
      if (start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end) return true;
    }
    return false;
  }

  #decideTrigger({ event, scope, segs, body }) {
    const chat = this.cfg.chat;
    if (!chat.enabled) return { trigger: false, reason: '全局开关关闭' };
    if (!this.store.scopeState(scope).autochat) return { trigger: false, reason: '该会话自动聊天已关闭' };
    // 安静时段只拦「主动骚扰」，被 @ 过来的仍然要回（chat.replyInQuietHours 可改回拦截）
    if (chat.replyInQuietHours !== true && this.#inQuietHours()) {
      return { trigger: false, reason: '免打扰时段' };
    }

    if (event.message_type === 'group') {
      const gid = String(event.group_id);
      if ((chat.muteGroups || []).map(String).includes(gid)) return { trigger: false, reason: '该群被静音' };
      if ((chat.blacklistGroups || []).map(String).includes(gid)) return { trigger: false, reason: '黑名单群' };
      const whitelist = (chat.whitelistGroups || []).map(String);
      if (whitelist.length && !whitelist.includes(gid)) return { trigger: false, reason: '不在白名单' };

      if (chat.replyOnMention && mentionsMe(segs, this.selfId)) return { trigger: true, reason: 'mention' };
      if (chat.replyOnReplyToMe) {
        const target = replyTargetOf(segs);
        if (target && this.sentIds.has(target)) return { trigger: true, reason: 'reply' };
      }
      // 他刚 @ 过我，接着没带 @ 继续说的，也当成在跟我说
      const fu = this.followUps.get(scope);
      if (chat.followUpWithoutAt !== false && fu && fu.uin === String(event.user_id) && Date.now() < fu.until) {
        return { trigger: true, reason: 'followup' };
      }
      for (const kw of chat.keywordTriggers || []) {
        try {
          if (new RegExp(kw, 'i').test(body)) return { trigger: true, reason: `keyword:${kw}` };
        } catch {
          /* 非法正则跳过 */
        }
      }
      // 冷却期内的 @ 仍要响应，随机插话则严格受限
      if (this.#canInterject(scope, event)) return { trigger: true, reason: 'interject' };
      return { trigger: false, reason: '未触发（无 @/回复/关键词）' };
    }

    // 私聊
    if (!chat.replyPrivate) return { trigger: false, reason: '私聊回复已关闭' };
    return { trigger: true, reason: 'private' };
  }

  #canInterject(scope, event) {
    const conf = this.cfg.chat.randomInterject || {};
    const chance = Number(conf.chance || 0);
    if (chance <= 0) return false;
    if ((this.seenCount.get(scope) || 0) < (conf.minMessagesSeen || 1)) return false;
    const last = this.lastInterjectAt.get(scope) || 0;
    if (Date.now() - last < (conf.minGapMs || 0)) return false;
    // 别在别人刚说话就插嘴，也别对很长的消息强行接话
    const msg = plainText(event.message);
    if (msg.length < 2) return false;
    return Math.random() < chance;
  }

  #rateLimited(scope, event) {
    const now = Date.now();
    const chat = this.cfg.chat;
    const userKey = `${scope}:${event.user_id}`;
    if (now - (this.userCooldown.get(userKey) || 0) < (chat.cooldownMsPerUser || 0) && !mentionsMe(event.message, this.selfId)) {
      return '用户冷却中';
    }
    if (now - (this.groupCooldown.get(scope) || 0) < (chat.cooldownMsPerGroup || 0)) return '会话冷却中';
    this.recentReplies = this.recentReplies.filter((t) => now - t < 60_000);
    if (this.recentReplies.length >= (chat.maxRepliesPerMinute || 6)) return '每分钟回复上限';
    return null;
  }

  /**
   * 语气护栏：只拦越线的（骂家人、威胁动手、咒人去死），要求重写一次，仍过线就不说。
   * 普通还嘴（煞笔/滚/有病吧）放行——用户要求「像人一样回怼，可以骂人，只是别敏感」，
   * 护栏管的应该是底线，不是脾气。
   */
  async #toneCheck(texts, scope, base) {
    if (!texts?.length) return texts;
    const hit = (arr) => TONE_GUARD.some((re) => re.test(arr.join(' ')));
    if (!hit(texts)) return texts;
    this.log.info(`${scope} 回复语气过冲，要求重写一次`);
    try {
      const again = await this.brain.generate({
        history: this.#memoryOf(scope),
        ...base,
        customAsk: '这版过线了：不许骂对方家人、不许威胁动手（打你/抽你/扇你/收拾你）、不许咒人去死。保留还嘴的意思，但换成一句干净利落、不带家人和暴力的怼，短一点。',
      });
      const t2 = again.texts || [];
      if (t2.length && !hit(t2)) return t2;
    } catch (err) {
      this.log.warn(`重写失败：${err.message}`);
    }
    return [];
  }

  async #enqueueReply(scope, reason, ctx) {
    const limited = this.#rateLimited(scope, ctx.event);
    if (limited) {
      this.log.debug(`跳过 ${scope}：${limited}`);
      this.decisions?.record({ scope, kind: 'passive', reason: limited, detail: truncate(ctx?.event?.raw_message || '', 40) });
      this.emitter.emit({ type: 'skip', scope, reason: limited, at: Date.now() });
      return;
    }
    const queue = this.queues.get(scope) || { busy: false, pending: null };
    this.queues.set(scope, queue);
    if (queue.busy) {
      // 正在生成：记住最后一次触发，等这轮说完再补一句，避免排队刷屏
      queue.pending = { reason, ctx };
      return;
    }
    queue.busy = true;
    const task = (async () => {
      try {
        await this.#reply(scope, reason, ctx);
        while (queue.pending && !this.stopped) {
          const next = queue.pending;
          queue.pending = null;
          await sleep(400);
          await this.#reply(scope, next.reason, next.ctx);
        }
      } finally {
        queue.busy = false;
        queue.pending = null;
      }
    })();
    this.inflight.add(task);
    task.finally(() => this.inflight.delete(task));
    await task;
  }

  /** 如果这条是「回复我」，把被回复的那句原文取出来（模型看得到上下文，才不会接得莫名其妙） */
  async #quotedText(reason, event) {
    if (reason !== 'reply') return '';
    try {
      const target = replyTargetOf(event.message);
      if (!target) return '';
      const res = await this.onebot.call('get_msg', { message_id: target }, { timeoutMs: 8000 });
      const msg = res?.data || res;
      const segs = msg?.message ?? msg?.raw_message ?? '';
      let text = plainText(segs);
      // 被引用的是合并转发：把里面几条也展开，否则「他引用了[合并转发]」等于没信息
      const fwd = forwardsOf(normalizeMessage(segs));
      if (fwd[0]?.id) {
        const got = await expandForward(this.onebot, fwd[0].id, { maxNodes: 5, maxChars: 400, timeoutMs: 3000 }).catch(() => null);
        if (got) text = text.replace('[合并转发]', got.text);
      }
      if (!text) return '';
      const brief = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5).join(' / ');
      return truncate(brief, 200);
    } catch (err) {
      this.log.debug(`取被回复消息失败：${err.message}`);
      return '';
    }
  }

  /** 我最近在这个会话说过的话 */
  #selfSaid(scope, n = 4) {
    return (this.memory.get(scope) || [])
      .filter((r) => r.role === 'bot')
      .slice(-n)
      .map((r) => String(r.text || ''));
  }

  /**
   * 复读检测：和最近几句高度相似（字符 bigram 相似度 > 阈值）就要求换一种说法重生一次。
   * 换不出来也照发——宁可比不说话好。
   */
  async #dedupeReply(texts, scope, base) {
    if (!Array.isArray(texts) || !texts.length) return texts;
    if (this.cfg.chat.dedupeSelf === false) return texts;
    const prev = this.#selfSaid(scope, this.cfg.chat.recentSelfEcho ?? 5);
    if (!prev.length) return texts;
    const join = (arr) => arr.join(' ');
    if (!prev.some((p) => similarity(join(texts), p) >= (this.cfg.chat.dedupeThreshold ?? 0.72))) return texts;

    this.log.info(`${scope} 这轮回复和刚说过的高度重复，换个说法重来一次`);
    try {
      const again = await this.brain.generate({
        history: this.#memoryOf(scope),
        ...base,
        customAsk: '你最近已经说过几乎一样的话了。换个角度、换个说法再说，别复读自己，也别换汤不换药。',
      });
      if (again.texts?.length && !prev.some((p) => similarity(join(again.texts), p) >= 0.8)) return again.texts;
    } catch (err) {
      this.log.warn(`换说法失败：${err.message}`);
    }
    return texts;
  }

  /**
   * 给人看的「认识的人」三段（名册全量 / 在场详细 / 话里提到的老熟人），具体拼法在 PeopleBook.composeFor。
   * 这里只负责把「谁在场、此刻叫什么、刚说了什么」算清楚。
   */
  #peopleText(scope, event) {
    if (!this.people) return '';
    try {
      const rows = this.#memoryOf(scope) || [];
      const present = [];
      for (const r of [...rows].reverse()) {
        if (r.role === 'bot') continue;
        if (r.userId) present.push(String(r.userId));
        if (present.length >= 3) break;
      }
      if (event?.user_id) present.unshift(String(event.user_id));
      // 同一个 QQ 号在群里现在的显示名：画像是按号存的，不能拿旧昵称去对名字
      const nameOf = new Map();
      for (const r of rows) if (r.userId && r.name) nameOf.set(String(r.userId), String(r.name));
      if (event?.user_id && event?.sender?.card) nameOf.set(String(event.user_id), String(event.sender.card));
      const said = this.#plainOf(event);
      const recent = rows.slice(-6).filter((r) => r.role !== 'bot').map((r) => r.text || '').join(' ');
      return this.people.composeFor({
        present,
        nameOf,
        said,
        recent,
        rosterChars: Number(this.cfg.chat?.people?.rosterChars) || 1400,
        maxFacts: Number(this.cfg.chat?.people?.maxFacts) || 6,
      });
    } catch {
      return '';
    }
  }

  /**
   * 被动回复时的按需联网（用户要求：只在要接住「群友的梗或者问题」时才联网）。
   * 免费门 → 后台小模型判值不值得查 → 搜几条真链接。任何一步失败都按「不查」处理，
   * 不允许把闲聊的回复拖慢——所以这段整体包在 try/catch 里，最坏情况等于没这功能。
   */
  /** 这条消息真正要理解的那句话：去掉开头的 @某某 / [图片] 这类占位 */
  #plainOf(event) {
    const raw = String((event?.message ? plainText(event.message) : '') || event?.raw_message || '').trim();
    return raw.replace(/^(\s*@[^\s@]+|\s*\[[^\]]+\])+/u, '').trim();
  }

  async #webLookup(scope, event) {
    const cfg = this.cfg.chat?.webSearch;
    if (!cfg || cfg.enabled === false || this.stopped) return '';
    const text = this.#plainOf(event);
    if (!text) return '';
    try {
      const hit = await lookupIfNeeded(text, { cfg, log: this.log });
      if (!hit) return '';
      this.log.info(`${scope} 为接这句话联网查了「${hit.query}」`);
      this.emitter.emit({ type: 'search', scope, query: hit.query, at: Date.now() });
      return hit.block;
    } catch (err) {
      this.log.debug(`联网查失败，按不查处理：${err.message}`);
      return '';
    }
  }

  async #reply(scope, reason, ctx) {
    const { event, name } = ctx;
    const { type, id } = scopeKey(scope);
    const group = type === 'group' ? this.groups.get(String(id)) : null;
    const scopeLabel = type === 'group' ? `QQ 群「${group?.group_name || id}」` : `和「${name}」的私聊`;
    const groupInfo = group ? `群号 ${id}，${group.member_count ?? '?'} 人` : '';

    this.log.info(`回复 ${scope}（${reason}）`);
    this.emitter.emit({ type: 'thinking', scope, reason, at: Date.now() });

    // 群友让它画东西：真画一张。一张要一两分钟，所以先回句话、画完再单独发图，别把回复卡死
    if (await this.#maybeDraw(scope, event, reason)) return;

    let texts;
    try {
      const summary = this.scopeMemory?.load?.(scope)?.summary || '';
      const quotedText = await this.#quotedText(reason, event);
      const peopleText = this.#peopleText(scope, event);
      const webText = await this.#webLookup(scope, event);
      // 自主学习攒的笔记：字面检索 + 语义召回融合，硬预算 350ms，超时就用字面结果
      const learnText =
        (await this.learn?.renderForSmart?.({
          scope,
          context: this.#plainOf(event),
          budget: Number(this.cfg.chat?.learn?.budget) || 520,
          timeBudget: 350,
        })) ||
        this.learn?.renderFor?.({
          scope,
          context: this.#plainOf(event),
          budget: Number(this.cfg.chat?.learn?.budget) || 520,
        }) ||
        '';
      const followUp = this.followUps.get(scope) || null;
      const base = {
        scopeLabel,
        groupInfo,
        triggerReason: reason,
        memoryText: summary,
        quotedText,
        peopleText,
        webText,
        learnText,
        followUp,
        // 视频补话这类「同一件事的收尾」自带指令，可以覆盖默认的接话要求
        customAsk: ctx.customAsk || '',
        // 最近几条消息里的图：让模型真的看见画面，而不是只读到「[发了一张图]」
        images: await this.#visionImages(scope),
      };
      ctx.media = base.images;
      const result = await this.brain.generate({ history: this.#memoryOf(scope), ...base });
      // 被动消息也由模型自己决定接不接：它输出 <skip> 理由 就闭嘴
      // @我 / 引用我 / 私聊 这三种是「必要回的」，不给模型装死的机会；其余类型才允许它自己判断
      // 视频看完了要补话：这条是「同一件事的后续」，别让它自己判成不用回
      const 必回 = new Set([...(this.cfg.chat?.aiDecideMandatory || ['mention', 'reply', 'private']), 'video-ready']);
      const 可略过 = this.cfg.chat?.aiDecide !== false && !必回.has(reason);
      const verdict = 可略过 ? parseSkip((result.texts || []).join('\n')) : null;
      if (verdict) {
        this.log.info(`${scope} 模型判断不用回：${verdict.reason}`);
        this.decisions?.record({ scope, kind: 'passive', reason: '模型自己判断不用回', detail: verdict.reason, acted: false });
        this.emitter.emit({ type: 'skip', scope, reason: 'model-skip', detail: verdict.reason, at: Date.now() });
        return;
      }
      texts = await this.#dedupeReply(result.texts || [], scope, base);
      texts = await this.#toneCheck(texts, scope, base);
      if (!texts.length) {
        this.decisions?.record({ scope, kind: 'passive', reason: '语气过冲，没说', acted: false });
        this.emitter.emit({ type: 'skip', scope, reason: 'tone-guard', at: Date.now() });
      }
    } catch (err) {
      this.log.error(`模型生成失败：${err.message}`);
      this.emitter.emit({ type: 'error', scope, error: err.message, at: Date.now() });
      return;
    }
    if (!texts?.length) return;

    const quote =
      reason === 'mention' || reason === 'reply' || reason === 'private' || reason === 'followup'
        ? event.message_id
        : null;

    // 模型可以「说一句 + 配一张图」：正文后面另起一行 <meme>关键词</meme>；
    // 也可以整条只甩一张图（正文为空）。
    const wish = splitMemeWish(texts.join('\n'));
    const picked = wish.keyword && this.memes ? this.memes.pick(wish.keyword) : null;
    if (wish.keyword && !picked) this.log.info(`${scope} 图库里没「${wish.keyword}」，这条不配图`);

    // 纯表情包：整条只有一张图
    if (picked && !wish.text) {
      const id = await this.sendImage(scope, picked.file, { quote, caption: picked.caption });
      if (id != null) {
        this.log.info(`${scope} 回了张表情包：${picked.caption}`);
        this.emitter.emit({ type: 'sent', scope, meme: picked.caption, messageId: id, at: Date.now() });
        this.decisions?.record({ scope, kind: 'passive', reason: '回了一张表情包', detail: picked.caption, acted: true });
        this.#afterReply(scope, event, reason);
        return;
      }
      this.log.info('表情包没发出去，改回文字');
    }

    const body = wish.text || (picked ? '' : texts.join('\n'));
    const pieces = this.cfg.chat.splitReplies?.enabled
      ? splitReply(body, this.cfg.chat.splitReplies.maxLen || 60)
      : [body];

    for (let i = 0; i < pieces.length; i += 1) {
      if (this.stopped) return; // 正在退出就不再补发
      const piece = pieces[i];
      await this.#sendText(scope, piece, { quote: i === 0 ? quote : null });
      if (i < pieces.length - 1) {
        await humanPause(Math.max(this.cfg.chat.splitReplies?.pauseMs || 600, piece.length * 45));
      }
    }

    if (picked && wish.text) {
      const id = await this.sendImage(scope, picked.file, { quote: null, caption: picked.caption });
      if (id != null) {
        this.log.info(`${scope} 说完又补了张表情包：${picked.caption}`);
        this.decisions?.record({ scope, kind: 'passive', reason: '回了句话 + 表情包', detail: picked.caption, acted: true });
      }
    }

    this.#afterReply(scope, event, reason);
    this.#maybeVideoFollowUp(scope, ctx);
  }

  /**
   * 视频太大时，第一句回复往往还没下完（会让它老实说没看清）。
   * 这里等后台抽帧完成，再补一句「哦看到了」——同一件事的收尾，不占别的消息。
   */
  #maybeVideoFollowUp(scope, ctx) {
    const cfg = this.cfg.chat?.vision?.video;
    if (!cfg || cfg.enabled === false || cfg.followUp === false || this.stopped) return;
    if (ctx?.customAsk) return; // 补话本身不再补话
    // 只认「这条消息自己带的视频」：否则后面每来一条新消息，都会把历史里的旧视频再补一遍
    let mine = [];
    try {
      mine = videosOf(ctx?.event?.message || []).map((v) => String(v.url || '')).filter(Boolean);
    } catch {
      return;
    }
    if (!mine.length) return;
    const seen = new Set((ctx?.media || []).filter((i) => i?.kind === 'video').map((i) => i.url).filter(Boolean));
    const done = this.videoFollowed.get(scope) || new Set();
    this.videoFollowed.set(scope, done);
    const urls = mine.filter((u) => !seen.has(u) && !done.has(u));
    if (!urls.length) return;
    const url = urls[urls.length - 1];
    const row = this.#memoryOf(scope).find((r) => (r.videos || []).some((v) => String(v.url || '') === url));
    if (!row) return;
    done.add(url);
    if (done.size > 20) done.delete(done.values().next().value);
    const deadline = Date.now() + Number(cfg.followUpMs ?? 120_000);
    const task = (async () => {
      while (!this.stopped && Date.now() < deadline) {
        await sleep(Math.max(1000, Number(cfg.followUpPollMs ?? 3000)));
        const items = await collectMedia([row], this.cfg, { log: this.log });
        const got = items.find((it) => it.kind === 'video' && (!it.url || it.url === url));
        if (!got) continue;
        if (this.queues.get(scope)?.busy) continue; // 正在说别的，等下一轮
        this.log.info(`${scope} 视频画面取到了，补一句`);
        this.emitter.emit({ type: 'video-ready', scope, at: Date.now() });
        const queue = this.queues.get(scope) || { busy: false, pending: null };
        this.queues.set(scope, queue);
        queue.busy = true;
        try {
          await this.#reply(scope, 'video-ready', {
            ...ctx,
            customAsk: `刚才那段视频的画面这次取到了（${got.label}${got.note ? `，${got.note}` : ''}${got.frames?.length > 1 ? `，按时间先后 ${got.frames.length} 帧` : ''}）。你刚才没看到、可能已经跟人说了没看清——现在接着那句话，自然地补一句你看到了什么。说画面里的内容，别提「加载好了/缓存/下载」这些技术词；只补一句，别重复刚才说过的话。`,
          });
        } finally {
          queue.busy = false;
        }
        return;
      }
    })();
    task.catch((err) => this.log.debug(`视频补话失败：${err?.message}`)).finally(() => this.inflight.delete(task));
    this.inflight.add(task);
  }

  /* ---------------------------------------------------------- 画图状态 */

  get drawStatePath() {
    const dir = this.cfg?.storage?.dataDir || 'data';
    return path.join(dir, 'draw-state.json');
  }

  /** 每个会话的画图状态：当天计数 + 上一张图（用于重发/改图） */
  #drawSt(scope) {
    const day = new Date().toISOString().slice(0, 10);
    const st = this.drawState.get(scope) || { day, count: 0, last: 0, lastFile: '', lastPrompt: '', lastAt: 0, drawing: 0, queue: [] };
    if (st.day !== day) {
      st.day = day;
      st.count = 0;
    }
    if (!Number.isFinite(st.drawing)) st.drawing = 0;
    if (!Array.isArray(st.queue)) st.queue = [];
    return st;
  }

  #saveDrawState() {
    try {
      const obj = {};
      for (const [scope, st] of this.drawState) obj[scope] = st;
      fs.mkdirSync(path.dirname(this.drawStatePath), { recursive: true });
      fs.writeFileSync(this.drawStatePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      this.log.warn(`画图状态没存住：${err.message}`);
    }
  }

  #loadDrawState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.drawStatePath, 'utf8'));
      for (const [scope, st] of Object.entries(raw || {})) {
        if (!st || typeof st !== 'object') continue;
        this.drawState.set(scope, { count: 0, last: 0, lastFile: '', lastPrompt: '', lastAt: 0, drawing: 0, ...st });
      }
    } catch {
      /* 第一次跑或文件坏了，无所谓 */
    }
  }

  /** 只留这个会话最近两张图，别把磁盘堆满 */
  #pruneDraw(dir, scope) {
    try {
      const mark = String(scope).replace(/[^\w]+/g, '_');
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${mark}-`))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(2)) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* 清理失败不影响画图 */
    }
  }

  /**
   * 「画一张 XX」：识别 → 限流 → 先回一句 → 后台真画 → 画完发图。
   * 返回 true 表示这条消息已经被画图接管，不要再走普通回复。
   */
  async #maybeDraw(scope, event, reason) {
    const cfg = this.cfg.chat?.draw;
    if (!cfg || cfg.enabled === false || this.stopped) return false;
    if (this.cfg.image?.enabled === false) return false;
    // 只接「对着它说的」：插话、关键词触发这种它自己凑上来的场合不画
    if (!['mention', 'reply', 'private', 'followup'].includes(reason)) return false;
    const text = this.#plainOf(event);
    if (!text) return false;

    const now = Date.now();
    const st = this.#drawSt(scope);
    const hasLast = Boolean(st.lastFile) && fs.existsSync(st.lastFile);
    const ageMin = st.lastAt ? Math.round((now - st.lastAt) / 60000) : -1;
    const quote0 = ['mention', 'reply', 'private'].includes(reason) ? event.message_id : null;

    // ① 图过期/没收到/让它再发一遍：直接把上一张重发，不用重画（重画要一两分钟）
    if (hasLast && !st.drawing && wantsResend(text) && now - st.lastAt < 6 * 3600_000) {
      const id = await this.sendImage(scope, st.lastFile, { quote: quote0 });
      if (id != null) {
        this.log.info(`${scope} 重发了 ${ageMin} 分钟前那张图`);
        this.emitter.emit({ type: 'sent', scope, draw: st.lastPrompt, messageId: id, at: Date.now() });
        this.decisions?.record({ scope, kind: 'passive', reason: '重发上一张图', detail: text.slice(0, 40), acted: true });
        this.#afterReply(scope, event, reason);
        return true;
      }
    }

    // ② 在催进度：如实说，别让它自己编「显卡在算」
    if (wantsWait(text) && !/(画一张|画个|画一个|帮我画|给我画|画一幅)/.test(text)) {
      if (st.drawing > 0) {
        const secs = Math.max(1, Math.round((now - (st.drawingSince || now)) / 1000));
        await this.#sendText(scope, `还在画，已经 ${secs} 秒了`, { quote: quote0 });
      } else if (hasLast) {
        await this.#sendText(scope, `这轮没在画——上一张是 ${ageMin} 分钟前发的那张，要改还是重发？`, { quote: quote0 });
      } else {
        await this.#sendText(scope, '这轮没在画，要画的话说一句画什么', { quote: quote0 });
      }
      this.#afterReply(scope, event, reason);
      return true;
    }

    // ③ 对上一张不满意 → 带着上一版提示词去改，而不是从零重编一个场景
    const previous = hasLast && wantsRedraw(text) ? st.lastPrompt : '';
    if (!wantsDraw(text) && !previous) return false;

    const maxPerDay = Number(cfg.maxPerDay) || 12;
    if (st.count >= maxPerDay) {
      this.log.info(`${scope} 今天画够 ${maxPerDay} 张了，如实回一句`);
      await this.#sendText(scope, `今天已经画了 ${st.count} 张，额度用完了，明天再画`, { quote: event.message_id });
      this.#afterReply(scope, event, reason);
      return true;
    }
    // 手上还有一张在画：不拒绝，排到队尾，画完接着画
    if (st.drawing > 0) {
      if (st.queue.length >= 3) {
        await this.#sendText(scope, '手上这张还在画，后面排的也够多了，这波画完再说', { quote: event.message_id });
      } else {
        st.queue.push(text);
        this.drawState.set(scope, st);
        this.#saveDrawState();
        await this.#sendText(scope, `手上这张还在画，排上了（前面还有 ${st.queue.length} 张）`, { quote: event.message_id });
        this.log.info(`${scope} 画图排队：${text.slice(0, 30)}（队列 ${st.queue.length}）`);
      }
      this.#afterReply(scope, event, reason);
      return true;
    }
    // 间隔默认 0（不限）：画一张本来就要一两分钟，冷却只会让用户觉得「没画出来」
    const gap = Number(cfg.minIntervalMs) || 0;
    if (gap > 0 && now - (st.last || 0) < gap) {
      this.log.info(`${scope} 刚画过，配置的间隔还没过（${Math.round(gap / 1000)}s），先不给画`);
      await this.#sendText(scope, '刚画完一张，喘口气再画', { quote: event.message_id });
      this.#afterReply(scope, event, reason);
      return true;
    }
    st.last = now;
    st.count += 1;
    st.drawing += 1;
    st.drawingSince = now;
    this.drawState.set(scope, st);
    this.#saveDrawState();

    const quote = quote0;
    const line = previous
      ? ['行，按你说的改', '改着呢，等会儿', '收到，重画'][Math.floor(Math.random() * 3)]
      : ['行，画着呢', '等我几分钟', '画着，别催', '这就画', '画一会儿'][Math.floor(Math.random() * 5)];
    await this.#sendText(scope, line, { quote });
    this.emitter.emit({ type: 'drawing', scope, text, at: Date.now() });
    this.decisions?.record({ scope, kind: 'passive', reason: previous ? '按上一张改图' : '画一张图', detail: text.slice(0, 60), acted: true });
    void this.#drawAndSend(scope, text, { size: cfg.size, previous });
    this.#afterReply(scope, event, reason);
    return true;
  }

  /** 真去画并发送；全程自己兜错，绝不把异常抛到消息循环里 */
  async #drawAndSend(scope, text, { size = '', previous = '' } = {}) {
    let file = null;
    try {
      const context = (this.#memoryOf(scope) || [])
        .filter((r) => r.role !== 'bot')
        .slice(-4)
        .map((r) => `${r.name || '群友'}：${truncate(String(r.text || ''), 40)}`)
        .join('\n');
      const said = drawPromptOf(text);
      const refined = await refinePrompt(this.brain, said, { context, previous, cfg: this.cfg, log: this.log });
      if (refined.refined && refined.prompt !== said) {
        this.log.info(`副脑改写了画图描述：${said.slice(0, 40)} → ${refined.prompt.slice(0, 60)}`);
        if (refined.appended?.length) this.log.warn(`副脑补上了漏掉的要素：${refined.appended.join('、')}`);
      }
      if (!refined.refined) this.log.warn(`副脑这次没用上（${this.cfg.image?.promptBrain?.enabled === false ? '已关' : '调用失败'}），照原句画：${said.slice(0, 40)}`);
      const prompt = refined.prompt || said;
      const img = await generateImage(prompt, {
        cfg: this.cfg,
        dataDir: this.cfg.storage?.dataDir || 'data',
        size,
        log: this.log,
      });
      file = img.file;
      // 存一份到 data/draw/：用户常隔一会儿说「图片过期了，重发」，重画要一两分钟，重发是秒级
      try {
        const keepDir = path.join(this.cfg.storage?.dataDir || 'data', 'draw');
        fs.mkdirSync(keepDir, { recursive: true });
        const mark = String(scope).replace(/[^\w]+/g, '_');
        const keep = path.join(keepDir, `${mark}-${Date.now()}.png`);
        fs.copyFileSync(img.file, keep);
        const st = this.#drawSt(scope);
        st.lastFile = keep;
        st.lastPrompt = img.prompt;
        st.lastAt = Date.now();
        this.#pruneDraw(keepDir, scope);
        this.#saveDrawState();
      } catch (err) {
        this.log.warn(`图存不下来（不影响发送）：${err.message}`);
      }
      const id = await this.sendImage(scope, img.file);
      if (id != null) {
        this.log.info(`${scope} 画完发出去了：${img.prompt.slice(0, 40)}（${Math.round(img.ms / 1000)}s）`);
        this.emitter.emit({ type: 'sent', scope, draw: img.prompt, messageId: id, at: Date.now() });
        this.store.append(scope, { role: 'bot', name: this.personaName, text: `[画了一张图：${img.prompt.slice(0, 40)}]`, media: [{ url: '' }] });
      } else {
        this.log.warn(`${scope} 画好了但没发出去`);
      }
    } catch (err) {
      this.log.warn(`画图失败：${err.message}`);
      this.emitter.emit({ type: 'error', scope, error: `画图失败：${err.message}`, at: Date.now() });
      const blocked = /moderation_blocked|safety|违反|拒绝/i.test(err.message);
      const line = blocked
        ? '这个描述被生图的安全审核拦了（真人/擦边容易被拦），换个说法我再试'
        : '画崩了，模型今天不给力';
      await this.#sendText(scope, line, {}).catch(() => {});
    } finally {
      if (file) fs.rmSync(file, { force: true });
      const st = this.#drawSt(scope);
      st.drawing = Math.max(0, (st.drawing || 1) - 1);
      st.drawingSince = st.drawing > 0 ? st.drawingSince : 0;
      // 有人在这张画的时候又点了图：画完接着画下一张
      const next = st.drawing === 0 && st.queue.length ? st.queue.shift() : '';
      if (next) {
        st.count += 1;
        st.last = Date.now();
        st.drawing += 1;
        st.drawingSince = Date.now();
      }
      this.drawState.set(scope, st);
      this.#saveDrawState();
      if (next) {
        this.log.info(`${scope} 接着画排队那张：${next.slice(0, 30)}`);
        void this.#sendText(scope, '这张画完了，接着画你刚才说的那张', {}).catch(() => {});
        void this.#drawAndSend(scope, next, { size: this.cfg.chat?.draw?.size });
      }
    }
  }

  /** 一轮回复结束后的记账（冷却、计数、插话时间戳） */
  #afterReply(scope, event, reason) {
    this.store.bumpScopeReplies(scope);
    this.userCooldown.set(`${scope}:${event.user_id}`, Date.now());
    this.groupCooldown.set(scope, Date.now());
    this.recentReplies.push(Date.now());
    if (reason === 'interject') this.lastInterjectAt.set(scope, Date.now());
  }

  /* -------------------------------------------------------------- 发送 */

  buildSegments(content, { quote } = {}) {
    const segs = Array.isArray(content) ? [...content] : [text(String(content))];
    if (quote) segs.unshift(reply(quote));
    return segs;
  }

  /** 发一段文本（自动转义成消息段）；返回 message_id */
  async #sendText(scope, content, { quote } = {}) {
    const segs = this.buildSegments(content, { quote });
    const scopeParts = scopeKey(scope);
    const isGroup = scopeParts.type === 'group';
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = isGroup ? { group_id: scopeParts.id, message: segs } : { user_id: scopeParts.id, message: segs };
    const data = await this.onebot.call(action, params).catch((err) => {
      this.log.error(`发送失败（${scope}）：${err.message}`);
      this.emitter.emit({ type: 'error', scope, error: err.message, at: Date.now() });
      return null;
    });
    if (!data) return null;
    const messageId = data?.message_id ?? data?.messageId;
    if (messageId != null) {
      const key = String(messageId);
      this.sentIds.add(key);
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
    }
    const row = { role: 'bot', name: this.personaName, text: String(content), messageId: messageId != null ? String(messageId) : '', scope };
    this.store.append(scope, row);
    const mem = this.#memoryOf(scope);
    mem.push(row);

    this.emitter.emit({
      type: 'sent',
      scope,
      text: truncate(String(content), 300),
      messageId: messageId != null ? String(messageId) : null,
      at: Date.now(),
    });
    return messageId ?? null;
  }

  /** 供控制台/CLI/MCP 调用：发消息（可带引用），返回 message_id */
  /** 群里最近甩过的推特链接（给 agent 看的） */
  recentTweetLinks(scope, limit = 3) {
    const list = this.tweetLinks.get(String(scope)) || [];
    const fresh = list.filter((it) => Date.now() - it.at < 2 * 60 * 60_000);
    return fresh.slice(-limit);
  }

  /** 群里最近甩过的小红书笔记链接（给 agent 看的） */
  recentXhsLinks(scope, limit = 2) {
    const list = this.xhsLinks.get(String(scope)) || [];
    const fresh = list.filter((it) => Date.now() - it.at < 2 * 60 * 60_000);
    return fresh.slice(-limit);
  }

  /** 发一张图片（表情包）：图片转 base64 走 OneBot，容器里也能读。 */
  async sendImage(scopeInput, filePath, { quote = null, caption = '' } = {}) {
    const key = typeof scopeInput === 'string' ? scopeInput : scopeInput?.key;
    if (!key) throw new Error('sendImage 需要一个会话');
    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch (err) {
      this.log.warn(`读不到图片 ${filePath}：${err.message}`);
      return null;
    }
    const segs = [];
    if (quote) segs.push(reply(quote));
    segs.push(image(`base64://${buf.toString('base64')}`));
    const parts = scopeKey(key);
    const isGroup = parts.type === 'group';
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = isGroup ? { group_id: parts.id, message: segs } : { user_id: parts.id, message: segs };
    // 大图（一两 MB 的 base64）走本地上传，30s 默认超时不够，这类动作给足 2 分钟
    const data = await this.onebot.call(action, params, { timeoutMs: 120000 }).catch((err) => {
      this.log.error(`发图失败（${key}）：${err.message}`);
      this.emitter.emit({ type: 'error', scope: key, error: err.message, at: Date.now() });
      return null;
    });
    if (!data) return null;
    const messageId = data?.message_id ?? data?.messageId;
    if (messageId != null) {
      const id = String(messageId);
      this.sentIds.add(id);
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
    }
    const label = caption ? `[表情: ${caption}]` : '[表情]';
    const row = { role: 'bot', name: this.personaName, text: label, messageId: messageId != null ? String(messageId) : '', scope: key };
    this.store.append(key, row);
    this.#memoryOf(key).push(row);
    this.emitter.emit({ type: 'sent', scope: key, text: label, messageId: messageId != null ? String(messageId) : null, at: Date.now() });
    return messageId ?? null;
  }

  /** 发一段视频（base64 直传，发完由调用方删原件） */
  async sendVideo(scopeInput, filePath, { quote = null, caption = '', maxBytes = 40 * 1024 * 1024 } = {}) {
    const key = typeof scopeInput === 'string' ? scopeInput : scopeInput?.key;
    if (!key) throw new Error('sendVideo 需要一个会话');
    let buf;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > maxBytes) throw new Error(`视频 ${(stat.size / 1048576).toFixed(1)}MB 太大`);
      buf = fs.readFileSync(filePath);
    } catch (err) {
      this.log.warn(`读不到视频 ${filePath}：${err.message}`);
      return null;
    }
    const segs = [];
    if (quote) segs.push(reply(quote));
    segs.push(video(`base64://${buf.toString('base64')}`));
    const parts = scopeKey(key);
    const isGroup = parts.type === 'group';
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = isGroup ? { group_id: parts.id, message: segs } : { user_id: parts.id, message: segs };
    const data = await this.onebot.call(action, params, { timeoutMs: 120_000 }).catch((err) => {
      this.log.error(`发视频失败（${key}）：${err.message}`);
      this.emitter.emit({ type: 'error', scope: key, error: err.message, at: Date.now() });
      return null;
    });
    if (!data) return null;
    const messageId = data?.message_id ?? data?.messageId;
    if (messageId != null) {
      const id = String(messageId);
      this.sentIds.add(id);
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
    }
    const label = caption ? `[视频: ${caption}]` : '[视频]';
    const row = { role: 'bot', name: this.personaName, text: label, messageId: messageId != null ? String(messageId) : '', scope: key };
    this.store.append(key, row);
    this.#memoryOf(key).push(row);
    this.emitter.emit({ type: 'sent', scope: key, text: label, messageId: row.messageId, at: Date.now() });
    return messageId ?? null;
  }

  async send(scopeInput, content, { quote } = {}) {
    const { key } = scopeKey(scopeInput);
    return this.#sendText(key, content, { quote });
  }

  async sendAt(scope, segmentList) {
    const { key, type, id } = scopeKey(scope);
    const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = type === 'group' ? { group_id: id, message: segmentList } : { user_id: id, message: segmentList };
    const data = await this.onebot.call(action, params);
    const messageId = data?.message_id ?? data?.messageId ?? null;
    if (messageId != null) this.sentIds.add(String(messageId));
    this.store.append(key, { role: 'bot', name: this.personaName, text: plainText(segmentList), messageId: messageId != null ? String(messageId) : '' });
    return messageId;
  }

  recent(scope, limit = 20) {
    return this.store.tail(scopeKey(scope).key, limit);
  }

  setAutochat(scope, enabled) {
    return this.store.setScopeAutochat(scopeKey(scope).key, enabled);
  }

  /** 拼一条 @ 某人的消息 */
  mentionSegment(qq, name) {
    return at(qq, name);
  }

  status() {
    return {
      selfId: this.selfId,
      nickname: this.nickname,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      groups: this.groups.size,
      llmMode: this.brain.mode,
      model: this.cfg.llm.model,
      persona: this.personaName,
      transport: { ...this.onebot.state },
      stats: { ...this.store.state.stats },
      autochat: this.cfg.chat.enabled,
      scopes: this.store.listScopes().slice(0, 50),
    };
  }
}

/** 从一段文字里抠出小红书笔记链接（explore / discovery/item / xhslink 短链） */
export function extractXhsLinks(text) {
  const out = [];
  const re = /https?:\/\/(?:www\.)?(?:xiaohongshu\.com\/(?:explore|discovery\/item|note)\/[0-9a-f]{20,32}|xhslink\.com\/[A-Za-z0-9]+)/gi;
  for (const m of String(text || '').matchAll(re)) {
    const url = m[0].replace(/[).,，。]+$/, '');
    if (!out.includes(url)) out.push(url);
    if (out.length >= 3) break;
  }
  return out;
}

/** 从一段文字里抠出推特/X 的推文链接（去重，最多 3 条） */
export function extractTweetLinks(text) {
  const out = [];
  const re = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s"'<>]*?\/status(?:es)?\/\d{5,25}/gi;
  for (const m of String(text || '').matchAll(re)) {
    const url = m[0].replace(/[).,，。]+$/, '');
    if (!out.includes(url)) out.push(url);
    if (out.length >= 3) break;
  }
  return out;
}
