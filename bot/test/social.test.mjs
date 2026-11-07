import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BiliClient, SocialHub } from '../src/social.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };

const json = (obj, { status = 200, setCookies = [] } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { getSetCookie: () => setCookies },
  text: async () => JSON.stringify(obj),
  json: async () => obj,
});

const BILI_VIDEO = {
  aid: 123,
  bvid: 'BV1xx411c7mD',
  title: '<em class="keyword">测试</em>视频',
  desc: '一个测试视频',
  pic: 'https://i0.hdslb.com/a.jpg',
  duration: 100,
  pubdate: Math.floor(Date.now() / 1000) - 3600,
  owner: { name: 'UP', mid: 9 },
  stat: { view: 1000, like: 20, reply: 8, danmaku: 3 },
};

/** 记录请求并按路径回包 */
function fakeFetch(extra = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} });
    for (const [part, handler] of Object.entries(extra)) {
      if (u.includes(part)) return typeof handler === 'function' ? handler(u, opts) : handler;
    }
    if (u.includes('/x/frontend/finger/spi')) return json({ code: 0, data: { b_3: 'BV-buvid' } });
    if (u.includes('/x/web-interface/popular')) return json({ code: 0, data: { list: [BILI_VIDEO] } });
    if (u.includes('/feed/all')) {
      return json({
        code: 0,
        data: {
          items: [{
            id_str: 'dyn-1',
            type: 'DYNAMIC_TYPE_AV',
            modules: {
              module_author: { name: '关注的UP', mid: 7, pub_ts: Math.floor(Date.now() / 1000) - 600 },
              module_dynamic: { major: { archive: { aid: 456, bvid: 'BV1yy411c7mE', title: '关注的人发的新视频', cover: '', desc: '动态里的简介', stat: { play: 10, like: 2, danmaku: 1 } } } },
              module_stat: { comment: { count: 4 } },
            },
          }],
        },
      });
    }
    if (u.includes('/x/v2/reply?') || u.includes('/x/v2/reply&')) {
      return json({
        code: 0,
        data: {
          replies: [
            { rpid: 11, member: { uname: '甲', mid: 1 }, content: { message: '一楼' }, like: 3, ctime: 1, rcount: 1, replies: [] },
            { rpid: 12, member: { uname: '乙', mid: 2 }, content: { message: '二楼' }, like: 1, ctime: 2, rcount: 0 },
          ],
        },
      });
    }
    if (u.includes('/x/web-interface/view')) return json({ code: 0, data: BILI_VIDEO });
    if (u.includes('/x/v2/reply/add')) return json({ code: 0, data: { rpid_str: '9001', url: 'https://www.bilibili.com/video/BV1xx411c7mD#reply9001' } });
    if (u.includes('/archive/like')) return json({ code: 0, data: {} });
    if (u.includes('/x/web-interface/nav')) return json({ code: 0, data: { isLogin: true, uname: '机器人', mid: 42 } });
    if (u.includes('hot/search/list')) return json({ data: { word_list: [{ word: '热一', hot_value: 99, group_id: 'g1', sentence_id: 's1' }] } });
    throw new Error(`没预料到的请求：${u}`);
  };
  fn.calls = calls;
  return fn;
}

test('BiliClient：带 buvid3 拉热门并归一化字段', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const bili = new BiliClient({ dataDir: dir, log, fetchImpl: fetch });
  const list = await bili.popular({ ps: 3 });
  assert.equal(list.length, 1);
  assert.equal(list[0].aid, '123');
  assert.equal(list[0].title, '测试视频');
  assert.equal(list[0].stats.reply, 8);
  const popular = fetch.calls.find((c) => c.url.includes('/popular'));
  assert.match(String(popular.headers.cookie || ''), /buvid3=/);
});

test('BiliClient：评论归一化，带回二级评论', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bili = new BiliClient({ dataDir: dir, log, fetchImpl: fakeFetch() });
  const rows = await bili.comments('123', { ps: 5 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '11');
  assert.equal(rows[0].user, '甲');
});

