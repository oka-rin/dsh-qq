import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.mjs';
import { DAILY_NEWS_DEFAULTS } from './daily-news.mjs';

export const DEFAULTS = {
  onebot: {
    httpUrl: 'http://127.0.0.1:3000',
    // SnowLuma 的 WS 同时接受 / 与 /event；默认走 /event
    wsUrl: 'ws://127.0.0.1:3001/event',
    accessToken: '',
    wsAccessToken: '',
    selfId: 0,
  },
  control: { host: '127.0.0.1', port: 8787, token: '' },
  llm: {
    mode: 'api',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKey: '',
    temperature: 1.1,
    // 可选：{ chat: 0.95, agent: 0.7, background: 0.6 }，按用途覆盖 temperature
    temperatures: {},
    maxTokens: 400,
    timeoutMs: 60000,
    // 蒸馏（学习总结、相处总结、写笔记）只认一个模型：llm.background.model。
    // 接口地址留空就跟主接口共用，密钥留空就用主接口的 key；连不上会自动退回主模型重试一次。
    background: {
      baseUrl: '',
      model: '',
      keyEnv: '',
      apiKey: '',
    },
  },
  persona: {
    name: '小雪花',
    identity: '一个混在群里的普通群友',
    style: '说话短、口语化，像真人打字；不用 Markdown、不列条目。',
    likes: [],
    rules: ['一次只说 1~2 句'],
  },
  chat: {
    enabled: true,
    replyPrivate: true,
    replyOnMention: true,
    replyOnReplyToMe: true,
    keywordTriggers: [],
    randomInterject: { chance: 0, minGapMs: 600000, minMessagesSeen: 6 },
    cooldownMsPerUser: 8000,
    cooldownMsPerGroup: 3000,
    maxRepliesPerMinute: 6,
    historyTurns: 24,
    quietHours: [],
    admins: [],
    ignoreSelf: true,
    whitelistGroups: [],
    blacklistGroups: [],
    muteGroups: [],
    splitReplies: { enabled: true, maxLen: 60, pauseMs: 900 },
    maxReplyChars: 300,
    // 看图：把最近消息里的图片抓成 data URL 一起发给模型（llm.models.chat 必须是能看图的模型）。
    // maxImages 每轮上限（多张图很吃 token），maxBytes 单张上限，超了就不看。
    vision: {
      enabled: true,
      maxImages: 3,
      maxBytes: 8000000,
      timeoutMs: 12000,
      // 动图（gif / 动态 webp / apng）：用 ffmpeg 均匀抽帧，一帧算一张图
      gif: { enabled: true, maxFrames: 3 },
      // 视频：先下到临时文件再抽关键帧，不把整段视频塞给模型；maxBytes 是下载体积上限
      video: {
        enabled: true,
        maxVideos: 1,
        maxFrames: 4,
        maxBytes: 60000000,
        width: 640,
        // 下载 4K 原片很慢（40MB 级常见），和抽帧分开计时
        downloadTimeoutMs: 60000,
        timeoutMs: 25000,
        // 视频还没抽完时，回复最多等多久（等不到就先不看）
        waitMs: 15000,
        // 下完抽帧以后补一句「哦看到了」，别让人以为它一直没看
        followUp: true,
        followUpMs: 120000,
      },
      // 合并转发：get_forward_msg 现场展开成「谁：说了什么」；maxNodes/maxChars 防止长记录撑爆上下文
      forward: { enabled: true, maxNodes: 12, maxChars: 1200, timeoutMs: 4000 },
      // 一轮最多送多少帧（静态图算 1 帧，动图/视频算实际抽的帧数），防止一条视频挤掉其他图
      totalFrames: 8,
    },
    // 被动回复按需联网：只在「要接住的问题 / 不认识的梗」上查一次外网，其余一律不查。
    // 先过 wantsLookup 的免费门，再让后台小模型判值不值得查，最后 searchWeb（必应 → 360 兜底）。
    webSearch: { enabled: true, timeoutMs: 4000, maxResults: 4 },
    // 被动生图：群友让它画东西、或它自己想画时，真画一张发出去（一张要一两分钟）
    draw: { enabled: true, maxPerDay: 12, minIntervalMs: 0, size: '1024x1024' },
    // 认识的人：名册全量注入（人多了也不能忘了前面认识谁），rosterChars 是名册字符预算
    people: { rosterChars: 1400, maxFacts: 6 },
    // QQ 空间社交：回评自己说说下的评论、评论好友的说说。
    // 评论发出去撤不回（桥接没有删评论的接口），所以上限和间隔都压在代码里，不指望模型自觉。
    qzone: {
      enabled: true,
      // 指向我的评论「必回」：不拿额度和间隔拦（安静时段仍然生效，晚上来的评论第二天早上回）
      alwaysReply: true,
      replyEveryMinutes: 5, // 每隔几分钟看一眼有没有新评论要回（0 = 不自动，只靠主动轮次）
      replyPerDay: 6, // alwaysReply=false 时才生效
      commentPerDay: 2, // 每天最多去别人说说下评几条（低一点，像人不像刷子）
      minGapMs: 1800000, // 两次评论之间至少隔 30 分钟（回复不受它限制）
      quietHours: ['23:30-08:30'],
      dryRun: false,
    },
    // 自主学习：定时把群聊和网上资讯蒸馏成短笔记，回话/分享/说说时按语境带上几条
    learn: {
      enabled: true,
      everyHours: 6,
      minLines: 20,
      budget: 520,
      maxNotes: 600,
      // 语义检索（阿里云百炼 OpenAI 兼容 /embeddings）：挂了就自动退回字面检索
      embedding: {
        enabled: false,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        // 百炼计价：flash 0.000125 元/千token，v4/v3 是 0.0005（贵 4 倍）；batch 上限 20
        model: 'qwen3.7-text-embedding-flash',
        dims: 1024,
        keyEnv: 'DASHSCOPE_API_KEY',
        apiKey: '',
        timeoutMs: 20000,
        batch: 20,
      },
    },
      memeCollect: { enabled: true, maxPerDay: 8, minIntervalMs: 30000, maxBytes: 8000000 },
  },
  // 生图（OpenAI 兼容 /images/generations）：QQ 机器人自己画图发出去
  image: {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    size: '1024x1024',
    quality: '',
    keyEnv: 'IMAGE_API_KEY',
    apiKey: '',
    timeoutMs: 240000,
    // 副脑：画之前先把口语需求变成不跑偏的提示词（抽要素→写词→缺了补）
    promptBrain: {
      enabled: true,
      model: '',
      purpose: 'chat',
      timeoutMs: 15000,
      maxChars: 500,
      repair: true,
    },
  },
  dailyNews: { ...DAILY_NEWS_DEFAULTS },
  storage: { dataDir: './data' },
};

