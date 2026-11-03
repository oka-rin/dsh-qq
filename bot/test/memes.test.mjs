import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MemeLibrary } from '../src/memes.mjs';

/** 造一个假图库：一张 1x1 PNG + index.db，结构跟 dsh-meme 的真库一致。 */
function makePack(root, id = 'demo-001') {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'memes', 'happy'), { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const rel = path.join('memes', 'happy', 'cat.png');
  fs.writeFileSync(path.join(dir, rel), png);
  const db = new DatabaseSync(path.join(dir, 'index.db'));
  db.exec('CREATE TABLE memes (path TEXT, tag TEXT, file_name TEXT, file_hash TEXT, caption TEXT, keywords TEXT)');
  db.prepare('INSERT INTO memes VALUES (?,?,?,?,?,?)').run(rel, 'happy', 'cat.png', 'h', '一只猫在笑，很开心的样子', '猫 开心 笑');
  db.prepare('INSERT INTO memes VALUES (?,?,?,?,?,?)').run('memes/happy/missing.png', 'happy', 'missing.png', 'h2', '这只猫的图没了', '猫 缺图');
  db.close();
  return dir;
}

test('图库能按关键词挑图，坏路径被跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-lib-'));
  makePack(root);
  const lib = new MemeLibrary({ dirs: [root] });
  assert.deepEqual(lib.packsList().map((p) => p.id), ['demo-001']);

  const rows = lib.list({ q: '猫' });
  assert.equal(rows.length, 1, '缺图的那条要被跳过');
  assert.equal(rows[0].tag, 'happy');
  assert.ok(fs.existsSync(rows[0].file));
  assert.match(rows[0].caption, /一只猫/);

  assert.equal(lib.list({ q: '不存在的词' }).length, 0);
  assert.equal(lib.pick('不存在的词'), null);
  assert.ok(lib.pick('猫'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('图库目录不存在时安静返回空', () => {
  const lib = new MemeLibrary({ dirs: [path.join(os.tmpdir(), 'definitely-not-here-42')] });
  assert.deepEqual(lib.packsList(), []);
  assert.deepEqual(lib.list({ q: '猫' }), []);
});