test('BiliClient：扫码成功后从 url/Set-Cookie 收齐登录态', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const qrUrl = `https://passport.biligame.com/x/passport-login/web/crossDomain?SESSDATA=sess%2C1&bili_jct=jct&DedeUserID=42&DedeUserID__ckMd5=ck&sid=sid`;
  const fetch = fakeFetch({
    'qrcode/poll': () =>
      json({ code: 0, data: { code: 0, url: qrUrl } }, { setCookies: ['buvid3=buvid-x; Path=/'] }),
  });
  const bili = new BiliClient({ dataDir: dir, log, fetchImpl: fetch });
  const r = await bili.qrPoll('key');
  assert.equal(r.status, 'ok');
  assert.match(bili.cookie, /SESSDATA=sess/);
  assert.match(bili.cookie, /bili_jct=jct/);
  assert.equal(bili.loggedIn, true);
  assert.equal(r.name, '机器人');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'bili-session.json'), 'utf8'));
  assert.match(saved.cookie, /SESSDATA=sess/);
});

test('BiliClient：扫码未确认时返回 scanned，不写登录态', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch({ 'qrcode/poll': () => json({ code: 0, data: { code: 86090 } }) });
  const bili = new BiliClient({ dataDir: dir, log, fetchImpl: fetch });
  const r = await bili.qrPoll('k');
  assert.equal(r.status, 'scanned');
  assert.equal(bili.cookie, '');
});

test('BiliClient：关注动态只取视频投稿并归一化', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const bili = new BiliClient({ dataDir: dir, log, fetchImpl: fetch, cookie: 'SESSDATA=s' });
  const list = await bili.dynamicFeed({ ps: 5 });
  assert.equal(list.length, 1);
  assert.equal(list[0].aid, '456');
  assert.equal(list[0].fromDynamic, true);
  assert.equal(list[0].stats.reply, 4);
  assert.equal(list[0].url, 'https://www.bilibili.com/video/BV1yy411c7mE');
  const call = fetch.calls.find((c) => c.url.includes('/feed/all'));
  assert.match(String(call.headers.cookie || ''), /SESSDATA=s/);
});

const baseCfg = (social = {}) => ({
  social: {
    enabled: true,
    bilibili: { enabled: true, cookie: 'SESSDATA=s; bili_jct=j; DedeUserID=1' },
    interests: [],
    maxAgeHours: 72,
    maxCommentsRead: 8,
    commentPerDay: 12,
    likePerDay: 32,
    minGapMs: 0,
    quietHours: [],
    dryRun: false,
    ...social,
  },
});

const stubBrain = (reply) => ({
  persona: { name: '小雪花', identity: '网友', style: '短句' },
  complete: async () => reply,
});

test('SocialHub.tick：模型决定评论 → 真发出去并记账', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const hub = new SocialHub({ config: baseCfg(), brain: stubBrain('{"action":"comment","text":"这个操作有点东西"}'), log, dataDir: dir, fetchImpl: fetch });
  const r = await hub.tick();
  assert.equal(r.ok, true);
  assert.equal(r.action, 'comment');
  const post = fetch.calls.find((c) => c.url.includes('/x/v2/reply/add'));
  assert.ok(post, '应该真的发了评论');
  assert.match(post.body, /message=/);
  assert.equal(hub.state.days[Object.keys(hub.state.days)[0]].comments, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'social-state.json'), 'utf8'));
  assert.equal(Object.keys(saved.acted).length, 1);
});

test('SocialHub.tick：模型 skip 时不发任何写请求', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const hub = new SocialHub({ config: baseCfg(), brain: stubBrain('{"action":"skip"}'), log, dataDir: dir, fetchImpl: fetch });
  const r = await hub.tick();
  assert.equal(r.action, 'skip');
  assert.equal(fetch.calls.some((c) => c.url.includes('/reply/add')), false);
  assert.equal(Object.keys(hub.state.seen).length, 1);
});

test('SocialHub：安静时段不刷', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const hub = new SocialHub({ config: baseCfg({ quietHours: ['00:00-23:59'] }), brain: stubBrain('{}'), log, dataDir: dir, fetchImpl: fetch });
  const r = await hub.tick();
  assert.equal(r.skipped, 'quiet');
  assert.equal(fetch.calls.length, 0);
});

test('SocialHub：dryRun 只记录不真发', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const hub = new SocialHub({ config: baseCfg({ dryRun: true }), brain: stubBrain('{"action":"comment","text":"演练一句"}'), log, dataDir: dir, fetchImpl: fetch });
  const r = await hub.tick();
  assert.equal(r.dryRun, true);
  assert.equal(fetch.calls.some((c) => c.url.includes('/reply/add')), false);
});

test('SocialHub.act：敏感/广告词被拦下', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const hub = new SocialHub({ config: baseCfg(), brain: stubBrain('{}'), log, dataDir: dir, fetchImpl: fetch });
  await assert.rejects(() => hub.act({ action: 'comment', aid: '123', text: '加微信领福利' }), /广告/);
  assert.equal(fetch.calls.some((c) => c.url.includes('/reply/add')), false);
});

