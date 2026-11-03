import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QzoneSocial, looksDirectedAtMe } from '../src/qzone.mjs';
import { AgentLoop } from '../src/agent.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const call = (name, args = {}) => ({ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } });
const now = () => Math.floor(Date.now() / 1000);

/** 假的 OneBot：记下发出去的动作，按 action 返回预设数据 */
function fakeOnebot(handlers = {}) {
  const calls = [];
  return {
    calls,
    onebot: {
      call: async (action, params) => {
        calls.push({ action, params });
        const h = handlers[action];
        if (typeof h === 'function') return h(params);
        return { status: 'ok', data: {} };
      },
    },
  };
}

const baseCfg = (qzone = {}) => ({
  onebot: { selfId: '10000002' },
  chat: {
    qzone: { enabled: true, replyPerDay: 6, commentPerDay: 2, minGapMs: 0, quietHours: [], dryRun: false, ...qzone },
  },
});

test('pendingReplies：只挑别人的、没回过的评论，自己的和已回的跳过', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fakeOnebot({
    get_qzone_msg_list: () => ({ status: 'ok', data: { msglist: [{ tid: 'p1', content: '我的说说', time: now(), comment_num: 2 }] } }),
    get_qzone_msg_detail: () => ({
      status: 'ok',
      data: {
        tid: 'p1',
        content: '我的说说',
        comment_num: 2,
        comments: [
          { comment_id: '111', uin: 8888, name: '阿强', content: '这条有意思' },
          { comment_id: '112', uin: 10000002, name: '我自己', content: '自己回自己' },
        ],
      },
    }),
  });
  const q = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: dir });
  const list = await q.pendingReplies();
  assert.equal(list.length, 1);
  assert.equal(list[0].commentId, '111');
  assert.equal(list[0].commentUin, '8888');
});

test('replyToComment：发出去、记账、同一条不会回第二次', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fakeOnebot({ comment_qzone: () => ({ status: 'ok', data: { comment_id: '999' } }) });
  const q = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: dir });
  const r = await q.replyToComment({ tid: 'p1', commentId: '111', commentUin: 8888, content: '确实是这样' });
  assert.equal(r.ok, true);
  const sent = f.calls.find((c) => c.action === 'comment_qzone');
  assert.equal(sent.params.tid, 'p1');
  assert.equal(sent.params.comment_id, '111');
  assert.equal(sent.params.comment_uin, 8888);
  assert.equal(sent.params.target_uin, 10000002); // 默认评在自己的说说上
  await assert.rejects(() => q.replyToComment({ tid: 'p1', commentId: '111', commentUin: 8888, content: '再回一次' }), /已经回过了/);
});

test('replyToComment：每日上限和敏感内容拦得住', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fakeOnebot({ comment_qzone: () => ({ status: 'ok', data: {} }) });
  const q = new QzoneSocial({ config: baseCfg({ replyPerDay: 1, alwaysReply: false }), bot: f, log, dataDir: dir });
  await q.replyToComment({ tid: 'p1', commentId: '1', commentUin: 8888, content: '第一句' });
  await assert.rejects(() => q.replyToComment({ tid: 'p1', commentId: '2', commentUin: 8888, content: '第二句' }), /额度/);
  const q2 = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: path.join(dir, 'b') });
  await assert.rejects(() => q2.replyToComment({ tid: 'p2', commentId: '3', commentUin: 8888, content: '赌博网站了解一下' }), /敏感/);
});

test('pendingReplies：评论里有敏感内容就不回，并记账跳过', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fakeOnebot({
    get_qzone_msg_list: () => ({ status: 'ok', data: { msglist: [{ tid: 'p1', content: '我的说说', time: now() }] } }),
    get_qzone_msg_detail: () => ({
      status: 'ok',
      data: { tid: 'p1', content: '我的说说', comments: [{ comment_id: '9', uin: 777, name: '某人', content: '赌博网站了解一下' }] },
    }),
  });
  const q = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: dir });
  const list = await q.pendingReplies();
  assert.equal(list.length, 0);
  assert.equal(q.state.replied['p1#9'].skip, 'sensitive');
});

