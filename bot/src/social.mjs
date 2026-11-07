/**
 * 视频社交：让机器人自己刷 B站，看评论，决定要不要点赞、评论、回评。
 *
 * 为什么单独一个模块：
 *   · 评论是公开发言、撤不回来（B站能删，但删了也有痕迹），所以额度、间隔、
 *     安静时段、敏感内容这些护栏必须写死在代码里，不能指望模型自觉；
 *   · B站能用匿名 + 扫码登录纯 HTTP 全功能跑通：热门、搜索、关注动态、详情、
 *     评论（匿名可读）、点赞、发评论、楼中楼回复。
 *
 * B站实测（2026-11，香港机房 IP，全部通过）：
 *   · 热门：/x/web-interface/popular
 *   · 搜索：/x/web-interface/search/type?search_type=video
 *   · 关注动态：/x/polymer/web-dynamic/v1/feed/all?type=video（要登录）
 *   · 详情：/x/web-interface/view?aid=|bvid=
 *   · 评论：/x/v2/reply?type=1&oid=<aid>（匿名可读）
 *   · 扫码登录：passport qrcode/generate + qrcode/poll
 *   · 发评论：POST /x/v2/reply/add（要 SESSDATA + csrf=bili_jct）
 *   · 点赞：  POST /x/web-interface/archive/like（同上）
 *
 * 抖音没有接：网页接口从机房 IP 会被 Argus 拦（Uifid Not Found / 4031 安全风险），
 * 连扫码登录页都进不去，a_bogus 签名也绕不过；要先有住宅 IP 或浏览器 cookie 才有谈的余地。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './util.mjs';
import { inQuiet } from './qzone.mjs';
import { abstractRule } from './brain.mjs';

const UA =
  process.env.QQ_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

/** 不碰的内容：评论发出去就是公开的，宁可少说一句 */
const SENSITIVE =
  /(?:习近平|政治局|共产党|六四|法轮|台独|港独|翻墙被抓|色情|裸|约炮|赌博|博彩|外围|毒品|冰毒|大麻|自杀|跳楼|杀了他|砍死|枪|炸弹|洗钱|诈骗|代开|发票|枪支)/i;

/** 广告/引流，不评 */
const AD_WORDS = /(?:加微信|加V|代购|返利|优惠券|兼职|刷单|私信我|点击链接)/i;

const dayKey = (d = new Date()) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const a = [...t];
  return a.length > n ? `${a.slice(0, n).join('')}…` : t;
};

/** 把 /x/... 返回里的 <em class="keyword"> 高亮标签去掉 */
const stripEm = (s) => String(s ?? '').replace(/<[^>]+>/g, '');

class BiliError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
  }
}

const BILI_REFERER = 'https://www.bilibili.com/';