test('SocialHub.act：回复某条评论时带 root/parent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const hub = new SocialHub({ config: baseCfg(), brain: stubBrain('{}'), log, dataDir: dir, fetchImpl: fetch });
  const r = await hub.act({ action: 'reply', aid: '123', text: '你说得对', replyTo: '11' });
  assert.equal(r.ok, true);
  const post = fetch.calls.find((c) => c.url.includes('/reply/add'));
  assert.match(post.body, /root=11/);
  assert.match(post.body, /parent=11/);
});

test('SocialHub.tick：没登录 B站时直接跳过，不花模型调用', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  let calls = 0;
  const hub = new SocialHub({
    config: baseCfg({ bilibili: { enabled: true, cookie: '' } }),
    brain: { persona: {}, complete: async () => { calls += 1; return '{}'; } },
    log, dataDir: dir, fetchImpl: fetch,
  });
  const r = await hub.tick();
  assert.equal(r.skipped, 'login');
  assert.equal(calls, 0);
  assert.equal(fetch.calls.length, 0);
});

test('SocialHub：人格和记忆与 QQ 同源（systemPrompt / contextProvider 都进提示词）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const brain = {
    persona: { name: '小雪花', identity: '网友', style: '短句', systemPrompt: '你叫小雪花，是群里那个嘴硬心软的人。' },
    complete: async ({ system }) => { seen.push(system); return '{"action":"comment","text":"这句接得上"}'; },
  };
  const hub = new SocialHub({
    config: baseCfg(),
    brain,
    log,
    dataDir: dir,
    fetchImpl: fakeFetch(),
    contextProvider: () => '【你在 QQ 里记得的事】\n- 群：大家昨天在聊显卡涨价',
  });
  const r = await hub.tick();
  assert.equal(r.action, 'comment');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /你叫小雪花，是群里那个嘴硬心软的人。/);
  assert.match(seen[0], /大家昨天在聊显卡涨价/);
  assert.match(seen[0], /同一个人/);
});

