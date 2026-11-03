import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './util.mjs';

/**
 * QQ 空间的「社交」能力：回评自己说说下面的评论、去评论好友的说说。
 *
 * 为什么单独一个模块：评论是不可撤回的公开发言（桥接没有删评论的接口），
 * 所以硬护栏必须写在代码里，而不是指望模型自觉——
 *   · 每日上限（回复 / 评论分开算）
 *   · 最短间隔
 *   · 同一条评论只回一次、同一条说说只评一次（state 落盘，重启也不重复）
 *   · 只碰多久以内的内容（老说说突然冒出一条评论像诈尸）
 *   · 敏感内容一律不碰（涉政、色情、赌博、毒品、自杀、血腥、违法交易）
 *   · 安静时段不发
 *
 * 另外：视频号（微信的）在 QQ 侧没有对应接口，QQ 的「小世界/看点」桥接也没开，
 * 所以「刷视频号自己评论」这条做不了，只能在空间动态（feed 里带视频的说说）上评论。
 */

/** 敏感内容：不碰，转身走开比接话安全 */
const SENSITIVE = /(?:习近平|政治局|共产党|六四|法轮|台独|港独|翻墙被抓|色情|裸|约炮|赌博|博彩|外围|毒品|冰毒|大麻|自杀|跳楼|杀了他|砍死|枪|炸弹|洗钱|诈骗|代开|发票|枪支)/i;

/** 广告/推广类动态不评（appid 6600 那种） */
const AD_APPIDS = new Set([6600, 3110000]);

const dayKey = (d = new Date()) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

function hhmmToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 这条评论是不是「冲着我来的」：回我的评论、@ 我、叫我名字、或者直接用「你/您」说事。
 * 是 → 必回；不是（两个好友在我评论区自己聊、或者只是陈述）→ 交给模型自己决定要不要接。
 */
export function looksDirectedAtMe({ text = '', replyUin = '', selfId = '', selfName = '' } = {}) {
  const t = String(text || '');
  const me = String(selfId || '');
  if (replyUin && me && String(replyUin) === me) return true;
  if (me && t.includes(me)) return true;
  const name = String(selfName || '').trim();
  if (name.length >= 2 && t.includes(name)) return true;
  if (/[你您]/.test(t)) return true;
  if (t.includes('@')) return true;
  return false;
}