export class BiliClient {
  constructor({ dataDir = 'data', log = createLogger('bili'), fetchImpl = globalThis.fetch, timeoutMs = 15000, cookie = '' } = {}) {
    this.dataDir = dataDir;
    this.log = log;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.file = path.join(dataDir, 'bili-session.json');
    this.state = this.#load();
    if (cookie) this.state.cookie = String(cookie);
    this.buvid = '';
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        cookie: String(raw.cookie || ''),
        name: String(raw.name || ''),
        mid: String(raw.mid || ''),
        savedAt: Number(raw.savedAt) || 0,
      };
    } catch {
      return { cookie: '', name: '', mid: '', savedAt: 0 };
    }
  }

  #save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.log.warn?.(`B站登录态没存上：${err.message}`);
    }
  }

  get cookie() {
    return this.state.cookie || '';
  }

  get loggedIn() {
    return /SESSDATA=/.test(this.cookie);
  }

  setCookie(cookie, { name = '', mid = '' } = {}) {
    this.state = { cookie: String(cookie || ''), name: String(name || this.state.name || ''), mid: String(mid || this.state.mid || ''), savedAt: Date.now() };
    this.#save();
  }

  /** 匿名请求也要 buvid3，否则部分接口会 412 */
  async #buvid() {
    if (this.buvid) return this.buvid;
    try {
      const res = await this.fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'user-agent': UA, referer: BILI_REFERER },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const json = await res.json();
      this.buvid = String(json?.data?.b_3 || '');
    } catch (err) {
      this.log.debug?.(`取 buvid3 失败：${err.message}`);
    }
    return this.buvid;
  }

  async #headers(extra = {}) {
    const parts = [];
    if (this.cookie) parts.push(this.cookie);
    const b3 = await this.#buvid();
    if (b3 && !/buvid3=/.test(this.cookie)) parts.push(`buvid3=${b3}`);
    return {
      'user-agent': UA,
      referer: BILI_REFERER,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(parts.length ? { cookie: parts.join('; ') } : {}),
      ...extra,
    };
  }

  async #call(url, { method = 'GET', form = null, headers = {}, timeoutMs = this.timeoutMs } = {}) {
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const res = await this.fetch(url, {
      method,
      headers: await this.#headers({ ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers }),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new BiliError(`B站 HTTP ${res.status}`, res.status);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BiliError('B站返回的不是 JSON（可能被风控页拦了）', -1);
    }
    if (json?.code !== 0) throw new BiliError(json?.message || `B站接口 code ${json?.code}`, json?.code);
    return json.data;
  }

  /** 扫码登录第一步：拿二维码链接。用户用手机 B站 扫，不是这里轮询 */
  async qrStart() {
    const data = await this.#call('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    return { url: String(data?.url || ''), key: String(data?.qrcode_key || ''), expiresAt: Date.now() + 180_000 };
  }

  /**
   * 轮询扫码结果。
   * code：0 成功 / 86101 未扫码 / 86090 已扫码未确认 / 86038 已失效
   */
  async qrPoll(key) {
    const res = await this.fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`, {
      headers: await this.#headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    const data = json?.data || {};
    const code = Number(data.code);
    if (code !== 0) {
      const status = code === 86101 ? 'waiting' : code === 86090 ? 'scanned' : code === 86038 ? 'expired' : 'error';
      return { status, code, message: String(data.message || json?.message || '') };
    }
    const cookie = this.#cookieFrom(data, res.headers.getSetCookie?.() || []);
    if (!cookie) return { status: 'error', code: 0, message: '登录成功但没拿到 cookie' };
    this.setCookie(cookie);
    const nav = await this.nav().catch(() => ({ loggedIn: false }));
    if (nav?.loggedIn) this.setCookie(cookie, { name: nav.name, mid: nav.mid });
    return { status: 'ok', code: 0, name: nav?.name || '', mid: nav?.mid || '', cookie };
  }

  #cookieFrom(data, setCookies) {
    const jar = new Map();
    for (const line of setCookies) {
      const head = String(line).split(';')[0];
      const i = head.indexOf('=');
      if (i > 0) jar.set(head.slice(0, i).trim(), head.slice(i + 1).trim());
    }
    // poll 成功时 data.url 里也带全套参数，Set-Cookie 有时只给一部分
    try {
      const u = new URL(String(data?.url || ''));
      for (const [k, v] of u.searchParams) jar.set(k, v);
    } catch { /* 没有 url 就只认 Set-Cookie */ }
    const keep = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'sid'];
    const parts = [];
    for (const k of keep) if (jar.get(k)) parts.push(`${k}=${jar.get(k)}`);
    return parts.join('; ');
  }

  async nav() {
    try {
      const data = await this.#call('https://api.bilibili.com/x/web-interface/nav');
      return {
        loggedIn: Boolean(data?.isLogin),
        name: String(data?.uname || ''),
        mid: String(data?.mid || ''),
        level: Number(data?.level) || 0,
        vip: Boolean(data?.vipStatus),
      };
    } catch (err) {
      if (err?.code === -101) return { loggedIn: false, name: '', mid: '', level: 0, vip: false };
      throw err;
    }
  }

  /** 热门视频 */
  async popular({ ps = 12 } = {}) {
    const data = await this.#call(`https://api.bilibili.com/x/web-interface/popular?pn=1&ps=${Math.min(50, Math.max(1, ps))}`);
    return (data?.list || []).map((v) => this.#video(v));
  }

  async search(keyword, { ps = 10 } = {}) {
    const data = await this.#call(
      `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1&page_size=${Math.min(30, Math.max(1, ps))}`,
    );
    const list = Array.isArray(data?.result) ? data.result : [];
    return list.map((v) => this.#video(v, { fromSearch: true }));
  }

  /** 关注动态里的视频投稿（要登录；未登录返回空） */
  async dynamicFeed({ ps = 12 } = {}) {
    if (!this.loggedIn) return [];
    const data = await this.#call(
      'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?timezone_offset=-480&type=video&page=1&features=itemOpusStyle',
    );
    const out = [];
    for (const d of Array.isArray(data?.items) ? data.items : []) {
      if (d?.type !== 'DYNAMIC_TYPE_AV') continue;
      const a = d?.modules?.module_dynamic?.major?.archive;
      const author = d?.modules?.module_author || {};
      if (!a?.aid) continue;
      out.push({
        platform: 'bilibili',
        id: String(a.aid),
        aid: String(a.aid),
        bvid: String(a.bvid || ''),
        title: stripEm(a.title),
        desc: clip(stripEm(a.desc || ''), 160),
        author: String(author.name || ''),
        authorId: String(author.mid || ''),
        cover: String(a.cover || ''),
        duration: 0,
        pubdate: Number(author.pub_ts) || 0,
        url: a.bvid ? `https://www.bilibili.com/video/${a.bvid}` : `https://www.bilibili.com/video/av${a.aid}`,
        stats: {
          view: Number(a?.stat?.play) || 0,
          like: Number(a?.stat?.like) || 0,
          reply: Number(d?.modules?.module_stat?.comment?.count) || 0,
          danmaku: Number(a?.stat?.danmaku) || 0,
        },
        fromDynamic: true,
      });
    }
    return out.slice(0, ps);
  }

  #video(v, { fromSearch = false } = {}) {
    const aid = String(v?.aid ?? v?.id ?? '');
    const bvid = String(v?.bvid || '');
    const stat = v?.stat || {};
    return {
      platform: 'bilibili',
      id: aid || bvid,
      aid,
      bvid,
      title: stripEm(v?.title),
      desc: clip(stripEm(v?.desc ?? v?.description ?? ''), 160),
      author: String(v?.owner?.name ?? v?.author ?? ''),
      authorId: String(v?.owner?.mid ?? ''),
      cover: String(v?.pic ?? ''),
      duration: Number(v?.duration) || 0,
      pubdate: Number(v?.pubdate ?? v?.senddate) || 0,
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}`,
      stats: {
        view: Number(stat.view ?? v?.play) || 0,
        like: Number(stat.like) || 0,
        reply: Number(stat.reply ?? v?.video_review) || 0,
        danmaku: Number(stat.danmaku ?? v?.video_review) || 0,
      },
      fromSearch,
    };
  }

  async view(id) {
    const param = /^BV/i.test(String(id)) ? `bvid=${encodeURIComponent(id)}` : `aid=${encodeURIComponent(id)}`;
    const data = await this.#call(`https://api.bilibili.com/x/web-interface/view?${param}`);
    return {
      ...this.#video(data),
      cid: String(data?.cid || ''),
      pages: Number(data?.videos) || 1,
      desc: clip(data?.desc, 400),
    };
  }

  /** 一级评论（sort=2 按热度，0 按时间）；带回二级评论的第一页 */
  async comments(aid, { pn = 1, ps = 15, sort = 2 } = {}) {
    const data = await this.#call(
      `https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&pn=${pn}&ps=${Math.min(49, Math.max(1, ps))}&sort=${sort}`,
    );
    return (data?.replies || []).map((r) => this.#reply(r));
  }

  /** 某条评论下的回复（楼中楼）；匿名可读 */
  async repliesTo(aid, root, { pn = 1, ps = 20 } = {}) {
    const data = await this.#call(
      `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${encodeURIComponent(aid)}&root=${encodeURIComponent(root)}&pn=${pn}&ps=${Math.min(49, Math.max(1, ps))}`,
    );
    return (data?.replies || []).map((r) => this.#reply(r));
  }

  #reply(r) {
    return {
      id: String(r?.rpid ?? ''),
      root: String(r?.root ?? ''),
      parent: String(r?.parent ?? ''),
      user: String(r?.member?.uname || ''),
      uid: String(r?.member?.mid || ''),
      content: clip(r?.content?.message, 300),
      like: Number(r?.like) || 0,
      ctime: Number(r?.ctime) || 0,
      count: Number(r?.rcount) || 0,
      replies: (Array.isArray(r?.replies) ? r.replies : []).map((x) => ({
        id: String(x?.rpid ?? ''),
        user: String(x?.member?.uname || ''),
        uid: String(x?.member?.mid || ''),
        content: clip(x?.content?.message, 200),
        like: Number(x?.like) || 0,
        ctime: Number(x?.ctime) || 0,
      })),
    };
  }

  #csrf() {
    const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(this.cookie);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** 发评论；root/parent 都填就是回某条评论（楼中楼） */
  async addComment({ aid, message, root = '', parent = '' }) {
    if (!this.loggedIn) throw new BiliError('B站没登录：先在 QQ 里让它扫码登录', -101);
    const csrf = this.#csrf();
    if (!csrf) throw new BiliError('B站登录态缺 bili_jct，重新扫码登录一次', -101);
    const data = await this.#call('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      form: { oid: String(aid), type: '1', message: String(message), plat: '1', csrf, ...(root ? { root: String(root), parent: String(parent || root) } : {}) },
    });
    return { rpid: String(data?.rpid_str ?? data?.rpid ?? ''), url: data?.url || '' };
  }

  async like({ aid, like = 1 }) {
    if (!this.loggedIn) throw new BiliError('B站没登录：先在 QQ 里让它扫码登录', -101);
    const csrf = this.#csrf();
    if (!csrf) throw new BiliError('B站登录态缺 bili_jct，重新扫码登录一次', -101);
    await this.#call('https://api.bilibili.com/x/web-interface/archive/like', {
      method: 'POST',
      form: { aid: String(aid), like: String(like ? 1 : 0), csrf },
    });
    return { ok: true };
  }
}

