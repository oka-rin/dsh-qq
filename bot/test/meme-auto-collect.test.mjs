import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const uploads = [];
let apiServer;
let imgServer;
let mock;
let llm;
let bot;
let onebot;
let store;

const log = { debug(m) { if (process.env.DBG) console.error('[debug]', m); }, info(m) { if (process.env.DBG) console.error('[info]', m); }, warn(m) { if (process.env.DBG) console.error('[warn]', m); }, error() {}, child() { return log; } };

test.before(async () => {
  imgServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'image/gif');
    // 不同 URL 给不同字节，避免同一张图被 sha256 去重
    res.end(Buffer.concat([PNG_1PX, Buffer.from(req.url)]));
  });
  await new Promise((r) => imgServer.listen(0, '127.0.0.1', r));

  apiServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      res.setHeader('content-type', 'application/json');
      if (body.op === 'recognize') {
        res.end(JSON.stringify({ ok: true, tag: 'meow', caption: '点头猫', keywords: '猫 点头' }));
        return;
      }
      if (body.op === 'upload') {
        uploads.push(body);
        res.end(JSON.stringify({ ok: true, meme: { path: `memes/${body.tag}/x.gif`, tag: body.tag, caption: body.caption } }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'bad op' }));
    });
  });
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
  process.env.MEME_API = `http://127.0.0.1:${apiServer.address().port}/dsh-memes-api`;

  const { startMockLlm, startMockOneBot } = await import('../src/mock.mjs');
  const { Bot } = await import('../src/bot.mjs');
  const { Brain } = await import('../src/brain.mjs');
  const { OneBot } = await import('../src/onebot.mjs');
  const { Store } = await import('../src/store.mjs');
  const { Emitter } = await import('../src/util.mjs');

  mock = await startMockOneBot({ token: 'meme-token', port: 0, wsPort: 0 });
  llm = await startMockLlm({ port: 0, replies: [] });
  const cfg = {
    onebot: { httpUrl: `http://127.0.0.1:${mock.httpPort}`, wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`, accessToken: 'meme-token' },
    llm: { mode: 'api', baseUrl: llm.baseUrl, model: 'mock', apiKey: 'x', maxTokens: 100, timeoutMs: 5000 },
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: {
      enabled: true, replyOnMention: true, replyOnReplyToMe: true, aiDecide: false,
      keywordTriggers: [], randomInterject: { chance: 0, minGapMs: 600000, minMessagesSeen: 6 },
      cooldownMsPerUser: 0, cooldownMsPerGroup: 0, maxRepliesPerMinute: 100,
      historyTurns: 10, quietHours: [], splitReplies: { enabled: false },
      vision: { enabled: false },
      memeCollect: { enabled: true, maxPerDay: 5, minIntervalMs: 0 },
    },
    storage: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'meme-collect-')) },
  };
  store = new Store(cfg.storage.dataDir);
  onebot = new OneBot(cfg.onebot, { log, onStatus: () => {} });
  const brain = new Brain(cfg, { log });
  bot = new Bot({ config: cfg, onebot, store, brain, log, emitter: new Emitter() });
  await bot.start();
});

test.after(async () => {
  await bot?.stop?.();
  await mock?.close?.();
  await llm?.close?.();
  apiServer?.close();
  imgServer?.close();
});

test('群友发动画表情 → 自动识别并收进图库', async () => {
  const url = `http://127.0.0.1:${imgServer.address().port}/m.gif`;
  // 等 bot 的 WS 连上，否则注入的事件没人接
  const connDeadline = Date.now() + 5000;
  while (Date.now() < connDeadline && mock.sockets === 0) await new Promise((r) => setTimeout(r, 50));
  mock.groupMessage({ message: [{ type: 'image', data: { url, sub_type: 13 } }], userId: 20002, name: '阿强' });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !uploads.length) await new Promise((r) => setTimeout(r, 100));
  assert.equal(uploads.length, 1, '应该入库一张');
  assert.equal(uploads[0].tag, 'meow');
  assert.equal(uploads[0].caption, '点头猫');
});

test('群友发 sub_type 1/7 的表情也要收（不只是 GIF）', async () => {
  const port = imgServer.address().port;
  const before = uploads.length;
  mock.groupMessage({ message: [{ type: 'image', data: { url: `http://127.0.0.1:${port}/a1.gif`, sub_type: 1 } }], userId: 20003, name: '阿强' });
  mock.groupMessage({ message: [{ type: 'image', data: { url: `http://127.0.0.1:${port}/a7.gif`, sub_type: 7 } }], userId: 20003, name: '阿强' });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && uploads.length < before + 2) await new Promise((r) => setTimeout(r, 100));
  assert.equal(uploads.length, before + 2, 'sub_type 1 和 7 各收一张');
});

test('普通图片 sub_type 0 默认不收，allImages 打开后才收', async () => {
  const port = imgServer.address().port;
  const before = uploads.length;
  mock.groupMessage({ message: [{ type: 'image', data: { url: `http://127.0.0.1:${port}/p0.jpg`, sub_type: 0 } }], userId: 20004, name: '阿强' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(uploads.length, before, '普通图片默认不入库');

  bot.cfg.chat.memeCollect.allImages = true;
  mock.groupMessage({ message: [{ type: 'image', data: { url: `http://127.0.0.1:${port}/p0b.jpg`, sub_type: 0 } }], userId: 20004, name: '阿强' });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && uploads.length < before + 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(uploads.length, before + 1, 'allImages=true 后普通图片也收');
});
