import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { Brain } from '../src/brain.mjs';
import { Bot } from '../src/bot.mjs';
import { ControlServer } from '../src/control.mjs';
import { OneBot } from '../src/onebot.mjs';
import { Store } from '../src/store.mjs';
import { startMockLlm, startMockOneBot } from '../src/mock.mjs';
import { Emitter, sleep } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'sekret-token';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-qq-test-'));
const state = {};

let dirSeq = 0;
function makeConfig(overrides = {}) {
  return {
    onebot: {
      httpUrl: `http://127.0.0.1:${state.mock.httpPort}`,
      wsUrl: `ws://127.0.0.1:${state.mock.wsPort}/event`,
      accessToken: TOKEN,
      selfId: 0,
    },
    control: { host: '127.0.0.1', port: 0, token: '' },
    llm: {
      mode: 'api',
      baseUrl: `http://127.0.0.1:${state.llm.port}/v1`,
      model: 'mock-model',
      apiKeyEnv: 'NOT_SET_FOR_TEST',
      apiKey: 'test-key',
      temperature: 1,
      maxTokens: 100,
      timeoutMs: 5000,
    },
    persona: {
      name: '小雪花',
      identity: '群友',
      style: '简短口语',
      likes: ['游戏'],
      rules: ['一次一两句'],
    },
    chat: {
      enabled: true,
      replyPrivate: true,
      replyOnMention: true,
      replyOnReplyToMe: true,
      keywordTriggers: [],
      randomInterject: { chance: 0, minGapMs: 600000, minMessagesSeen: 6 },
      cooldownMsPerUser: 0,
      cooldownMsPerGroup: 0,
      maxRepliesPerMinute: 100,
      historyTurns: 10,
      quietHours: [],
      ignoreSelf: true,
      whitelistGroups: [],
      blacklistGroups: [],
      muteGroups: [],
      splitReplies: { enabled: true, maxLen: 60, pauseMs: 5 },
      maxReplyChars: 200,
    },
    storage: { dataDir: path.join(tmp, `data-${(dirSeq += 1)}`) },
  };
}

async function buildBot(cfg) {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  const emitter = new Emitter();
  const store = new Store(cfg.storage.dataDir);
  const onebot = new OneBot(cfg.onebot, { log, onStatus: () => {} });
  const brain = new Brain(cfg, { log });
  const bot = new Bot({ config: cfg, onebot, store, brain, log, emitter });
  await bot.start();
  const open = await onebot.waitForOpen(5000);
  assert.ok(open, '事件流应该连上 mock WS');
  return { bot, onebot, store, brain, emitter, log, cfg };
}

before(async () => {
  state.mock = await startMockOneBot({ token: TOKEN, port: 0, wsPort: 0 });
  state.llm = await startMockLlm({ port: 0, replies: [] });
});