test('friendFeeds：滤掉自己、广告、太短、太老、已评过的', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = now() - 3600 * 72;
  const f = fakeOnebot({
    get_qzone_feeds: () => ({
      status: 'ok',
      data: {
        feeds: [
          { tid: 'a', uin: '8888', nickname: '阿强', content: '今天钓到一条大鱼，晚上加餐', time: now(), appid: '311' },
          { tid: 'b', uin: '10000002', nickname: '我', content: '我自己的说说内容', time: now(), appid: '311' },
          { tid: 'c', uin: '0', nickname: '', time: now(), appid: '6600' },
          { tid: 'd', uin: '9999', nickname: '老王', content: '短', time: now(), appid: '311' },
          { tid: 'e', uin: '7777', nickname: '老李', content: '这条是三天前发的老说说了', time: old, appid: '311' },
        ],
      },
    }),
  });
  const q = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: dir });
  const feeds = await q.friendFeeds({});
  assert.deepEqual(feeds.map((x) => x.tid), ['a']);
});

test('commentPost：评完记账，同一条不会评两次；dryRun 不发只记日志', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fakeOnebot({ comment_qzone: () => ({ status: 'ok', data: { comment_id: '1' } }) });
  const q = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: dir });
  await q.commentPost({ tid: 'a', targetUin: 8888, content: '好家伙，这鱼够吃一天' });
  assert.equal(f.calls.filter((c) => c.action === 'comment_qzone').length, 1);
  await assert.rejects(() => q.commentPost({ tid: 'a', targetUin: 8888, content: '再评一次' }), /已经评过/);

  const f2 = fakeOnebot({});
  const q2 = new QzoneSocial({ config: baseCfg({ dryRun: true }), bot: f2, log, dataDir: path.join(dir, 'dry') });
  const r = await q2.commentPost({ tid: 'x', targetUin: 8888, content: '演练一下' });
  assert.equal(r.dryRun, true);
  assert.equal(f2.calls.length, 0);
});

test('qzone_inbox / qzone_reply：agent 能读到待回评论并回出去', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'history'));
  const f = fakeOnebot({
    get_qzone_msg_list: () => ({ status: 'ok', data: { msglist: [{ tid: 'p1', content: '我的说说', time: now() }] } }),
    get_qzone_msg_detail: () => ({
      status: 'ok',
      data: { tid: 'p1', content: '我的说说', comments: [{ comment_id: '111', uin: 8888, name: '阿强', content: '你这条我喜欢' }] },
    }),
    get_qzone_feeds: () => ({ status: 'ok', data: { feeds: [] } }),
    comment_qzone: () => ({ status: 'ok', data: { comment_id: '900' } }),
  });
  f.cfg = baseCfg();
  f.selfId = '10000002';
  f.groups = new Map();
  f.recent = () => [{ role: 'user', name: '阿强', text: '随便说点', ts: Date.now() - 60_000 }];
  f.send = async () => 1;
  const qzone = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: dir });

  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16, minGapMs: 0,
      selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 3, maxActionsPerRound: 1,
    },
  };
  const replies = [
    { tool_calls: [call('qzone_inbox', {})] },
    { tool_calls: [call('qzone_reply', { tid: 'p1', comment_id: '111', comment_uin: 8888, content: '喜欢就好' })] },
    { tool_calls: [] },
  ];
  const brain = { chatWithTools: async () => replies.shift() || { tool_calls: [] } };
  const a = new AgentLoop({ config, bot: f, brain, log, qzone, search: async () => [], images: async () => [] });
  t.after(() => {
    a.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const inbox = await a.run('group:1', { reason: 'test' });
  const inboxAction = (inbox.actions || []).find((x) => x.name === 'qzone_inbox');
  assert.ok(inboxAction, '应该读空间');
  assert.equal(inboxAction.result.replies[0].commentId, '111');

  const out = await a.run('group:1', { reason: 'test' });
  const replyAction = (out.actions || []).find((x) => x.name === 'qzone_reply');
  assert.ok(replyAction, '应该回评论');
  assert.equal(replyAction.result.ok, true);
});

test('alwaysReply：指向我的评论不受额度和间隔限制，必回', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fakeOnebot({ comment_qzone: () => ({ status: 'ok', data: {} }) });
  const q = new QzoneSocial({
    config: baseCfg({ alwaysReply: true, replyPerDay: 0, minGapMs: 3600_000 }),
    bot: f,
    log,
    dataDir: dir,
  });
  // 额度 0、间隔 1 小时，但必回开着：两条连着回都不该被拦
  await q.replyToComment({ tid: 'p1', commentId: '1', commentUin: 8888, content: '第一句' });
  await q.replyToComment({ tid: 'p1', commentId: '2', commentUin: 8888, content: '第二句' });
  assert.equal(q.state.replied['p1#1'] !== undefined, true);
  assert.equal(q.state.replied['p1#2'] !== undefined, true);
  assert.equal(q.quota().repliesLeft, -1);
});

