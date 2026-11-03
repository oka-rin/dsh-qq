/**
 * 续图场景（2026-11-02 真实翻车复现）：
 * 用户画完图后说「图片又过期了，重发」「还没得吗」，机器人却在聊天里编「显卡正在算」，
 * 用户被遛了半小时也没拿到图。这里锁住三条行为：
 *   ① 图过期 → 直接重发上一张（不重画、不聊天）
 *   ② 催进度 → 如实说「还在画/没在画」，不许交给模型自由发挥
 *   ③ 上一张已存盘：draw-state.json 能跨重启记住
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Bot } from '../src/bot.mjs';
import { OneBot } from '../src/onebot.mjs';
import { Store } from '../src/store.mjs';
import { startMockOneBot } from '../src/mock.mjs';
import { Emitter, sleep } from '../src/util.mjs';

const state = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-draw-continue-'));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function freshMock() {
  const mock = await startMockOneBot({ port: 0, wsPort: 0 });
  return mock;
}

function makeBot({ mock, lastFile = '', lastPrompt = '', drawing = 0, withBrain = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'd-'));
  const cfg = {
    onebot: {
      httpUrl: `http://127.0.0.1:${mock.httpPort}`,
      wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`,
      accessToken: '',
      selfId: 0,
    },
    storage: { dataDir },
    chat: {
      enabled: true,
      historyTurns: 12,
      maxReplyChars: 160,
      quietHours: [],
      replyPrivate: true,
      cooldownMsPerUser: 0,
      cooldownMsPerGroup: 0,
      draw: { enabled: true, maxPerDay: 6, minIntervalMs: 0, size: '1024x1024' },
    },
    image: { enabled: true, promptBrain: { enabled: false } },
    persona: { name: '哈基米', style: '毒舌' },
    llm: { mode: 'api', model: 'm', apiKey: 'x', maxTokens: 100 },
  };
  fs.writeFileSync(
    path.join(dataDir, 'draw-state.json'),
    JSON.stringify({
      'private:20002': { day: new Date().toISOString().slice(0, 10), count: 1, last: Date.now(), lastFile, lastPrompt, lastAt: Date.now() - 60000, drawing },
    }),
  );
  const store = new Store(dataDir);
  const onebot = new OneBot(cfg.onebot, { log: { info() {}, warn() {}, error() {}, debug() {} } });
  const brain = {
    called: 0,
    generate: async () => {
      brain.called += 1;
      return { texts: ['模型自由发挥的一句话'] };
    },
    systemPrompt: () => 'x',
  };
  const bot = new Bot({
    config: cfg,
    onebot,
    store,
    brain: withBrain ? brain : null,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    emitter: new Emitter(),
  });
  bot.brainForTest = brain;
  return bot;
}

test('图过期了说「重发」：直接把上一张再发一遍，不重画也不聊天', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'img-'));
  const file = path.join(dir, 'last.png');
  fs.writeFileSync(file, PNG);
  const mock = await freshMock();
  const bot = makeBot({ mock, lastFile: file, lastPrompt: '银发紫眸的少女' });
  await bot.start();
  await sleep(600);
  try {
    mock.privateMessage({ userId: 20002, name: '阿强', message: [{ type: 'text', data: { text: '图片又过期了，重发' } }] });
    for (let i = 0; i < 100 && mock.sentActions('send_private_msg').length === 0; i += 1) await sleep(30);
    const sent = mock.sentActions('send_private_msg');
    assert.equal(sent.length, 1, '应该只发一条（图）');
    const segs = sent[0].params.message || [];
    assert.ok(segs.some((s) => s.type === 'image'), '发的必须是图');
    assert.equal(bot.brainForTest.called, 0, '不该走模型聊天');
  } finally {
    await bot.stop();
    await mock.close();
  }
});

test('催进度但没有在画：如实说没在画，不编「显卡在算」', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'img-'));
  const file = path.join(dir, 'last.png');
  fs.writeFileSync(file, PNG);
  const mock = await freshMock();
  const bot = makeBot({ mock, lastFile: file, lastPrompt: '银发紫眸的少女', drawing: 0, withBrain: true });
  await bot.start();
  await sleep(600);
  try {
    mock.privateMessage({ userId: 20002, name: '阿强', message: [{ type: 'text', data: { text: '还没得吗' } }] });
    for (let i = 0; i < 100 && mock.sentTexts().length === 0; i += 1) await sleep(30);
    const texts = mock.sentTexts().join(' | ');
    assert.match(texts, /没在画/, texts);
    assert.equal(bot.brainForTest.called, 0, '这种情况不需要模型开口');
  } finally {
    await bot.stop();
    await mock.close();
  }
});

test('正在画的时候被催：给真实秒数，而不是含糊的「马上」', async () => {
  const mock = await freshMock();
  const bot = makeBot({ mock, drawing: 1 });
  await bot.start();
  await sleep(600);
  try {
    mock.privateMessage({ userId: 20002, name: '阿强', message: [{ type: 'text', data: { text: '画好了吗' } }] });
    for (let i = 0; i < 100 && mock.sentTexts().length === 0; i += 1) await sleep(30);
    const texts = mock.sentTexts().join(' | ');
    assert.match(texts, /还在画/, texts);
  } finally {
    await bot.stop();
    await mock.close();
  }
});

test('正在画的时候又点一张：排队，不拒绝也不丢请求', async () => {
  const mock = await freshMock();
  const bot = makeBot({ mock, drawing: 1 });
  await bot.start();
  await sleep(600);
  try {
    mock.privateMessage({ userId: 20002, name: '阿强', message: [{ type: 'text', data: { text: '再画一张猫猫头' } }] });
    for (let i = 0; i < 100 && mock.sentTexts().length === 0; i += 1) await sleep(30);
    const texts = mock.sentTexts().join(' | ');
    assert.match(texts, /排上了/, texts);
    const st = JSON.parse(fs.readFileSync(bot.drawStatePath, 'utf8'))['private:20002'];
    assert.deepEqual(st.queue, ['再画一张猫猫头'], '请求必须进队列，不能丢');
  } finally {
    await bot.stop();
    await mock.close();
  }
});

test('当天额度用完：如实说额度用完，不装傻也不硬画', async () => {
  const mock = await freshMock();
  const bot = makeBot({ mock, drawing: 0 });
  // 直接把当天计数写进内存状态（机器人启动时会重新读盘，所以改盘会晚一步）
  bot.drawState.set('private:20002', {
    day: new Date().toISOString().slice(0, 10),
    count: 6,
    last: 0,
    lastFile: '',
    lastPrompt: '',
    lastAt: 0,
    drawing: 0,
    queue: [],
  });
  await bot.start();
  await sleep(600);
  try {
    mock.privateMessage({ userId: 20002, name: '阿强', message: [{ type: 'text', data: { text: '画一张猫猫头' } }] });
    for (let i = 0; i < 100 && mock.sentTexts().length === 0; i += 1) await sleep(30);
    const texts = mock.sentTexts().join(' | ');
    assert.match(texts, /额度|画够/, texts);
  } finally {
    await bot.stop();
    await mock.close();
  }
});