/** 深合并：只合并普通对象，数组与标量直接覆盖 */
export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(b ?? {}, v) : v;
  }
  return out;
}

export function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [
    process.env.QQ_CONFIG,
    path.resolve('config.json'),
    path.resolve('config.local.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function loadConfig({ configPath, overrides } = {}) {
  const file = resolveConfigPath(configPath);
  const baseDir = file ? path.dirname(file) : process.cwd();
  const raw = file ? readJson(file, {}) : {};
  let cfg = deepMerge(DEFAULTS, raw);

  // 环境变量覆盖（方便在不同机器上复用同一份 config.json）
  if (process.env.QQ_ONEBOT_HTTP) cfg.onebot.httpUrl = process.env.QQ_ONEBOT_HTTP;
  if (process.env.QQ_ONEBOT_WS) cfg.onebot.wsUrl = process.env.QQ_ONEBOT_WS;
  if (process.env.QQ_ONEBOT_TOKEN) cfg.onebot.accessToken = process.env.QQ_ONEBOT_TOKEN;
  if (process.env.QQ_CONTROL_PORT) cfg.control.port = Number(process.env.QQ_CONTROL_PORT);
  if (process.env.QQ_CONTROL_TOKEN) cfg.control.token = process.env.QQ_CONTROL_TOKEN;
  if (process.env.QQ_LLM_MODEL) cfg.llm.model = process.env.QQ_LLM_MODEL;
  if (process.env.QQ_LLM_BASE_URL) cfg.llm.baseUrl = process.env.QQ_LLM_BASE_URL;

  if (overrides) cfg = deepMerge(cfg, overrides);

  // 相对路径统一相对于配置文件所在目录
  cfg.storage.dataDir = path.resolve(baseDir, cfg.storage.dataDir);
  cfg.onebot.httpUrl = cfg.onebot.httpUrl.replace(/\/+$/, '');
  cfg.__configPath = file;
  cfg.__baseDir = baseDir;
  return cfg;
}

/** 生图用的 key：image.apiKey 优先，其次 image.keyEnv 指向的环境变量 */
export function imageKeyOf(cfg) {
  const c = cfg?.image || {};
  if (c.apiKey) return c.apiKey;
  const envName = c.keyEnv || 'IMAGE_API_KEY';
  const v = envName ? process.env[envName] : undefined;
  if (!v) throw new Error(`没有生图 API Key：请设置环境变量 ${envName}，或在 config.json 的 image.apiKey 填写`);
  return v;
}

export function apiKeyOf(cfg) {
  if (cfg.llm.apiKey) return cfg.llm.apiKey;
  const envName = cfg.llm.apiKeyEnv;
  return envName ? process.env[envName] : undefined;
}