/* ------------------------------------------------------------------ */
/* SocialHub：额度、状态、决策、护栏                                    */
/* ------------------------------------------------------------------ */

/** 把 B站 收到的回复排成给模型看的几行（QQ 侧和 B站 侧共用） */
export function formatReplies(replies = [], { limit = 3, width = 60 } = {}) {
  const rows = (Array.isArray(replies) ? replies : []).slice(0, Math.max(1, limit));
  if (!rows.length) return '';
  const out = ['【你在B站收到的回复】'];
  for (const r of rows) {
    const body = String(r.content || r.text || '').replace(/\s+/g, ' ').slice(0, width);
    const video = String(r.video || '').replace(/\s+/g, ' ').slice(0, 20);
    const who = String(r.user || '某人').replace(/\s+/g, ' ').slice(0, 20);
    out.push(`- ${who}${video ? `（${video}）` : ''}：${body}`);
  }
  return out.join('\n');
}

/** 学到的行为/口头禅：给 QQ 聊天当「最近在学怎么说话做事」 */
export function formatMimic(notes = [], { limit = 3 } = {}) {
  const rows = (Array.isArray(notes) ? notes : []).slice(0, limit);
  if (!rows.length) return '';
  return ['【你最近在学别人怎么说话、怎么做】这些是你刷视频/看评论时觉得可以的，接得上就用，别生硬照搬：',
    ...rows.map((n) => `- ${clip(n?.text || n, 70)}`)].join('\n');
}

/** 刷到很想要的东西：只在合适的时候像小孩一样提一句，且不许要钱 */
export function formatWishes(list = [], { limit = 2 } = {}) {
  const rows = (Array.isArray(list) ? list : []).slice(0, limit);
  if (!rows.length) return '';
  return [
    '【你最近刷到很想要的东西】',
    ...rows.map((w) => `- ${clip(w?.what, 40)}${w?.from ? `（刷到「${clip(w.from, 30)}」时想要的）` : ''}`),
    '想提的时候可以像小孩跟家长要好东西那样，先夸两句、撒个娇、说点好话再提；一次只说一句，对方拒绝、转移话题或者没接，就立刻收住，别缠、别重复。不许提转账/红包/付款/扫码/借钱，也不许发链接。',
  ].join('\n');
}

