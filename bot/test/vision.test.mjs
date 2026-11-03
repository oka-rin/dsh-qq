import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Bot } from '../src/bot.mjs';
import { Brain } from '../src/brain.mjs';
import { OneBot } from '../src/onebot.mjs';
import { startMockLlm, startMockOneBot } from '../src/mock.mjs';
import { imagesOf } from '../src/segments.mjs';
import { Store } from '../src/store.mjs';
import { Emitter, sleep } from '../src/util.mjs';
import { collectImages } from '../src/vision.mjs';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeConfig(overrides = {}) {
  return {
    llm: { mode: 'echo', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', maxTokens: 100, temperature: 0.5 },
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: {
      maxReplyChars: 160,
      historyChars: 4000,
      historyTurns: 24,
      recentSelfEcho: 5,
      vision: { enabled: true, maxImages: 3, maxBytes: 2000000, timeoutMs: 2000 },
      ...overrides,
    },
  };
}

test('imagesOf 提取图片段的 url/file/子类型', () => {
  const out = imagesOf([
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { url: 'https://example.com/a.gif', file: 'a.gif', sub_type: 13 } },
    { type: 'image', data: { file: 'base64://AAAA' } },
    { type: 'face', data: { id: '1' } },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://example.com/a.gif');
  assert.equal(out[0].subType, 13);
  assert.equal(out[1].file, 'base64://AAAA');
});

test('collectImages：没图就返回空', async () => {
  const history = [{ role: 'user', name: '甲', text: '在吗' }];
  assert.deepEqual(await collectImages(history, makeConfig()), []);
});

test('collectImages：开关关掉就一张不看', async () => {
  const history = [{ role: 'user', name: '甲', text: '[发了一张图]', media: [{ url: 'https://example.com/a.png' }] }];
  const out = await collectImages(history, makeConfig({ vision: { enabled: false } }));
  assert.deepEqual(out, []);
});

test('collectImages：base64 图能转成 data URL，按时间正序标号', async () => {
  const history = [
    { role: 'user', name: '甲', text: '[发了一张图]', media: [{ file: `base64://${PNG_1PX.toString('base64')}`, subType: 0 }] },
    { role: 'bot', name: '哈基米', text: '收到' },
    { role: 'user', name: '乙', text: '[发了一张图]', media: [{ file: `base64://${PNG_1PX.toString('base64')}`, subType: 13 }] },
  ];
  const out = await collectImages(history, makeConfig());
  assert.equal(out.length, 2);
  assert.equal(out[0].label, '图1');
  assert.equal(out[0].from, '甲');
  assert.equal(out[0].kind, 'image');
  assert.ok(out[0].dataUrl.startsWith('data:image/'));
  assert.equal(out[1].label, '图2');
  assert.equal(out[1].kind, 'face');
});

test('collectImages：下载失败只是少一张，不抛错', async () => {
  const history = [{ role: 'user', name: '甲', text: '[发了一张图]', media: [{ url: 'http://127.0.0.1:1/nope.png' }] }];
  const out = await collectImages(history, makeConfig({ vision: { enabled: true, maxImages: 2, maxBytes: 100000, timeoutMs: 500 } }));
  assert.deepEqual(out, []);
});

test('buildMessages：有图时挂 image_url，并在转录里标出图号', () => {
  const brain = new Brain(makeConfig(), { log: { debug() {}, info() {}, warn() {}, error() {} } });
  const imgRow = { role: 'user', name: '测试用户丙', text: '[发了一张图]', at: Date.now() };
  const images = [{ row: imgRow, label: '图1', from: '测试用户丙', kind: 'face', dataUrl: 'data:image/gif;base64,AAAA' }];
  const msgs = brain.buildMessages({
    history: [imgRow, { role: 'user', name: '测试用户丙', text: '@哈基米 这AI怎么感觉颠颠的', at: Date.now() + 1 }],
    scopeLabel: 'QQ 群「测试群」',
    groupInfo: '群号 1，3 人',
    triggerReason: 'mention',
    images,
  });
  assert.equal(msgs.length, 2);
  const content = msgs[1].content;
  assert.ok(Array.isArray(content), 'user 消息应变成数组');
  const textPart = content[0].text;
  assert.match(textPart, /图1/);
  assert.match(textPart, /\[发了一张图·图1\]/);
  const imgs = content.filter((p) => p.type === 'image_url');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].image_url.url, 'data:image/gif;base64,AAAA');
});