test('AgentLoop：把 QQ 的群记忆/近况/笔记喂给 SocialHub', async (t) => {
  const { AgentLoop } = await import('../src/agent.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-mem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let provider = null;
  const social = {
    setContextProvider(fn) { provider = fn; },
    recentReplies: () => [{ user: '路人甲', content: '你在B站说得挺对', video: '测试视频', at: Date.now() }],
    recentWishes: () => [{ what: '冰可乐', from: '测评视频', at: Date.now() }],
  };
  const memory = {
    list: () => [
      { scope: 'group:100', summary: '大家在折腾显卡和本地模型', facts: ['群友阿甲在攒机'], updatedAt: 200 },
      { scope: 'private:7', summary: '和一个老同学聊工作', facts: ['他最近在换城市'], updatedAt: 100 },
    ],
  };
  const learn = {
    top: () => [{ text: '群里说「肉鸽」一般指 Roguelike' }],
    byKind: (kind) => (kind === 'behavior' ? [{ text: '被怼时先自嘲一句' }] : [{ text: '可以这样说：先别急' }]),
  };
  const a = new AgentLoop({
    config: { storage: { dataDir: dir }, agent: {}, chat: {}, llm: {} },
    bot: { recent: () => [] },
    brain: { persona: { name: '小雪花' } },
    memory,
    learn,
    social,
    log,
  });
  assert.equal(typeof provider, 'function');
  const text = provider();
  assert.match(text, /大家在折腾显卡和本地模型/);
  assert.match(text, /群友阿甲在攒机/);
  assert.match(text, /Roguelike/);
  assert.match(text, /你在B站收到的回复/);
  assert.match(text, /你在B站说得挺对/);
  assert.match(text, /不是 QQ 群友/);
  assert.match(text, /被怼时先自嘲一句/);
  assert.match(text, /先别急/);
  assert.match(text, /冰可乐/);
  assert.match(text, /不许提转账/);
  assert.match(a.socialRepliesText(), /路人甲/);
  assert.equal(a.social, social);
});

test('SocialHub：查到别人回我的评论，记进 received 并能给 QQ 侧读', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-reply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bili-session.json'), JSON.stringify({ cookie: 'SESSDATA=x; bili_jct=y', name: '机器人', mid: '42', savedAt: Date.now() }));
  const now = Math.floor(Date.now() / 1000);
  const fetch = fakeFetch({
    '/x/v2/reply/reply': json({
      code: 0,
      data: {
        replies: [
          { rpid: 501, root: 777, parent: 777, member: { uname: '路人甲', mid: 8 }, content: { message: '回你一句' }, ctime: now },
          { rpid: 502, root: 777, parent: 777, member: { uname: '机器人', mid: 42 }, content: { message: '自己回自己' }, ctime: now },
          { rpid: 503, root: 777, parent: 777, member: { uname: '旧人', mid: 9 }, content: { message: '很久以前' }, ctime: 1 },
        ],
      },
    }),
  });
  const hub = new SocialHub({ config: baseCfg({ bilibili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y' } }), brain: { persona: {}, complete: async () => '{}' }, log, dataDir: dir, fetchImpl: fetch });
  hub.bili.state.mid = '42';
  hub.state.myComments['123:777'] = { aid: '123', rpid: '777', root: '', text: '我发的评论', title: '测试视频', at: Date.now() - 60_000 };

  const r = await hub.checkReplies();
  assert.equal(r.added, 1);
  const rows = hub.recentReplies({ limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user, '路人甲');
  assert.equal(rows[0].content, '回你一句');
  assert.equal(rows[0].video, '测试视频');

  const again = await hub.checkReplies();
  assert.equal(again.added, 0, '同一条回复不能记两遍');
});

test('buildMessages：B站收到的回复作为背景记忆进提示词', async () => {
  const { Brain } = await import('../src/brain.mjs');
  const brain = new Brain({ persona: { name: '小雪花' }, chat: { maxReplyChars: 160 }, llm: {} }, { log });
  const history = [{ role: 'user', name: '甲', text: '在吗' }];
  const withReply = JSON.stringify(brain.buildMessages({ history, scopeLabel: '群', socialText: '【你在B站收到的回复】\n- 路人甲：回你一句' }));
  assert.match(withReply, /B站评论区收到过/);
  assert.match(withReply, /回你一句/);
  const without = JSON.stringify(brain.buildMessages({ history, scopeLabel: '群' }));
  assert.doesNotMatch(without, /B站评论区收到过/);
});

test('SocialHub：我发的是楼中楼回复时，只收直接回我的那条', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-thread-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bili-session.json'), JSON.stringify({ cookie: 'SESSDATA=x; bili_jct=y', mid: '42', savedAt: Date.now() }));
  const now = Math.floor(Date.now() / 1000);
  const fetch = fakeFetch({
    '/x/v2/reply/reply': json({
      code: 0,
      data: {
        replies: [
          { rpid: 601, root: 900, parent: 777, member: { uname: '回我的', mid: 8 }, content: { message: '接你的话' }, ctime: now },
          { rpid: 602, root: 900, parent: 901, member: { uname: '回别人的', mid: 9 }, content: { message: '不关你事' }, ctime: now },
        ],
      },
    }),
  });
  const hub = new SocialHub({ config: baseCfg({ bilibili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y' } }), brain: { persona: {}, complete: async () => '{}' }, log, dataDir: dir, fetchImpl: fetch });
  hub.bili.state.mid = '42';
  hub.state.myComments['123:777'] = { aid: '123', rpid: '777', root: '900', text: '我在楼里回了一句', title: '测试视频', at: Date.now() - 60_000 };
  const r = await hub.checkReplies();
  assert.equal(r.added, 1);
  assert.equal(hub.recentReplies({ limit: 3 })[0].content, '接你的话');
});


test('SocialHub：刷到的内容攒够后交给蒸馏，成功后清空队列', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-feed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let got = 0;
  const hub = new SocialHub({
    config: baseCfg({ learnFeed: true }),
    brain: { persona: {}, complete: async () => '{}' },
    learner: { learnFeed: async ({ items }) => { got = items.length; return { ok: true, added: 2, wants: ['冰可乐'] }; } },
    log,
    dataDir: dir,
    fetchImpl: fakeFetch(),
  });
  hub.state.feed = [1, 2, 3, 4].map((i) => ({ title: `视频${i}`, desc: '说明', comments: [], at: Date.now() }));
  hub.state.lastFeedAt = 0;
  const r = await hub.learnFromFeed();
  assert.equal(r.ok, true);
  assert.equal(got, 4);
  assert.equal(hub.state.feed.length, 0);
  assert.ok(hub.state.lastFeedAt > 0);
  assert.equal(hub.recentWishes()[0].what, '冰可乐');
});

test('SocialHub：收到回复和待学队列重启后还在', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'social-state.json'), JSON.stringify({
    feed: [{ title: '刷到的', comments: [], at: Date.now() }],
    received: { '123:1': { aid: '123', root: '1', user: '甲', content: '回你', at: Date.now(), video: '测试' } },
    myComments: { '123:2': { aid: '123', rpid: '2', root: '2', text: '我说的', title: '测试', at: Date.now() } },
    seen: {}, acted: {}, days: {},
  }));
  const again = new SocialHub({ config: baseCfg(), brain: { persona: {}, complete: async () => '{}' }, log, dataDir: dir, fetchImpl: fakeFetch() });
  assert.equal(again.state.feed.length, 1);
  assert.equal(again.recentReplies({ limit: 3 }).length, 1);
  assert.equal(Object.keys(again.state.myComments).length, 1);
});

test('SocialHub：默认额度是 12 条评论 / 32 个赞', () => {
  const hub = new SocialHub({ config: { social: { enabled: true, bilibili: { enabled: true } } }, brain: { persona: {} }, log, dataDir: os.tmpdir(), fetchImpl: fakeFetch() });
  const q = hub.quota();
  assert.equal(q.commentPerDay, 12);
  assert.equal(q.likePerDay, 32);
  assert.equal(q.commentsLeft, 12);
  assert.equal(q.likesLeft, 32);
});

test('SocialHub：面板手动「现在刷一轮」可以越过安静时段和最短间隔', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const hub = new SocialHub({
    config: baseCfg({ quietHours: ['00:00-23:59'], minGapMs: 3600_000 }),
    brain: stubBrain('{"action":"comment","text":"手动点一下也算数"}'),
    log,
    dataDir: dir,
    fetchImpl: fetch,
  });
  hub.state.lastActionAt = Date.now();
  const r = await hub.tick({ force: true });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'comment');
  assert.ok(fetch.calls.some((c) => c.url.includes('/reply/add')));
});

test('SocialHub：喜欢的视频会记下想要的东西，带进 QQ 聊天材料', async (t) => {
  const { formatWishes } = await import('../src/social.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch();
  const hub = new SocialHub({
    config: baseCfg(),
    brain: stubBrain('{"action":"like","want":"一杯冰可乐"}'),
    log,
    dataDir: dir,
    fetchImpl: fetch,
  });
  const r = await hub.tick();
  assert.equal(r.action, 'like');
  assert.equal(hub.recentWishes()[0].what, '一杯冰可乐');
  const feed = hub.state.feed[0];
  assert.equal(feed.liked, true);
  assert.equal(feed.want, '一杯冰可乐');
  const text = formatWishes(hub.recentWishes());
  assert.match(text, /冰可乐/);
  assert.match(text, /不许提转账/);
});

test('SocialHub：想要的东西里带转账/链接就丢掉，不记', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = new SocialHub({
    config: baseCfg(),
    brain: stubBrain('{"action":"skip","want":"给我转账50块"}'),
    log,
    dataDir: dir,
    fetchImpl: fakeFetch(),
  });
  await hub.tick();
  assert.equal(hub.recentWishes().length, 0);
});

test('SocialHub：有人回我时，会接一句，并记到 myComments', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-back-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = new SocialHub({
    config: baseCfg(),
    brain: { persona: {}, complete: async () => '{"action":"reply","text":"这话我接住了。"}' },
    log,
    dataDir: dir,
    fetchImpl: fakeFetch(),
  });
  hub.bili.state.cookie = 'SESSDATA=x; bili_jct=csrf';
  hub.state.myComments['117:100'] = { aid: '117', rpid: '100', root: '', text: '我先说一句', title: '测试视频', at: Date.now() };
  hub.state.received['117:200'] = {
    aid: '117', root: '100', parent: '200', myRpid: '100',
    user: '路人乙', uid: '9', content: '那你说说看', at: Date.now(), video: '测试视频',
  };
  let call = null;
  hub.bili.addComment = async (args) => { call = args; return { rpid: '300', url: 'u' }; };
  const r = await hub.replyIncoming();
  assert.equal(r.action, 'reply');
  assert.equal(r.text, '这话我接住了。');
  assert.equal(call.root, '100');
  assert.equal(call.parent, '200');
  assert.equal(hub.quota().commentsLeft, 11);
  assert.ok(Object.values(hub.state.received)[0].handledAt);
  assert.ok(Object.values(hub.state.acted).some((a) => a.to === '路人乙'));
});