export function inQuiet(ranges, now = new Date()) {
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

export class QzoneSocial {
  constructor({ config, bot, log, dataDir }) {
    this.cfg = config?.chat?.qzone || {};
    this.selfIdCfg = String(config?.onebot?.selfId || '');
    this.bot = bot;
    this.log = log || createLogger('qzone');
    this.dataDir = dataDir || 'data';
    this.file = path.join(this.dataDir, 'qzone-state.json');
    this.state = this.#load();
    this.scanCache = null; // 好友空间巡检缓存
    this.running = false;
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  get dryRun() {
    return this.cfg.dryRun === true;
  }

  get selfId() {
    return String(this.bot?.selfId || this.bot?.onebot?.state?.selfId || this.selfIdCfg || '');
  }

  /** 自己的 QQ 号：config 里没写就问一次桥接，问完缓存 */
  async resolveSelfId() {
    const cur = this.selfId;
    if (cur) return cur;
    try {
      const info = await this.#call('get_login_info', {});
      const id = String(info?.user_id || '');
      if (id) {
        this.bot.selfId = id;
        if (this.bot.onebot?.state) this.bot.onebot.state.selfId = id;
      }
      return id;
    } catch (err) {
      this.log.warn(`拿不到自己的 QQ 号：${err.message}`);
      return '';
    }
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        replied: raw.replied && typeof raw.replied === 'object' ? raw.replied : {},
        commented: raw.commented && typeof raw.commented === 'object' ? raw.commented : {},
        days: raw.days && typeof raw.days === 'object' ? raw.days : {},
        lastReplyAt: Number(raw.lastReplyAt) || 0,
        lastCommentAt: Number(raw.lastCommentAt) || 0,
      };
    } catch {
      return { replied: {}, commented: {}, days: {}, lastReplyAt: 0, lastCommentAt: 0 };
    }
  }

  #save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.log.warn(`空间状态没存上：${err.message}`);
    }
  }

  #today() {
    const key = dayKey();
    if (!this.state.days[key]) this.state.days[key] = { replies: 0, comments: 0 };
    return this.state.days[key];
  }

  /** 清掉 day 记录里太老的，免得文件越长越大 */
  #pruneDays() {
    const keep = new Set([dayKey(), dayKey(new Date(Date.now() - 86400000))]);
    for (const key of Object.keys(this.state.days)) if (!keep.has(key)) delete this.state.days[key];
  }

  async #call(action, params = {}, { timeoutMs = 45000 } = {}) {
    const res = await this.bot.onebot.call(action, params, { timeoutMs });
    if (!res || (res.status && res.status !== 'ok')) {
      const why = res?.wording || res?.message || '未知错误';
      throw new Error(`${action} 失败：${why}`);
    }
    return res?.data ?? res;
  }

  /** 我自己的说说（默认最近 5 条） */
  async myPosts({ num = 5 } = {}) {
    let data;
    try {
      data = await this.#call('get_qzone_msg_list', { num });
    } catch (err) {
      // 空空间 / 没权限时 QQ 返回 msglist:null，桥接当成「响应结构异常」抛出来——这就是没有说说，不是故障
      if (/结构异常|保密|没有权限/.test(err.message)) return [];
      throw err;
    }
    const list = Array.isArray(data?.msglist) ? data.msglist : Array.isArray(data) ? data : [];
    return list
      .filter((m) => m && m.tid)
      .map((m) => ({ tid: String(m.tid), content: String(m.content || ''), time: Number(m.time) || 0, commentNum: Number(m.comment_num) || 0 }));
  }

  /** 单条说说的详情（含第一页评论） */
  async detail(tid, { pos = 0, num = 20 } = {}) {
    const data = await this.#call('get_qzone_msg_detail', { tid: String(tid), pos, num });
    return {
      tid: String(data?.tid || tid),
      content: String(data?.content || ''),
      commentNum: Number(data?.comment_num) || 0,
      comments: Array.isArray(data?.comments) ? data.comments : [],
    };
  }

  /**
   * 还没回的评论：扫自己最近几条说说，把「不是我发的、我还没回过的」挑出来。
   * 只回指向我的：要么直接评论我，要么在我评论区说话（都是我的地盘，回一句不算打扰）。
   */
  async pendingReplies({ posts = 4, maxAgeDays = 7, limit = 6 } = {}) {
    if (!this.enabled) return [];
    const me = await this.resolveSelfId();
    const minTime = Date.now() / 1000 - maxAgeDays * 86400;
    const out = [];
    for (const post of await this.myPosts({ num: posts })) {
      if (post.time && post.time < minTime) continue;
      let d;
      try {
        d = await this.detail(post.tid);
      } catch (err) {
        this.log.warn(`读说说 ${post.tid} 详情失败：${err.message}`);
        continue;
      }
      for (const c of d.comments || []) {
        const uin = String(c.uin ?? c.userid ?? '');
        const cid = String(c.comment_id ?? c.id ?? '');
        if (!uin || uin === me || !cid) continue;
        const key = `${post.tid}#${cid}`;
        if (this.state.replied[key]) continue;
        const content = String(c.content || '').trim();
        if (!content) continue;
        if (SENSITIVE.test(content)) {
          this.state.replied[key] = { at: Date.now(), skip: 'sensitive' };
          continue;
        }
        const replyUin = String(c.reply_uin ?? c.reply_user ?? '');
        const selfName = this.bot?.brain?.persona?.name || this.bot?.cfg?.persona?.name || '';
        const directed = looksDirectedAtMe({ text: content, replyUin, selfId: me, selfName });
        out.push({
          tid: post.tid,
          postText: d.content || post.content,
          commentId: cid,
          commentUin: uin,
          commentName: String(c.name || c.nickname || ''),
          comment: content,
          replyUin,
          directed,
          at: Number(c.time) || 0,
          key,
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 好友空间巡检：get_qzone_feeds 经常只回自己的动态，真正的「别人的说说」得挨个好友空间去读。
   * 只读有权限的（保密/空空间跳过），结果缓存半小时，别每轮都去翻好友空间。
   */
  async friendScan({ maxFriends = 8, ttlMs = 1800000 } = {}) {
    if (!this.enabled) return [];
    const now = Date.now();
    if (this.scanCache && now - this.scanCache.at < ttlMs) return this.scanCache.list;
    const me = await this.resolveSelfId();
    let friends = [];
    try {
      friends = await this.#call('get_friend_list', {});
    } catch (err) {
      this.log.warn(`读好友列表失败：${err.message}`);
    }
    const list = [];
    for (const f of (Array.isArray(friends) ? friends : []).slice(0, maxFriends)) {
      const uin = String(f?.user_id ?? '');
      if (!uin || uin === me) continue;
      let posts = [];
      try {
        const data = await this.#call('get_qzone_msg_list', { target_uin: Number(uin), num: 3 });
        posts = Array.isArray(data?.msglist) ? data.msglist : [];
      } catch (err) {
        // 保密 / 空空间 / 没权限，都是「这家不用看」，不算错误
        this.log.debug?.(`跳过 ${uin} 的空间：${err.message}`);
        continue;
      }
      for (const m of posts) {
        if (!m?.tid) continue;
        list.push({
          tid: String(m.tid),
          uin,
          nickname: String(f?.remark || f?.nickname || uin),
          content: String(m.content || '').trim(),
          time: Number(m.time) || 0,
          images: Array.isArray(m.images) ? m.images.length : 0,
          from: 'scan',
        });
      }
    }
    this.scanCache = { at: now, list };
    return list;
  }

  /** 好友动态（别人的说说）；只保留能评论的：非我、非广告、有正文、够新 */
  async friendFeeds({ count = 20, maxAgeHours = 36, limit = 5 } = {}) {
    if (!this.enabled) return [];
    const me = await this.resolveSelfId();
    const minTime = Date.now() / 1000 - maxAgeHours * 3600;
    let data;
    try {
      data = await this.#call('get_qzone_feeds', { count });
    } catch (err) {
      this.log.warn(`读好友动态失败：${err.message}`);
      return [];
    }
    let feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    const mineOnly = feeds.every((f) => String(f?.uin ?? '') === me || String(f?.uin ?? '') === '0');
    if (!feeds.length || mineOnly) {
      // 动态首页里全是自己的，说明这个入口拿不到别人的；换好友空间巡检
      feeds = await this.friendScan({ maxFriends: 8 });
    }
    const out = [];
    for (const f of feeds) {
      const uin = String(f?.uin ?? '');
      const tid = String(f?.tid ?? '');
      const content = String(f?.content ?? '').trim();
      const time = Number(f?.time) || 0;
      if (!tid || !uin || uin === me || uin === '0') continue;
      if (AD_APPIDS.has(Number(f?.appid))) continue;
      if (content.length < 6) continue;
      if (time && time < minTime) continue;
      if (this.state.commented[tid]) continue;
      if (SENSITIVE.test(content)) continue;
      out.push({
        tid,
        uin,
        nickname: String(f?.nickname || ''),
        content,
        time,
        images: Array.isArray(f?.images) ? f.images.length : 0,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 剩余额度（给模型看的，省得它白试）；repliesLeft = -1 表示指向我的评论不限量（必回） */
  quota() {
    const day = this.#today();
    const unlimitedReplies = this.cfg.alwaysReply !== false;
    const r = unlimitedReplies ? -1 : Math.max(0, (Number(this.cfg.replyPerDay) || 6) - day.replies);
    const c = Math.max(0, (Number(this.cfg.commentPerDay) || 2) - day.comments);
    const gap = Number(this.cfg.minGapMs) || 1800000;
    const now = Date.now();
    return {
      repliesLeft: r,
      commentsLeft: c,
      replyReadyInMs: Math.max(0, (this.state.lastReplyAt || 0) + gap - now),
      commentReadyInMs: Math.max(0, (this.state.lastCommentAt || 0) + gap - now),
      quiet: inQuiet(this.cfg.quietHours),
    };
  }

  #blocked(kind) {
    if (!this.enabled) return '空间社交没开';
    if (this.dryRun) return null;
    if (inQuiet(this.cfg.quietHours)) return '现在是安静时段，别在外面留话';
    const day = this.#today();
    if (kind === 'reply') {
      // 指向我的评论「必回」：alwaysReply（默认开）时不拿额度和间隔拦，只留安静时段
      if (this.cfg.alwaysReply === false) {
        if (day.replies >= (Number(this.cfg.replyPerDay) || 6)) return '今天的回复额度用完了，留着明天再说';
        const gap = Number(this.cfg.minGapMs) || 1800000;
        if (Date.now() - (this.state.lastReplyAt || 0) < gap) return '刚回完一条，别连着刷屏';
      }
    } else {
      if (day.comments >= (Number(this.cfg.commentPerDay) || 2)) return '今天的评论额度用完了';
      const gap = Number(this.cfg.minGapMs) || 1800000;
      if (Date.now() - (this.state.lastCommentAt || 0) < gap) return '刚评过一条，间隔太短会像机器人';
    }
    return null;
  }

  /** 回复某条评论（楼中楼也支持：replyUin/replyName 指向二级回复的人） */
  async replyToComment({ tid, commentId, commentUin, replyUin, replyName, content, postOwnerUin }) {
    const text = String(content || '').trim();
    if (!text) throw new Error('回复内容是空的');
    if (text.length > 200) throw new Error('回复太长了，短一点');
    if (SENSITIVE.test(text)) throw new Error('这句话有敏感内容，不替你发出去');
    const key = `${tid}#${commentId}`;
    if (this.state.replied[key]) throw new Error('这条评论已经回过了');
    const blocked = this.#blocked('reply');
    if (blocked) throw new Error(blocked);
    const day = this.#today();
    const params = {
      tid: String(tid),
      target_uin: Number(postOwnerUin || (await this.resolveSelfId())),
      content: text,
      comment_id: String(commentId),
      comment_uin: Number(commentUin),
    };
    if (replyUin) params.reply_uin = Number(replyUin);
    if (replyName) params.reply_name = String(replyName).slice(0, 20);
    if (this.dryRun) {
      this.log.info(`[演练] 会回复评论 ${key}：${text}`);
      return { ok: true, dryRun: true, text };
    }
    const data = await this.#call('comment_qzone', params);
    this.state.replied[key] = { at: Date.now(), text };
    day.replies += 1;
    this.state.lastReplyAt = Date.now();
    this.#pruneDays();
    this.#save();
    return { ok: true, commentId: data?.comment_id != null ? String(data.comment_id) : '', text };
  }

  /** 评论别人的说说 */
  async commentPost({ tid, targetUin, content }) {
    const text = String(content || '').trim();
    if (!text) throw new Error('评论是空的');
    if (text.length > 200) throw new Error('评论太长了，短一点');
    if (SENSITIVE.test(text)) throw new Error('这句话有敏感内容，不替你发出去');
    if (!tid || !targetUin) throw new Error('缺 tid 或 target_uin');
    if (String(targetUin) === (await this.resolveSelfId())) throw new Error('自己的说说不用评');
    if (this.state.commented[String(tid)]) throw new Error('这条说说已经评过了');
    const blocked = this.#blocked('comment');
    if (blocked) throw new Error(blocked);
    const day = this.#today();
    if (this.dryRun) {
      this.log.info(`[演练] 会评论 ${tid}：${text}`);
      return { ok: true, dryRun: true, text };
    }
    const data = await this.#call('comment_qzone', {
      tid: String(tid),
      target_uin: Number(targetUin),
      content: text,
    });
    this.state.commented[String(tid)] = { at: Date.now(), text, uin: String(targetUin) };
    day.comments += 1;
    this.state.lastCommentAt = Date.now();
    this.#pruneDays();
    this.#save();
    return { ok: true, commentId: data?.comment_id != null ? String(data.comment_id) : '', text };
  }
}
