import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Bot } from '../src/bot.mjs';
import { OneBot } from '../src/onebot.mjs';
import { Store } from '../src/store.mjs';
import { parseMeme } from '../src/brain.mjs';
import { startMockOneBot } from '../src/mock.mjs';
import { Emitter, sleep } from '../src/util.mjs';

const TOKEN = 'meme-token';
const state = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-meme-'));

before(async () => {
  state.mock = await startMockOneBot({ token: TOKEN });
});
after(async () => {
  await state.mock.close();
});

function makeBot(memeResult) {
  const cfg = {
    onebot: {
      httpUrl: `http://127.0.0.1:${state.mock.httpPort}`,
      wsUrl: `ws://127.0.0.1:${state.mock.wsPort}/event`,
      accessToken: TOKEN,
      selfId: 0,
    },
    storage: { dataDir: path.join(tmp, `d${Math.random().toString(36).slice(2)}`) },
    chat: { enabled: true, replyOnMention: true, historyTurns: 12, maxReplyChars: 160, quietHours: [] },
    persona: { name: '哈基米', style: '毒舌' },
    llm: { mode: 'api', model: 'm', apiKey: 'x', maxTokens: 100 },
  };
  const store = new Store(cfg.storage.dataDir);
  const onebot = new OneBot(cfg.onebot, {});
  const brain = { generate: async () => ({ texts: [memeResult] }), systemPrompt: () => 'x' };
  const bot = new Bot({ config: cfg, onebot, store, brain, log: { info() {}, warn() {}, error() {}, debug() {} }, emitter: new Emitter() });
  // 假图库：只认「猫」
  bot.memes = { pick: (q) => (q === '猫' ? { file: '/tmp/fake-cat.jpg', caption: '卖萌小猫', tag: 'happy' } : null) };
  bot.sendImage = async (scope, file, opts) => {
    bot.sentImage = { scope, file, opts };
    return 4321;
  };
  return bot;
}

test('parseMeme 只认整条标记，文字里夹带不算', () => {
  assert.deepEqual(parseMeme('<meme>猫</meme>'), { keyword: '猫' });
  assert.deepEqual(parseMeme('<表情包>生气>'), { keyword: '生气' });
  assert.equal(parseMeme('发个图 <meme>猫</meme> 你看'), null);
  assert.equal(parseMeme('普通一句话'), null);
});

test('模型只想回图时，机器人发图片而不是文字', async () => {
  const bot = makeBot('<meme>猫</meme>');
  await bot.start();
  await sleep(400); // 等 WS 真正连上再注入，否则事件会丢
  try {
    state.mock.groupMessage({ groupId: 123456, userId: 20002, name: '阿强', message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 来张图' } }] });
    for (let i = 0; i < 100 && !bot.sentImage; i += 1) await sleep(30);
    assert.ok(bot.sentImage, '应该发了图');
    assert.equal(bot.sentImage.file, '/tmp/fake-cat.jpg');
    assert.equal(bot.sentImage.opts.caption, '卖萌小猫');
    const texts = state.mock.sentTexts().filter((t) => t.action === 'send_group_msg');
    assert.equal(texts.length, 0, '不应再发文字');
  } finally {
    await bot.stop();
  }
});

test('图库里没这张就退回文字，不哑火', async () => {
  const bot = makeBot('<meme>外星章鱼</meme>');
  await bot.start();
  await sleep(400); // 等 WS 真正连上再注入，否则事件会丢
  try {
    state.mock.groupMessage({ groupId: 123456, userId: 20002, name: '阿强', message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 来张图' } }] });
    for (let i = 0; i < 100 && state.mock.sentTexts().length === 0; i += 1) await sleep(30);
    assert.equal(bot.sentImage, undefined);
    assert.ok(state.mock.sentTexts().length > 0, '应该退回发文字');
  } finally {
    await bot.stop();
  }
});
