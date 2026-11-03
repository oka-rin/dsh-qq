import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { Bot } from '../src/bot.mjs';
import { MemeLibrary } from '../src/memes.mjs';
import { OneBot } from '../src/onebot.mjs';
import { Store } from '../src/store.mjs';
import { startMockOneBot } from '../src/mock.mjs';
import { Emitter, sleep } from '../src/util.mjs';

function makePack(root) {
  const dir = path.join(root, 'demo-001');
  fs.mkdirSync(path.join(dir, 'memes', 'happy'), { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const rel = path.join('memes', 'happy', 'cat.png');
  fs.writeFileSync(path.join(dir, rel), png);
  const db = new DatabaseSync(path.join(dir, 'index.db'));
  db.exec('CREATE TABLE memes (path TEXT, tag TEXT, file_name TEXT, file_hash TEXT, caption TEXT, keywords TEXT)');
  db.prepare('INSERT INTO memes VALUES (?,?,?,?,?,?)').run(rel, 'happy', 'cat.png', 'h', '一只猫在笑', '猫 开心');
  db.close();
  return { dir, png };
}

test('sendImage 把图片按 base64 段发出去，并记进历史', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-send-'));
  const { png } = makePack(root);
  const mock = await startMockOneBot({ port: 0, wsPort: 0 });
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'meme-send-data-')));
  const onebot = new OneBot({ httpUrl: `http://127.0.0.1:${mock.httpPort}`, wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`, accessToken: '' });
  const bot = new Bot({
    config: {
      onebot: { selfId: 0 },
      chat: {},
      persona: { name: '测试' },
      storage: { dataDir: store.dataDir },
    },
    onebot,
    store,
    brain: null,
    memes: new MemeLibrary({ dirs: [root] }),
    log: { info() {}, warn() {}, error() {}, debug() {}, child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
    emitter: new Emitter(),
  });

  try {
    const picked = bot.memes.pick('猫');
    assert.ok(picked, '应该挑到图');
    const id = await bot.sendImage('group:123456', picked.file, { caption: picked.caption });
    await sleep(120);
    assert.ok(id != null, '应该拿到 messageId');

    const actions = mock.sentActions('send_group_msg');
    assert.equal(actions.length, 1);
    const seg = actions[0].params.message.at(-1);
    assert.equal(seg.type, 'image');
    assert.match(seg.data.file, /^base64:\/\//);
    const sentBytes = Buffer.from(seg.data.file.slice('base64://'.length), 'base64');
    assert.ok(sentBytes.equals(png), '发出去的字节要和文件一致');

    const rows = store.tail('group:123456', 5);
    assert.equal(rows.at(-1).role, 'bot');
    assert.match(rows.at(-1).text, /一只猫在笑/);
  } finally {
    await mock.close();
  }
});

test('图库里没有这张图时返回 null，不抛异常', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-send-empty-'));
  const mock = await startMockOneBot({ port: 0, wsPort: 0 });
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'meme-send-data2-')));
  const onebot = new OneBot({ httpUrl: `http://127.0.0.1:${mock.httpPort}`, wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`, accessToken: '' });
  const bot = new Bot({
    config: { onebot: { selfId: 0 }, chat: {}, persona: { name: '测试' }, storage: { dataDir: store.dataDir } },
    onebot,
    store,
    brain: null,
    memes: new MemeLibrary({ dirs: [root] }),
    log: { info() {}, warn() {}, error() {}, debug() {}, child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
    emitter: new Emitter(),
  });
  try {
    assert.equal(bot.memes.pick('猫'), null);
    const id = await bot.sendImage('group:123456', path.join(root, 'nope.png'));
    assert.equal(id, null);
    assert.equal(mock.sentActions('send_group_msg').length, 0);
  } finally {
    await mock.close();
  }
});