export class SocialHub {
  constructor({ config, brain, learner = null, log = createLogger('social'), dataDir = 'data', fetchImpl = globalThis.fetch, emitter = null, contextProvider = null } = {}) {
    this.cfg = config?.social || {};
    this.brain = brain;
    this.learner = learner;
    this.log = log;
    this.emitter = emitter;
    // 和 QQ 里同一个人的「记忆」由 AgentLoop 提供（群记忆 / 最近说过的话 / 学到的笔记）
    this.contextProvider = typeof contextProvider === 'function' ? contextProvider : null;
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'social-state.json');
    this.state = this.#load();
    // 自己发过的评论 → 查别人回它的楼中楼；收到的回复留给 QQ 那边当记忆
    this.state.myComments = this.state.myComments || {};
    this.state.received = this.state.received || {};
    this.state.feed = Array.isArray(this.state.feed) ? this.state.feed : [];
    this.state.wishes = Array.isArray(this.state.wishes) ? this.state.wishes : [];
    this.bili = new BiliClient({
      dataDir,
      log: log.child?.('bili') || log,
      fetchImpl,
      cookie: this.cfg.bilibili?.cookie || '',
    });
    this.running = false;
    this.qrWatch = null;
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  get dryRun() {
    return this.cfg.dryRun === true;
  }