after(async () => {
  await state.mock.close();
  await state.llm.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('@ 机器人会触发回复，并带引用、落库', async (t) => {
  const cfg = makeConfig();
  state.llm.pushReply('在的在的，刚在打游戏');
  const { bot, onebot, store } = await buildBot(cfg);
  const mock = state.mock;
  const before = mock.sentActions('send_group_msg').length;

  const event = mock.groupMessage({
    message: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 你在吗' } },
    ],
    userId: 20002,
    name: '阿强',
  });

  const send = await mock.waitFor((a) => a.action === 'send_group_msg' && mock.sentActions('send_group_msg').indexOf(a) >= before, 8000);
  assert.ok(send, `应该发出群消息，实际动作：${JSON.stringify(mock.actions.map((a) => a.action))}`);

  const segs = send.params.message;
  assert.equal(segs[0].type, 'reply', '回复应该引用触发它的消息');
  assert.equal(segs[0].data.id, String(event.message_id));
  assert.equal(segs[1].type, 'text');
  assert.match(segs[1].data.text, /在的/);

  const tail = store.tail('group:123456', 5);
  assert.ok(tail.some((r) => r.role === 'bot'), '机器人回复要写进历史');
  assert.ok(tail.some((r) => r.role === 'user' && r.name === '阿强'), '群友消息要写进历史');

  // 提示词里应该包含人设和历史
  const req = state.llm.requests.at(-1);
  assert.match(req.messages[0].content, /小雪花/);
  assert.match(req.messages.at(-1).content, /阿强/);
  assert.equal(req.model, 'mock-model');

  await bot.stop();
  void onebot;
});

test('长回复会被拆成多条短消息', async (t) => {
  const cfg = makeConfig();
  cfg.chat.splitReplies = { enabled: true, maxLen: 6, pauseMs: 5 };
  state.llm.pushReply('好的。那我先去看看。等会回来。');
  const { bot } = await buildBot(cfg);
  const mock = state.mock;
  const beforeCount = mock.sentActions('send_group_msg').length;

  mock.groupMessage({ message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 帮我看看' } }] });
  await mock.waitFor(() => mock.sentActions('send_group_msg').length >= beforeCount + 2, 8000);

  const collected = () =>
    mock
      .sentActions('send_group_msg')
      .slice(beforeCount)
      .map((a) => a.params.message.filter((s) => s.type === 'text').map((s) => s.data.text).join(''));
  const expected = '好的。那我先去看看。等会回来。';
  const deadline = Date.now() + 5000;
  while (collected().join('') !== expected && Date.now() < deadline) await sleep(30);
  const texts = collected();
  assert.ok(texts.length >= 2, `应该拆成多条，实际：${JSON.stringify(texts)}`);
  for (const t1 of texts) assert.ok(t1.length <= 6, `每段不应超过 6 字：${t1}`);
  assert.equal(texts.join(''), expected, '拆分后拼起来要和原文一致');
  await bot.stop();
  void t;
});

test('普通聊天在 randomInterject=0 时不会插嘴', async () => {
  const cfg = makeConfig();
  const { bot } = await buildBot(cfg);
  const mock = state.mock;
  const before = mock.sentActions('send_group_msg').length;
  mock.groupMessage({ message: '今天中午吃什么啊，好纠结' });
  await sleep(800);
  assert.equal(mock.sentActions('send_group_msg').length, before, '没有 @ 就不该说话');
  await bot.stop();
});

test('关掉自动聊天后 @ 也不说话；私聊仍然能触发', async () => {
  const cfg = makeConfig();
  state.llm.pushReply('私聊收到');
  const { bot } = await buildBot(cfg);
  const mock = state.mock;
  bot.setAutochat('group:123456', false);
  const beforeGroup = mock.sentActions('send_group_msg').length;
  mock.groupMessage({ message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 在吗' } }] });
  await sleep(600);
  assert.equal(mock.sentActions('send_group_msg').length, beforeGroup, '关掉后不应在群里发言');

  const beforePrivate = mock.sentActions('send_private_msg').length;
  mock.privateMessage({ userId: 30003, name: '小明', message: '你好呀' });
  await mock.waitFor(() => mock.sentActions('send_private_msg').length > beforePrivate, 8000);
  const sent = mock.sentActions('send_private_msg').at(-1);
  assert.equal(sent.params.user_id, 30003);
  assert.match(sent.params.message.at(-1).data.text, /私聊收到/);
  await bot.stop();
});

test('控制台 API：发送 / 读历史 / 自动聊天开关 / raw 动作', async () => {
  const cfg = makeConfig();
  const { bot } = await buildBot(cfg);
  const control = new ControlServer({ config: cfg, bot, log: { info() {}, error() {}, child: () => ({ info() {}, error() {} }) }, emitter: new Emitter() });
  await control.listen();
  const port = control.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, opts) => {
    const res = await fetch(base + p, opts);
    return { status: res.status, json: await res.json() };
  };

  const status = await call('/api/status');
  assert.equal(status.json.selfId, '10001');
  assert.equal(status.json.nickname, '小雪花');

  const sendRes = await call('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'group:654321', text: '手动插一句话' }),
  });
  assert.equal(sendRes.json.ok, true);
  const sent = state.mock.sentActions('send_group_msg').at(-1);
  assert.equal(sent.params.group_id, 654321);
  assert.equal(sent.params.message[0].data.text, '手动插一句话');

  const history = await call('/api/messages?scope=group%3A654321&limit=5');
  assert.ok(Array.isArray(history.json));
  assert.ok(history.json.some((r) => r.text === '手动插一句话'));

  const off = await call('/api/autochat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'group:654321', enabled: false }),
  });
  assert.ok(off.json.autochat === 0 || off.json.autochat === false, '自动聊天应已关闭');

  const raw = await call('/api/raw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get_group_list', params: {} }),
  });
  assert.equal(raw.json.data.length, 2);

  const bad = await call('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'oops', text: 'x' }),
  });
  assert.equal(bad.status, 400);

  const dash = await fetch(base + '/');
  assert.match(await dash.text(), /SnowLuma/);
  await control.close();
  await bot.stop();
});

test('MCP stdio：initialize / tools/list / tools/call 能发消息', async () => {
  const cfg = makeConfig();
  const { bot } = await buildBot(cfg);
  const control = new ControlServer({ config: cfg, bot, log: { info() {}, error() {}, child: () => ({ info() {}, error() {} }) }, emitter: new Emitter() });
  await control.listen();
  cfg.control.port = control.server.address().port;

  const configPath = path.join(tmp, 'mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'src/mcp.mjs'), '--config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      responses.push(JSON.parse(line));
    }
  });
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const waitFor = async (pred, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = responses.find(pred);
      if (hit) return hit;
      await sleep(30);
    }
    return null;
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } } });
  const init = await waitFor((r) => r.id === 1);
  assert.ok(init, '应该返回 initialize');
  assert.equal(init.result.serverInfo.name, 'snowluma-qq');
  assert.ok(init.result.capabilities.tools);

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await waitFor((r) => r.id === 2);
  const names = list.result.tools.map((x) => x.name);
  for (const n of ['qq_status', 'qq_list_groups', 'qq_send_message', 'qq_raw_action']) {
    assert.ok(names.includes(n), `工具列表应该包含 ${n}`);
  }

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qq_send_message', arguments: { scope: 'group:123456', text: 'MCP 说句话' } } });
  const call = await waitFor((r) => r.id === 3);
  assert.ok(call.result.content[0].text.includes('"sent": true'));
  const sent = state.mock.sentActions('send_group_msg').at(-1);
  assert.equal(sent.params.message[0].data.text, 'MCP 说句话');

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'qq_status', arguments: {} } });
  const st = await waitFor((r) => r.id === 4);
  assert.match(st.result.content[0].text, /10001/);

  child.kill();
  await control.close();
  await bot.stop();
});

test('人设可以被覆盖，提示词随之变化', async () => {
  const cfg = makeConfig();
  const { bot, store, brain } = await buildBot(cfg);
  store.setPersona({ name: '老王', identity: '退休程序员', style: '爱讲冷笑话', rules: ['一句话'] });
  brain.cfg.persona = store.persona();
  state.llm.pushReply('哈哈');
  const beforeCount = state.mock.sentActions('send_group_msg').length;
  state.mock.groupMessage({ message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 讲个笑话' } }] });
  await state.mock.waitFor(() => state.mock.sentActions('send_group_msg').length > beforeCount, 8000);
  const req = state.llm.requests.at(-1);
  assert.match(req.messages[0].content, /老王/);
  await bot.stop();
});
