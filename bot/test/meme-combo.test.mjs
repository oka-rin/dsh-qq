import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Bot } from '../src/bot.mjs';
import { Brain, splitMemeWish } from '../src/brain.mjs';
import { OneBot } from '../src/onebot.mjs';
import { startMockLlm, startMockOneBot } from '../src/mock.mjs';
import { Store } from '../src/store.mjs';
import { Emitter, sleep } from '../src/util.mjs';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('splitMemeWish：文字 + 标记、纯标记、无标记', () => {
  assert.deepEqual(splitMemeWish('行吧，那你去睡\n<meme>猫</meme>'), { text: '行吧，那你去睡', keyword: '猫' });
  assert.deepEqual(splitMemeWish('<meme>无语</meme>'), { text: '', keyword: '无语' });
  assert.deepEqual(splitMemeWish('纯文字'), { text: '纯文字', keyword: '' });
  // 老写法的整条形式仍然认
  const old = splitMemeWish('<表情: 比心>');
  assert.equal(old.keyword, '比心');
  assert.equal(old.text, '');
});

test('回复里带 <meme>：先说话再补图；整条只有标记时只发图', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-meme-combo-'));
  const memeFile = path.join(dir, 'cat.png');
  fs.writeFileSync(memeFile, PNG_1PX);

  const mock = await startMockOneBot({ token: 'combo-token', port: 0, wsPort: 0 });
  const llm = await startMockLlm({
    port: 0,
    replies: ['行吧，那你去睡\n<meme>猫</meme>', '<meme>猫</meme>'],
  });
  const cfg = {
    onebot: { httpUrl: `http://127.0.0.1:${mock.httpPort}`, wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`, accessToken: 'combo-token', selfId: 0 },
    llm: { mode: 'api', baseUrl: `http://127.0.0.1:${llm.port}/v1`, model: 'm', apiKey: 'x', maxTokens: 100, timeoutMs: 5000 },
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: {
      enabled: true, replyOnMention: true, aiDecide: false,
      cooldownMsPerUser: 0, cooldownMsPerGroup: 0, maxRepliesPerMinute: 100,
      historyTurns: 10, quietHours: [],
      splitReplies: { enabled: false },
      maxReplyChars: 200,
      vision: { enabled: false },
      memeCollect: { enabled: false },
    },
    storage: { dataDir: path.join(dir, 'data') },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
  const store = new Store(cfg.storage.dataDir);
  const onebot = new OneBot(cfg.onebot, { log, onStatus: () => {} });
  const brain = new Brain(cfg, { log });
  const memes = { pick: (q) => (String(q).includes('猫') ? { file: memeFile, caption: '点头猫', tag: 'meow' } : null) };
  const bot = new Bot({ config: cfg, onebot, store, brain, memes, log, emitter: new Emitter() });
  await bot.start();
  try {
    assert.ok(await onebot.waitForOpen(5000), '事件流应连上 mock WS');

    // 第一条：一句话 + 一张图
    mock.groupMessage({ message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 还不睡' } }], userId: 20002, name: '阿强' });
    const goal = await mock.waitFor((a) => {
      const segs = Array.isArray(a.params?.message) ? a.params.message : [];
      return segs.some((s) => s.type === 'image');
    }, 8000);
    assert.ok(goal, '应该发出图片消息');

    const sends = mock.sentActions('send_group_msg');
    assert.equal(sends.length, 2, '一句文字 + 一张图，共两条消息');
    const firstSegs = sends[0].params.message;
    assert.ok(firstSegs.some((s) => s.type === 'text' && s.data.text.includes('行吧')), '第一条是文字');
    assert.ok(!firstSegs.some((s) => s.type === 'image'), '第一条不该带图');
    const secondSegs = sends[1].params.message;
    assert.ok(secondSegs.some((s) => s.type === 'image'), '第二条是图');
    assert.ok(secondSegs.find((s) => s.type === 'image').data.file.startsWith('base64://'), '图片走 base64 段');

    const rows = store.tail('group:123456', 8);
    assert.ok(rows.some((r) => (r.text || '').includes('行吧')), '历史里应有文字');
    assert.ok(rows.some((r) => (r.text || '').startsWith('[表情')), '历史里应有表情标注');

    // 第二条：整条只有标记 → 只发图
    const before = mock.sentActions('send_group_msg').length;
    mock.groupMessage({ message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 再说一句' } }], userId: 20002, name: '阿强' });
    const pure = await sleep(1200).then(() => mock.sentActions('send_group_msg').slice(before));
    assert.equal(pure.length, 1, '纯表情包只发一条');
    assert.ok(pure[0].params.message.some((s) => s.type === 'image'));
    assert.ok(!pure[0].params.message.some((s) => s.type === 'text' && String(s.data.text).trim()), '纯表情包不带文字');
  } finally {
    await bot.stop();
    await mock.close();
    await llm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