test('agent.replyQzonePending：有评论就自动生成一句回过去，不用模型自己决定', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'history'));
  const f = fakeOnebot({
    get_qzone_msg_list: () => ({ status: 'ok', data: { msglist: [{ tid: 'p1', content: '我的说说', time: now() }] } }),
    get_qzone_msg_detail: () => ({
      status: 'ok',
      data: { tid: 'p1', content: '我的说说', comments: [{ comment_id: '111', uin: 8888, name: '阿强', content: '你这条我喜欢' }] },
    }),
    comment_qzone: () => ({ status: 'ok', data: { comment_id: '900' } }),
  });
  f.cfg = baseCfg();
  f.selfId = '10000002';
  f.groups = new Map();
  f.recent = () => [];
  f.send = async () => 1;
  const qzone = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: dir });
  const config = {
    storage: { dataDir: dir },
    agent: { enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16, minGapMs: 0, everyMinutes: 1, maxSteps: 2 },
  };
  const brain = {
    complete: async () => '「喜欢就好，下次多留两句」',
    chatWithTools: async () => ({ tool_calls: [] }),
  };
  const a = new AgentLoop({ config, bot: f, brain, log, qzone, search: async () => [], images: async () => [] });
  t.after(() => a.stop());
  const out = await a.replyQzonePending({ max: 3 });
  assert.equal(out.replied, 1);
  const sent = f.calls.find((c) => c.action === 'comment_qzone');
  assert.ok(sent, '应该真把回复发出去了');
  assert.match(sent.params.content, /喜欢就好/);
  assert.equal(qzone.state.replied['p1#111'] !== undefined, true);
});

test('looksDirectedAtMe：叫名字/@我/回我/用「你」算指向我，闲聊不算', () => {
  const me = { selfId: '10000002', selfName: '哈基米' };
  assert.equal(looksDirectedAtMe({ text: '哈基米你也在玩这个？', ...me }), true);
  assert.equal(looksDirectedAtMe({ text: '@哈基米 出来', ...me }), true);
  assert.equal(looksDirectedAtMe({ text: '10000002 在吗', ...me }), true);
  assert.equal(looksDirectedAtMe({ text: '你这条说到我心里了', ...me }), true);
  assert.equal(looksDirectedAtMe({ text: '路过', replyUin: '10000002', ...me }), true);
  assert.equal(looksDirectedAtMe({ text: '这游戏我也在玩，最近掉帧严重', ...me }), false);
  assert.equal(looksDirectedAtMe({ text: '哈哈哈确实', ...me }), false);
});

test('replyQzonePending：只自动回指向我的，没指向的留给模型自己决定', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'history'));
  const f = fakeOnebot({
    get_qzone_msg_list: () => ({ status: 'ok', data: { msglist: [{ tid: 'p1', content: '我的说说', time: now() }] } }),
    get_qzone_msg_detail: () => ({
      status: 'ok',
      data: {
        tid: 'p1',
        content: '我的说说',
        comments: [
          { comment_id: '1', uin: 8888, name: '阿强', content: '你这话说得对' },
          { comment_id: '2', uin: 9999, name: '小李', content: '确实，我也遇到过' },
        ],
      },
    }),
    comment_qzone: () => ({ status: 'ok', data: { comment_id: '900' } }),
  });
  f.cfg = baseCfg();
  f.selfId = '10000002';
  f.groups = new Map();
  f.recent = () => [];
  f.send = async () => 1;
  const qzone = new QzoneSocial({ config: baseCfg(), bot: f, log, dataDir: dir });
  const config = {
    storage: { dataDir: dir },
    agent: { enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16, minGapMs: 0, everyMinutes: 1, maxSteps: 2 },
  };
  const brain = { complete: async () => '说得对', chatWithTools: async () => ({ tool_calls: [] }) };
  const a = new AgentLoop({ config, bot: f, brain, log, qzone, search: async () => [], images: async () => [] });
  t.after(() => a.stop());
  const out = await a.replyQzonePending({ max: 4 });
  assert.equal(out.replied, 1, '只回「你…」那条');
  assert.equal(out.leftToMe, 1, '闲聊那条留给模型');
  assert.equal(qzone.state.replied['p1#1'] !== undefined, true);
  assert.equal(qzone.state.replied['p1#2'], undefined, '没指向的不该被自动记账');
});