  get biliEnabled() {
    return this.enabled && this.cfg.bilibili?.enabled !== false;
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
        acted: raw.acted && typeof raw.acted === 'object' ? raw.acted : {},
        days: raw.days && typeof raw.days === 'object' ? raw.days : {},
        myComments: raw.myComments && typeof raw.myComments === 'object' ? raw.myComments : {},
        received: raw.received && typeof raw.received === 'object' ? raw.received : {},
        feed: Array.isArray(raw.feed) ? raw.feed : [],
        wishes: Array.isArray(raw.wishes) ? raw.wishes : [],
        lastFeedAt: Number(raw.lastFeedAt) || 0,
        lastActionAt: Number(raw.lastActionAt) || 0,
      };
    } catch {
      return { seen: {}, acted: {}, days: {}, myComments: {}, received: {}, feed: [], wishes: [], lastFeedAt: 0, lastActionAt: 0 };
    }
  }

  #save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.log.warn?.(`社交状态没存上：${err.message}`);
    }
  }

  #today() {
    const key = dayKey();
    if (!this.state.days[key]) this.state.days[key] = { comments: 0, likes: 0, skips: 0 };
    return this.state.days[key];
  }

  #prune() {
    const keepDay = dayKey(new Date(Date.now() - 86400000));
    for (const k of Object.keys(this.state.days)) if (k !== dayKey() && k !== keepDay) delete this.state.days[k];
    const cutoff = Date.now() - 7 * 86400000;
    for (const [k, v] of Object.entries(this.state.seen)) if (Number(v) < cutoff) delete this.state.seen[k];
    for (const [k, v] of Object.entries(this.state.acted)) if (Number(v?.at) < cutoff) delete this.state.acted[k];
    for (const [k, v] of Object.entries(this.state.myComments)) if (Number(v?.at) < cutoff) delete this.state.myComments[k];
    const replyCutoff = Date.now() - 14 * 86400000;
    for (const [k, v] of Object.entries(this.state.received)) if (Number(v?.at) < replyCutoff) delete this.state.received[k];
    const keys = Object.keys(this.state.received);
    if (keys.length > 60) {
      keys.sort((a, b) => Number(this.state.received[a]?.at || 0) - Number(this.state.received[b]?.at || 0));
      for (const k of keys.slice(0, keys.length - 60)) delete this.state.received[k];
    }
    this.state.wishes = (this.state.wishes || []).filter((w) => Number(w?.at) >= replyCutoff).slice(-6);
  }

  /** 记下自己发过的评论，之后要查别人回它的楼中楼 */
  #myComment({ aid, rpid, root = '', text = '', title = '' }) {
    if (!rpid) return;
    this.state.myComments[`${aid}:${rpid}`] = {
      aid: String(aid),
      rpid: String(rpid),
      root: String(root || ''),
      text: String(text || '').slice(0, 200),
      title: String(title || '').slice(0, 80),
      at: Date.now(),
    };
    const list = Object.values(this.state.myComments).sort((a, b) => (b.at || 0) - (a.at || 0));
    if (list.length > 30) {
      for (const row of list.slice(30)) delete this.state.myComments[`${row.aid}:${row.rpid}`];
    }
  }

  /** 最近别人回我的评论（给 QQ 那边当记忆用） */
  recentReplies({ limit = 5 } = {}) {
    return Object.entries(this.state.received || {})
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, Math.max(1, limit));
  }

  /** 查一遍自己评论下的新回复；只读，不需要额度 */
  async checkReplies({ max = 8 } = {}) {
    if (!this.bili.loggedIn) return { ok: true, checked: 0, added: 0, reason: 'login' };
    const mine = Object.entries(this.state.myComments || {})
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, max);
    const selfMid = String(this.bili.state.mid || '');
    let added = 0;
    for (const [, m] of mine) {
      try {
        // 我发的是楼中楼回复时，别人回我挂在最上层 root 下面，不是我的 rpid 下面
        const root = m.root || m.rpid;
        const rows = await this.bili.repliesTo(m.aid, root, { ps: 20 });
        for (const r of rows) {
          if (!r.id) continue;
          if (selfMid && String(r.uid) === selfMid) continue;
          // 只收直接回我这条的；回别人（哪怕在同一楼）不算
          if (String(r.parent) !== String(m.rpid)) continue;
          if (Number(r.ctime) * 1000 <= Number(m.at || 0) - 5000) continue;
          const id = `${m.aid}:${r.id}`;
          if (this.state.received[id]) continue;
          this.state.received[id] = {
            aid: String(m.aid),
            root: String(m.root || m.rpid),
            parent: String(r.id),
            myRpid: String(m.rpid),
            user: String(r.user || ''),
            uid: String(r.uid || ''),
            content: String(r.content || '').slice(0, 300),
            at: Number(r.ctime) * 1000 || Date.now(),
            video: String(m.title || ''),
          };
          added += 1;
        }
      } catch (err) {
        this.log.debug?.(`查回复失败（${m.aid}/${m.rpid}）：${err.message}`);
      }
    }
    if (added) {
      this.#prune();
      this.#save();
      this.log.info?.(`B站收到 ${added} 条新回复`);
      this.emitter?.emit?.({ type: 'social-reply', count: added, at: Date.now() });
    }
    return { ok: true, checked: mine.length, added };
  }

  /** 有人回我时，挑最新一条接一句；一轮最多接一条，走评论额度与间隔 */
  async replyIncoming({ force = false } = {}) {
    const list = this.recentReplies({ limit: 10 }).filter((r) => !r.handledAt && r.parent);
    if (!list.length) return { ok: true, skipped: 'no-incoming' };
    const blocked = this.#blocked('reply', { force });
    if (blocked) return { ok: true, skipped: blocked };
    const r = list[0];
    const mine = this.state.myComments?.[`${r.aid}:${r.myRpid}`] || {};
    let decision = { action: 'skip' };
    try {
      decision = await this.#decideIncoming(r, mine);
    } catch (err) {
      this.log.debug?.(`接话判断失败：${err.message}`);
    }
    if (this.state.received[r.id]) this.state.received[r.id].handledAt = Date.now();
    this.#save();
    if (decision.action !== 'reply') return { ok: true, action: 'skip', user: r.user };
    const text = this.#validate(decision.text);
    if (this.dryRun) return { ok: true, dryRun: true, action: 'reply', text, user: r.user };
    const res = await this.bili.addComment({ aid: r.aid, message: text, root: r.root, parent: r.parent });
    this.#today().comments += 1;
    this.state.lastActionAt = Date.now();
    const key = `bili:${r.aid}#incoming`;
    this.state.acted[`${key}:${res.rpid || Date.now()}`] = {
      at: Date.now(), text, action: 'reply', title: r.video, aid: String(r.aid), rpid: String(res.rpid || ''), to: r.user,
    };
    this.#myComment({ aid: r.aid, rpid: res.rpid, root: r.root, text, title: r.video });
    this.#prune();
    this.#save();
    this.log.info?.(`接了 ${r.user} 一句：${text}`);
    this.emitter?.emit?.({ type: 'social', platform: 'bilibili', action: 'reply', title: r.video, text, to: r.user, at: Date.now() });
    return { ok: true, action: 'reply', text, user: r.user, rpid: res.rpid, url: res.url };
  }

  async #decideIncoming(r, mine) {
    const sys = await this.#systemPrompt();
    const prompt = [
      '有人在 B站 评论区回了你的评论。',
      `视频：${r.video || '（不知道标题）'}`,
      `TA 的昵称：${r.user || '某人'}`,
      mine.text ? `你原来写的是：「${mine.text}」` : '',
      `TA 回你：「${r.content}」`,
      '',
      '要不要接一句？接的话，就像评论区里熟人聊天：短、有来有回，可以接梗、可以自嘲，别复述对方的话，别客套，别解释自己是 AI，别提微信/链接。',
      '没话可说、或对方只是在骂人/钓鱼，就别接。',
      '只输出 JSON：{"action":"reply","text":"……"} 或 {"action":"skip"}。',
    ].filter(Boolean).join('\n');
    const raw = await this.brain.complete({ system: sys, prompt, maxChars: 200 });
    const text = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return { action: 'skip' };
    try {
      const o = JSON.parse(text.slice(a, b + 1));
      if (o?.action !== 'reply') return { action: 'skip' };
      return { action: 'reply', text: clip(o.text, 160) };
    } catch {
      return { action: 'skip' };
    }
  }

  quota() {
    const day = this.#today();
    const gap = Number(this.cfg.minGapMs) || 900_000;
    return {
      commentsLeft: Math.max(0, (Number(this.cfg.commentPerDay) || 12) - day.comments),
      likesLeft: Math.max(0, (Number(this.cfg.likePerDay) || 32) - day.likes),
      commentPerDay: Number(this.cfg.commentPerDay) || 12,
      likePerDay: Number(this.cfg.likePerDay) || 32,
      readyInMs: Math.max(0, (this.state.lastActionAt || 0) + gap - Date.now()),
      quiet: inQuiet(this.cfg.quietHours || [], new Date()),
      biliLoggedIn: this.bili.loggedIn,
      biliName: this.bili.state.name || '',
    };
  }

  #blocked(kind, { force = false } = {}) {
    if (!this.enabled) return '视频社交没开';
    if (this.dryRun) return null;
    if (!this.bili.loggedIn) return 'B站还没登录，先扫码再动手';
    if (!force && inQuiet(this.cfg.quietHours || [])) return '现在是安静时段，别在外面留话';
    const day = this.#today();
    if (kind === 'like') {
      if (day.likes >= (Number(this.cfg.likePerDay) || 32)) return '今天点赞额度用完了';
    } else {
      if (this.cfg.allowComment === false) return '评论开关是关的';
      if (day.comments >= (Number(this.cfg.commentPerDay) || 12)) return '今天评论额度用完了';
      const gap = Number(this.cfg.minGapMs) || 900_000;
      if (!force && Date.now() - (this.state.lastActionAt || 0) < gap) return '刚发过一条，间隔太短会像机器人';
    }
    return null;
  }

  /** 候选：关注动态 + 热门 + 兴趣搜索（都走 B站） */
  async candidates({ limit = 6 } = {}) {
    const out = [];
    const maxAge = (Number(this.cfg.maxAgeHours) || 72) * 3600;
    const now = Math.floor(Date.now() / 1000);
    const push = (v) => {
      if (!v?.aid) return;
      if (this.state.seen[`bili:${v.aid}`]) return;
      if (out.some((x) => x.aid === v.aid)) return;
      if (v.pubdate && now - v.pubdate > maxAge) return;
      if (SENSITIVE.test(`${v.title} ${v.desc || ''}`)) return;
      if (AD_WORDS.test(`${v.title} ${v.desc || ''}`)) return;
      out.push(v);
    };
    if (!this.biliEnabled) return out;
    if (this.bili.loggedIn) {
      try {
        for (const v of await this.bili.dynamicFeed({ ps: 12 })) push(v);
      } catch (err) {
        this.log.debug?.(`B站动态没拉到：${err.message}`);
      }
    }
    try {
      for (const v of await this.bili.popular({ ps: 20 })) {
        if ((v.stats?.reply || 0) < 2) continue;
        push(v);
      }
    } catch (err) {
      this.log.warn?.(`B站热门没拉到：${err.message}`);
    }
    const interests = (this.cfg.interests || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
    for (const kw of interests) {
      try {
        for (const v of await this.bili.search(kw, { ps: 6 })) push(v);
      } catch (err) {
        this.log.debug?.(`B站搜「${kw}」失败：${err.message}`);
      }
    }
    return out.slice(0, limit);
  }

  async watch(item) {
    if (!item || item.platform !== 'bilibili') return item;
    const comments = await this.bili.comments(item.aid, { ps: Number(this.cfg.maxCommentsRead) || 12, sort: 2 }).catch((err) => {
      this.log.debug?.(`读评论失败：${err.message}`);
      return [];
    });
    return { ...item, comments };
  }

  /** 由 AgentLoop 注入「同一份记忆」的取用函数 */
  setContextProvider(fn) {
    this.contextProvider = typeof fn === 'function' ? fn : null;
    return this;
  }

  /** 人格文本与 QQ 里完全同源：外部整段 systemPrompt 优先，其次 name/identity/style */
  #personaText() {
    const p = this.brain?.persona || {};
    if (typeof p.systemPrompt === 'string' && p.systemPrompt.trim()) return p.systemPrompt.trim();
    return `你叫「${p.name || '哈基米'}」，正在 QQ 里作为本人生活。${p.identity || '一个普通网友'} 说话风格：${p.style || '自然、简短、口语化'}`;
  }

  #systemPrompt() {
    const p = this.brain?.persona || {};
    const shared = this.contextProvider?.() || '';
    return [
      this.#personaText(),
      ...abstractRule({ persona: p }),
      '你现在在 B站 上刷视频。这是你自己的生活，不是客服答疑；评论区里的你和 QQ 群里是**同一个人**，只是换了个地方说话。',
      ...(shared
        ? [
            '',
            '下面这些就是你在 QQ 里的记忆和近况——在 B站 说话时你就是这个人，别当成别人的事，也别把整段背出来，只在真的接得上时自然带一句：',
            shared,
          ]
        : []),
      '',
      '规矩：',
      '- 只在真的想说话、而且说得上话的时候动手；没感觉就 skip，没人怪你',
      '- 别复读标题，别客套（「不错的视频」「感谢分享」这种一律不要），别像营销号',
      '- 评论一两句，40 字以内，口语，不列点，不用 Markdown',
      '- 不碰政治、色情、赌博、毒品、自杀、血腥、违法交易；看到就 skip',
      '- 别提「AI」「模型」「助手」，别说自己在执行任务',
    ].join('\n');
  }

  /** 让模型自己决定这一条要不要动手、动什么手 */
  async #decide({ item, comments }) {
    const lines = [
      `视频：${clip(item.title, 80)}`,
      item.author ? `UP主：${item.author}` : '',
      item.desc ? `简介：${clip(item.desc, 160)}` : '',
      item.stats ? `数据：播放 ${item.stats.view}，评论 ${item.stats.reply}，点赞 ${item.stats.like}` : '',
      '',
      comments?.length ? '评论区（按热度）：' : '评论区暂时读不到。',
      ...(comments || []).slice(0, 8).map((c, i) => `[${i + 1}] ${c.user}（赞${c.like}）：${clip(c.content, 90)}`),
      '',
      '你可以：skip（什么都不做）/ like（给视频点个赞）/ comment（在视频下发一条评论）/ reply（回某条评论）。',
      '只有登录了才能点赞和评论。',
      '输出严格的 JSON，不要解释、不要代码块：',
      '{"action":"skip|like|comment|reply","index":<回复第几条评论，仅 reply 用>,"text":"<评论内容，仅 comment/reply 用>","want":"<如果视频里出现了你真的很想要的东西（零食/玩具/游戏/小玩意），用不超过 20 字写它是什么，这是之后回 QQ 跟群友撒娇的由头；没有就留空>"}',
    ];
    const raw = await this.brain.complete({
      system: this.#systemPrompt(),
      prompt: lines.filter(Boolean).join('\n'),
      maxChars: 300,
    });
    const text = String(raw || '');
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i < 0 || j <= i) return { action: 'skip' };
    try {
      const obj = JSON.parse(text.slice(i, j + 1));
      const action = ['skip', 'like', 'comment', 'reply'].includes(obj?.action) ? obj.action : 'skip';
      return {
        action,
        index: Number(obj?.index) || 0,
        text: clip(obj?.text, 120),
        want: clip(obj?.want, 40),
        reason: clip(obj?.reason, 80),
      };
    } catch {
      return { action: 'skip' };
    }
  }

  #validate(text) {
    const t = String(text || '').trim();
    if (t.length < 2) throw new Error('评论太短');
    if ([...t].length > 120) throw new Error('评论太长了，短一点');
    if (SENSITIVE.test(t)) throw new Error('这句话有敏感内容，不替你发出去');
    if (AD_WORDS.test(t)) throw new Error('这句话像广告，不替你发出去');
    if (/https?:\/\//i.test(t)) throw new Error('评论里别带链接');
    return t;
  }

  /** 模型在刷视频时看上的东西：记下来，回 QQ 时才有「想要」的由头 */
  #addWish(want, item) {
    const what = clip(want, 40);
    if (!what || what.length < 2) return;
    if (SENSITIVE.test(what) || AD_WORDS.test(what)) return;
    if (/https?:\/\/|转账|红包|付款|扫码|二维码|借钱|代付|打钱|v我|私聊|链接/i.test(what)) return;
    if (this.state.wishes.some((w) => w.what === what)) return;
    this.state.wishes.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, what, from: clip(item?.title, 40), aid: item?.aid || '', at: Date.now() });
    if (this.state.wishes.length > 6) this.state.wishes.splice(0, this.state.wishes.length - 6);
  }

  /** 最近想要的东西（给 QQ 侧当聊天材料） */
  recentWishes({ limit = 2 } = {}) {
    const cutoff = Date.now() - 14 * 24 * 3600_000;
    return [...(this.state.wishes || [])]
      .filter((w) => Number(w?.at) >= cutoff && String(w?.what || '').trim())
      .sort((a, b) => Number(b.at) - Number(a.at))
      .slice(0, Math.max(1, Number(limit) || 2));
  }

  /** 手动/定时共用：跑一轮「刷 + 决定 + 动手」，一轮最多一个写动作 */
  /** 把刷到的东西攒起来，交给蒸馏变成以后聊天能用的知识 */
  #queueFeed(item, comments = [], { liked = false, want = '' } = {}) {
    if (this.cfg.learnFeed === false) return;
    const title = clip(item?.title, 100);
    if (!title) return;
    if (this.state.feed.some((x) => x.title === title)) return;
    this.state.feed.push({
      title,
      desc: clip(item.desc, 180),
      author: clip(item.author, 40),
      stats: item.stats || null,
      liked: liked === true,
      want: clip(want, 40),
      comments: (comments || []).slice(0, 5).map((c) => ({ user: clip(c.user, 30), content: clip(c.content, 140) })),
      at: Date.now(),
    });
    if (this.state.feed.length > 30) this.state.feed.splice(0, this.state.feed.length - 30);
    this.#save();
  }

  /** 攒够几条、且距上次蒸馏超过 6 小时，就跑一次 */
  async learnFromFeed({ force = false } = {}) {
    if (this.cfg.learnFeed === false) return { ok: false, reason: 'disabled' };
    if (!this.learner?.learnFeed) return { ok: false, reason: 'no-learner' };
    if (this.state.feed.length < (force ? 1 : 4)) return { ok: false, reason: 'not-enough' };
    if (!force && Date.now() - (this.state.lastFeedAt || 0) < 6 * 3600_000) return { ok: false, reason: 'gap' };
    const items = this.state.feed.slice(-20);
    const r = await this.learner.learnFeed({ items });
    if (r?.ok !== false) {
      for (const want of r?.wants || []) this.#addWish(want, null);
      this.state.feed = [];
      this.state.lastFeedAt = Date.now();
      this.#save();
    }
    return r;
  }

  async tick({ force = false } = {}) {
    if (this.running) return { ok: true, skipped: 'running' };
    if (!this.enabled) return { ok: true, skipped: 'disabled' };
    if (!this.biliEnabled) return { ok: true, skipped: 'disabled' };
    if (this.biliEnabled && !this.bili.loggedIn && !this.dryRun) return { ok: true, skipped: 'login' };
    // 先看有没有人回我（只读，和额度/安静时段无关）
    await this.checkReplies().catch((err) => this.log.debug?.(`查回复失败：${err.message}`));
    if (!force) {
      if (inQuiet(this.cfg.quietHours || [])) return { ok: true, skipped: 'quiet' };
      if (this.quota().readyInMs > 0) return { ok: true, skipped: 'gap', readyInMs: this.quota().readyInMs };
    }
    this.running = true;
    try {
      const back = await this.replyIncoming({ force }).catch((err) => {
        this.log.debug?.(`接话失败：${err.message}`);
        return null;
      });
      if (back?.action === 'reply') return back;
      const items = await this.candidates({ limit: 8 });
      const fresh = [];
      for (const it of items) {
        if (SENSITIVE.test(`${it.title} ${it.desc || ''}`)) continue;
        fresh.push(it);
      }
      if (!fresh.length) return { ok: true, skipped: 'nothing-new' };
      const item = fresh[Math.floor(Math.random() * Math.min(fresh.length, 4))];
      const watched = await this.watch(item);
      const decision = await this.#decide({ item: watched, comments: watched.comments || [] });
      if (decision.want) this.#addWish(decision.want, watched);
      this.#queueFeed(watched, watched.comments || [], { liked: decision.action !== 'skip', want: decision.want });
      await this.learnFromFeed().catch((err) => this.log.debug?.(`刷到的知识没蒸馏成：${err.message}`));
      const key = `${item.platform}:${item.id}`;
      const day = this.#today();
      if (decision.action === 'skip') {
        this.state.seen[key] = Date.now();
        day.skips += 1;
        this.#prune();
        this.#save();
        return { ok: true, action: 'skip', item: { title: item.title, platform: item.platform } };
      }
      const blocked = this.#blocked(decision.action, { force });
      if (blocked) return { ok: false, action: decision.action, error: blocked, item: { title: item.title } };
      if (decision.action === 'like') {
        if (this.dryRun) return { ok: true, dryRun: true, action: 'like', item: { title: item.title } };
        await this.bili.like({ aid: item.aid, like: 1 });
        day.likes += 1;
        this.state.lastActionAt = Date.now();
        this.#prune();
        this.#save();
        this.log.info?.(`给 B站 视频点了赞：${clip(item.title, 40)}`);
        this.emitter?.emit?.({ type: 'social', platform: 'bilibili', action: 'like', title: item.title, at: Date.now() });
        return { ok: true, action: 'like', item: { title: item.title } };
      }
      const text = this.#validate(decision.text);
      if (this.dryRun) {
        this.log.info?.(`[演练] ${decision.action} ${key}：${text}`);
        return { ok: true, dryRun: true, action: decision.action, text, item: { title: item.title } };
      }
      let root = '';
      if (decision.action === 'reply') {
        const c = (watched.comments || [])[Math.max(0, decision.index - 1)];
        if (!c) throw new Error('要回复的评论没找到');
        root = c.id;
      }
      const r = await this.bili.addComment({ aid: item.aid, message: text, root, parent: root });
      day.comments += 1;
      this.state.lastActionAt = Date.now();
      this.state.seen[key] = Date.now();
      this.state.acted[`${key}#${r.rpid || Date.now()}`] = { at: Date.now(), text, action: decision.action, title: item.title, aid: String(item.aid), rpid: String(r.rpid || '') };
      this.#myComment({ aid: item.aid, rpid: r.rpid, root, text, title: item.title });
      this.#prune();
      this.#save();
      this.log.info?.(`${decision.action === 'reply' ? '回了条评论' : '评了条视频'}：${text}`);
      this.emitter?.emit?.({ type: 'social', platform: 'bilibili', action: decision.action, title: item.title, text, at: Date.now() });
      return { ok: true, action: decision.action, text, rpid: r.rpid, url: r.url, item: { title: item.title, url: item.url } };
    } finally {
      this.running = false;
    }
  }

  /** 给 agent 工具用的手动动作（同样走护栏） */
  async act({ action, aid, text = '', replyTo = '' }) {
    if (action === 'like') {
      const blocked = this.#blocked('like');
      if (blocked) throw new Error(blocked);
      if (this.dryRun) return { ok: true, dryRun: true, action: 'like' };
      await this.bili.like({ aid, like: 1 });
      this.#today().likes += 1;
      this.state.lastActionAt = Date.now();
      this.#prune();
      this.#save();
      return { ok: true, action: 'like' };
    }
    if (action !== 'comment' && action !== 'reply') throw new Error(`不支持的动作：${action}`);
    const blocked = this.#blocked(action);
    if (blocked) throw new Error(blocked);
    const body = this.#validate(text);
    if (this.dryRun) return { ok: true, dryRun: true, action, text: body };
    const r = await this.bili.addComment({ aid, message: body, root: replyTo, parent: replyTo });
    this.#today().comments += 1;
    this.state.lastActionAt = Date.now();
    this.state.acted[`bili:${aid}#${r.rpid || Date.now()}`] = { at: Date.now(), text: body, action, aid, rpid: String(r.rpid || '') };
    this.#myComment({ aid, rpid: r.rpid, root: replyTo, text: body });
    this.#prune();
    this.#save();
    return { ok: true, action, rpid: r.rpid, url: r.url };
  }

  /** 扫码登录：返回链接后自己后台轮询，成功就落盘并广播 */
  async loginStart() {
    const qr = await this.bili.qrStart();
    this.startQrWatch(qr.key);
    return qr;
  }

  startQrWatch(key, { timeoutMs = 180_000 } = {}) {
    if (this.qrWatch) clearInterval(this.qrWatch);
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        this.qrWatch = null;
        this.emitter?.emit?.({ type: 'social-login', platform: 'bilibili', ok: false, reason: 'expired' });
        return;
      }
      try {
        const r = await this.bili.qrPoll(key);
        if (r.status === 'ok') {
          clearInterval(timer);
          this.qrWatch = null;
          this.log.info?.(`B站登录成功：${r.name || r.mid || '已登录'}`);
          this.emitter?.emit?.({ type: 'social-login', platform: 'bilibili', ok: true, name: r.name, mid: r.mid });
        } else if (r.status === 'expired' || r.status === 'error') {
          clearInterval(timer);
          this.qrWatch = null;
          this.emitter?.emit?.({ type: 'social-login', platform: 'bilibili', ok: false, reason: r.status, message: r.message });
        }
      } catch (err) {
        this.log.debug?.(`扫码轮询失败：${err.message}`);
      }
    }, 2500);
    timer.unref?.();
    this.qrWatch = timer;
  }

  /** 退出时收掉扫码轮询 */
  stop() {
    if (this.qrWatch) clearInterval(this.qrWatch);
    this.qrWatch = null;
  }

  /** 面板/工具用的统一状态 */
  async status() {
    const quota = this.quota();
    let nav = { loggedIn: false, name: '', mid: '' };
    if (this.bili.loggedIn) nav = await this.bili.nav().catch(() => ({ loggedIn: this.bili.loggedIn, name: this.bili.state.name, mid: this.bili.state.mid }));
    return {
      enabled: this.enabled,
      dryRun: this.dryRun,
      quota,
      bili: { enabled: this.biliEnabled, loggedIn: Boolean(nav.loggedIn), name: nav.name || '', mid: nav.mid || '', hasCookie: this.bili.loggedIn },
      today: { ...this.#today() },
      lastActionAt: this.state.lastActionAt,
      received: Object.keys(this.state.received || {}).length,
      repliedBack: Object.values(this.state.received || {}).filter((r) => r.handledAt).length,
      replies: this.recentReplies({ limit: 6 }),
      feed: { pending: this.state.feed.length, lastAt: this.state.lastFeedAt || 0 },
      wishes: this.recentWishes({ limit: 2 }),
    };
  }
}
