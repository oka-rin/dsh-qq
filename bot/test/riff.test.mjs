import test from 'node:test';
import assert from 'node:assert/strict';
import { pickKeywords, parseCandidates, riffCandidates } from '../src/riff.mjs';

test('pickKeywords 抓 2~4 字词，去重并限量', () => {
  const kw = pickKeywords(['阿强: 哈基米的可爱日常', '测试用户甲: 今天又加班'], { limit: 4 });
  assert.equal(kw.length, 4);
  assert.equal(new Set(kw).size, 4);
  assert.ok(kw.every((w) => w.length >= 2 && w.length <= 4));
});

test('parseCandidates 只认「化用句 ||| 出处」且过滤过短过长', () => {
  const rows = parseCandidates('1. 老实上班很枯燥吧 ||| 老实赚钱很枯燥吧\n好 ||| x\n扔水里看米哈游 ||| 哈基米');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].said, '老实上班很枯燥吧');
  assert.equal(rows[1].basedOn, '哈基米');
});

test('riffCandidates 用 stub 模型就能产出候选，失败返回空', async () => {
  const brain = { complete: async () => '老实上班很枯燥吧 ||| 老实赚钱很枯燥吧' };
  const rows = await riffCandidates({ brain, scene: ['阿强: 今天又加班'], memes: [{ name: '哈基米', meaning: '猫' }] });
  assert.equal(rows.length, 1);
  assert.match(rows[0].said, /老实上班/);

  const bad = { complete: async () => { throw new Error('down'); } };
  assert.deepEqual(await riffCandidates({ brain: bad, scene: ['x: y'], memes: [{}] }), []);
  assert.deepEqual(await riffCandidates({ brain, scene: [], memes: [] }), []);
});

test('MemeKB.bump 加热度并打 hit 标记', async () => {
  const { MemeKB } = await import('../src/kb.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbb-'));
  const kb = new MemeKB({ dataDir: dir });
  kb.addMany([{ name: '哈基米', meaning: '猫', heat: 50 }], { source: 'test' });
  const row = kb.bump('哈基米', 5);
  assert.equal(row.heat, 55);
  assert.ok(row.tags.includes('hit'));
  fs.rmSync(dir, { recursive: true, force: true });
});