test('buildMessages：没图时仍是纯字符串（老链路不变）', () => {
  const brain = new Brain(makeConfig(), { log: { debug() {}, info() {}, warn() {}, error() {} } });
  const msgs = brain.buildMessages({
    history: [{ role: 'user', name: '甲', text: '在吗', at: Date.now() }],
    scopeLabel: 'QQ 群「测试群」',
    groupInfo: '',
    triggerReason: 'mention',
    images: [],
  });
  assert.equal(typeof msgs[1].content, 'string');
});

test('端到端：群里发的图会真的作为 image_url 进请求', async () => {
  const mock = await startMockOneBot({ token: 'vision-token', port: 0, wsPort: 0 });
  const llm = await startMockLlm({ port: 0, replies: ['看见那张图了'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-vision-'));
  const cfg = {
    onebot: {
      httpUrl: `http://127.0.0.1:${mock.httpPort}`,
      wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`,
      accessToken: 'vision-token',
      selfId: 0,
    },
    llm: { mode: 'api', baseUrl: `http://127.0.0.1:${llm.port}/v1`, model: 'm', apiKey: 'x', maxTokens: 100, timeoutMs: 5000 },
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: {
      enabled: true,
      replyOnMention: true,
      aiDecide: false,
      cooldownMsPerUser: 0,
      cooldownMsPerGroup: 0,
      maxRepliesPerMinute: 100,
      historyTurns: 10,
      quietHours: [],
      splitReplies: { enabled: true, maxLen: 60, pauseMs: 5 },
      maxReplyChars: 200,
      vision: { enabled: true, maxImages: 2, maxBytes: 2000000, timeoutMs: 5000 },
    },
    storage: { dataDir: path.join(dir, 'data') },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
  const store = new Store(cfg.storage.dataDir);
  const onebot = new OneBot(cfg.onebot, { log, onStatus: () => {} });
  const brain = new Brain(cfg, { log });
  const bot = new Bot({ config: cfg, onebot, store, brain, log, emitter: new Emitter() });
  await bot.start();
  try {
    assert.ok(await onebot.waitForOpen(5000), '事件流应连上 mock WS');
    mock.groupMessage({
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 这图啥意思' } },
        { type: 'image', data: { file: `base64://${PNG_1PX.toString('base64')}`, sub_type: 13 } },
      ],
      userId: 20002,
      name: '测试用户丙',
    });
    for (let i = 0; i < 100 && !llm.requests.length; i += 1) await sleep(30);
    assert.equal(llm.requests.length, 1, '应该打了一次模型请求');
    const content = llm.requests[0].messages[1].content;
    assert.ok(Array.isArray(content), 'user 消息应该是数组');
    const img = content.find((p) => p.type === 'image_url');
    assert.ok(img, '应该带 image_url 段');
    assert.ok(img.image_url.url.startsWith('data:image/'), '图片应是 data URL');
    assert.match(content[0].text, /发了一张图·图1/, '转录里应标出图号');
    const rows = store.tail('group:123456', 5);
    assert.ok(rows.some((r) => Array.isArray(r.media) && r.media.length), '落库的行上应记下图片位置');
  } finally {
    await bot.stop();
    await mock.close();
    await llm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同一张 CDN 图连回两轮只下载一次（有 2 分钟缓存）', async () => {
  const http = await import('node:http');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_1PX);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/a.png`;
  const history = [{ role: 'user', name: '甲', text: '[发了一张图]', media: [{ url }] }];
  const cfg = makeConfig();
  try {
    const first = await collectImages(history, cfg);
    const second = await collectImages(history, cfg);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(second[0].dataUrl, first[0].dataUrl);
    assert.equal(hits, 1, '第二次应命中缓存');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
