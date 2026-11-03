import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const call = (name, args = {}) => ({ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } });

/** 本地假图站：/a.jpg 返回 20KB JPEG，/notimg 返回 HTML */
async function imgServer(t) {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20 * 1024, 7)]);
  const server = http.createServer((req, res) => {
    if (req.url === '/a.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(jpeg);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not an image</html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function harness(t, { replies = [], images, dryRun = false, groups } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-pic-'));
  fs.mkdirSync(path.join(dir, 'history'));
  const sent = [];
  const queue = [...replies];
  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16, minGapMs: 0,
      selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 3, maxActionsPerRound: 2,
      dryRun, shareStyleWeights: { talk: 0, link: 0, meme: 0 },
      interestGroups: groups || [{ name: '美图美少女', weight: 100, media: 'image', topics: ['美少女写真'] }],
    },
  };
  const bot = {
    cfg: config,
    groups: new Map(),
    recent: () => [{ role: 'user', name: '阿强', text: '来点好看的', ts: Date.now() - 60_000 }],
    send: async () => 1,
    sendImage: async (scope, file) => {
      // 发送时文件必须还在（证明是先下载再发）
      sent.push({ scope, file, existed: fs.existsSync(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0 });
      return 42;
    },
    onebot: { call: async () => ({}) },
  };
  const brain = { chatWithTools: async () => queue.shift() || { tool_calls: [] } };
  const a = new AgentLoop({
    config, bot, brain, log,
    search: async () => [],
    images: images || (async () => []),
  });
  t.after(() => {
    a.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { a, sent, dir };
}

test('分享图片：先下载、发出去、再删掉下载的原件', async (t) => {
  const base = await imgServer(t);
  const { a, sent, dir } = harness(t, {
    images: async () => [{ title: '好看', url: `${base}/a.jpg` }],
    replies: [
      { tool_calls: [call('share_picture', { keyword: '美少女写真' })] },
      { tool_calls: [call('skip', { reason: '发完了' })] },
    ],
  });
  const out = await a.run({ scope: 'group:1', mode: 'share' });
  const action = out.actions.find((x) => x.name === 'share_picture');
  assert.equal(action.result.ok, true, JSON.stringify(action.result));
  assert.equal(sent.length, 1, '应该发出一张图');
  assert.equal(sent[0].existed, true, '发送的时候文件必须还在');
  assert.ok(sent[0].size > 8 * 1024, '下载到的应当是真图片');
  const tmpDir = path.join(dir, 'tmp');
  const left = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  assert.deepEqual(left, [], '发完要把下载的原件删掉');
});

test('不是图片的地址不下载也不发', async (t) => {
  const base = await imgServer(t);
  const { a, sent } = harness(t, {
    images: async () => [{ title: 'html', url: `${base}/notimg` }],
    replies: [{ tool_calls: [call('share_picture', { keyword: 'x' })] }, { tool_calls: [call('skip', {})] }],
  });
  const out = await a.run({ scope: 'group:1', mode: 'share' });
  const action = out.actions.find((x) => x.name === 'share_picture');
  assert.equal(action.result.ok, false);
  assert.match(String(action.result.error), /不是图片/);
  assert.equal(sent.length, 0);
});

test('搜不到图就让模型换个词，不硬发', async (t) => {
  const { a, sent } = harness(t, {
    images: async () => [],
    replies: [{ tool_calls: [call('share_picture', { keyword: 'x' })] }, { tool_calls: [call('skip', {})] }],
  });
  const out = await a.run({ scope: 'group:1', mode: 'share' });
  const action = out.actions.find((x) => x.name === 'share_picture');
  assert.equal(action.result.ok, false);
  assert.match(String(action.result.error), /没搜到/);
  assert.equal(sent.length, 0);
});

test('美图这一类方向默认走发图', (t) => {
  const { a } = harness(t, { images: async () => [] });
  const styles = new Set();
  let pictureBrief = '';
  for (let i = 0; i < 200; i += 1) {
    const plan = a.sharePlanForTest();
    styles.add(plan.style);
    if (plan.style === 'picture') pictureBrief = plan.brief;
  }
  assert.ok(styles.has('picture'), '应当出现发图这一档');
  assert.ok(!styles.has('link'), '美图类不该去搜文章链接');
  assert.match(pictureBrief, /share_picture/);
  assert.match(pictureBrief, /删掉/);
});
