import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemeKB, normalizeEntry } from '../src/kb.mjs';
import { scanMemes, WeeklyScan, SEED_QUERIES } from '../src/kb-scan.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));

test('条目会被清洗，坏条目丢弃', () => {
  const e = normalizeEntry({ name: '  泰裤辣 ', meaning: '太酷啦'.repeat(200), heat: 999 });
  assert.equal(e.name, '泰裤辣');
  assert.equal(e.heat, 100);
  assert.ok(e.meaning.length <= 400);
  assert.equal(normalizeEntry({ meaning: '没有名字' }), null);
  assert.equal(normalizeEntry(null), null);
});

test('同名合并、不同名新增、空字段不覆盖', () => {
  const kb = new MemeKB({ dataDir: tmpDir() });
  const first = kb.addMany([{ name: '泰裤辣', meaning: '太酷啦的谐音', heat: 40 }]);
  assert.equal(first.added, 1);
  const second = kb.addMany([{ name: '泰裤辣', meaning: '', heat: 70 }, { name: '显眼包', meaning: '爱出风头的人' }]);
  assert.equal(second.added, 1);
  assert.equal(second.updated, 1);
  const all = kb.all();
  assert.equal(all.length, 2);
  const ta = all.find((x) => x.name === '泰裤辣');
  assert.equal(ta.meaning, '太酷啦的谐音'); // 空值不覆盖
  assert.equal(ta.heat, 70); // 热度取高
});

test('重载后仍在（落盘）', () => {
  const dir = tmpDir();
  new MemeKB({ dataDir: dir }).addMany([{ name: '栓Q', meaning: 'thank you 的谐音' }]);
  const again = new MemeKB({ dataDir: dir });
  assert.equal(again.all().length, 1);
  assert.equal(again.search('栓')[0].name, '栓Q');
});

test('搜索按含义/例句也能命中', () => {
  const kb = new MemeKB({ dataDir: tmpDir() });
  kb.addMany([
    { name: '典中典', meaning: '经典中的经典', example: '这操作典中典' },
    { name: '离谱', meaning: '不合常理' },
  ]);
  assert.equal(kb.search('经典').length, 1);
  assert.equal(kb.search('操作')[0].name, '典中典');
  assert.equal(kb.search('不存在的词').length, 0);
});

test('扫描：模型返回 JSON 就入库，并跳过重复名字', async () => {
  const dir = tmpDir();
  const kb = new MemeKB({ dataDir: dir });
  kb.addMany([{ name: '老梗', meaning: '已经有的' }]);
  let calls = 0;
  const brain = {
    async complete({ prompt }) {
      calls += 1;
      assert.ok(prompt.includes('老梗')); // 已有名字要告诉模型
      return '```json\n[{"name":"新梗A","meaning":"新的A","heat":60},{"name":"老梗","meaning":"重复","heat":80}]\n```';
    },
  };
  const out = await scanMemes({ brain, kb, queries: ['测试查询'], maxCalls: 1, hot: false });
  assert.equal(calls, 1);
  assert.ok(out.total >= 2);
  const names = kb.all().map((x) => x.name);
  assert.ok(names.includes('新梗A'));
  assert.ok(names.includes('老梗'));
  assert.ok(kb.readState().lastScanAt > 0);
});

test('扫描：模型乱返回不炸，条目不增加', async () => {
  const kb = new MemeKB({ dataDir: tmpDir() });
  const before = kb.all().length;
  const brain = { async complete() { return '抱歉我不会'; } };
  const out = await scanMemes({ brain, kb, queries: ['x'], maxCalls: 1, hot: false });
  assert.equal(out.added, 0);
  assert.equal(kb.all().length, before);
});

test('每周调度：不到 7 天不跑，force 就跑', async () => {
  const kb = new MemeKB({ dataDir: tmpDir() });
  kb.writeState({ lastScanAt: Date.now() - 3600_000 });
  let ran = 0;
  const sched = new WeeklyScan({
    brain: { async complete() { ran += 1; return '[]'; } },
    kb,
    everyMs: 7 * 24 * 3600_000,
    enabled: false,
    scanOptions: { queries: ['x'], maxCalls: 1, hot: false },
  });
  const skipped = await sched.run();
  assert.equal(skipped.skipped, 'not-due');
  assert.equal(ran, 0);
  await sched.run({ force: true });
  assert.equal(ran, 1);
});

test('种子查询覆盖热门与小众', () => {
  assert.ok(SEED_QUERIES.length >= 10);
  assert.ok(SEED_QUERIES.some((q) => q.includes('冷门')));
  assert.ok(SEED_QUERIES.some((q) => q.includes('弹幕')));
});

test('质量闸：纯数字/整句话/单字都不要', () => {
  assert.equal(normalizeEntry({ name: '5', meaning: 'x' }), null);
  assert.equal(normalizeEntry({ name: '啊', meaning: 'x' }), null);
  assert.equal(normalizeEntry({ name: '今天下班路上看到一只特别肥的橘猫趴在电动车上睡觉', meaning: 'x' }), null); // 超长整句
  assert.equal(normalizeEntry({ name: '这操作真离谱。', meaning: 'x' }), null); // 句号结尾
  assert.ok(normalizeEntry({ name: '嗑拉了', meaning: '追CP上头' }));
});

test('prune 会清掉历史垃圾条目', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prune-'));
  fs.mkdirSync(path.join(dir, 'kb'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'kb', 'memes.jsonl'),
    [JSON.stringify({ name: '5', meaning: 'x', heat: 60 }), JSON.stringify({ name: '嗑拉了', meaning: '追CP上头', heat: 70 })].join('\n') + '\n',
  );
  const kb = new MemeKB({ dataDir: dir });
  const removed = kb.prune();
  assert.deepEqual(removed, ['5']);
  assert.equal(kb.all().length, 1);
  assert.equal(kb.all()[0].name, '嗑拉了');
});

test('种子查询扩到 30 条以上，覆盖圈层与造梗机制', () => {
  assert.ok(SEED_QUERIES.length >= 30, `只有 ${SEED_QUERIES.length} 条`);
  for (const kw of ['谐音梗', '缩写梗', '缝合', '冷门梗', '电竞']) {
    assert.ok(SEED_QUERIES.some((q) => q.includes(kw)), `缺 ${kw}`);
  }
});

test('造梗能写进库，重复则更新', () => {
  const kb = new MemeKB({ dataDir: tmpDir() });
  const first = kb.addMany([{ name: '赛博摆烂', meaning: '用最少的力气假装在努力', source: 'bot', tags: ['自造'] }]);
  assert.equal(first.added, 1);
  const again = kb.addMany([{ name: '赛博摆烂', meaning: '更准的解释', source: 'bot', tags: ['自造'] }]);
  assert.equal(again.updated, 1);
  assert.equal(kb.search('摆烂')[0].meaning, '更准的解释');
  assert.ok(kb.all()[0].tags.includes('自造'));
});

test('默认走主模型，只有显式 background 才降档', async () => {
  const { Brain } = await import('../src/brain.mjs');
  const cfg = {
    llm: { model: 'main-model', models: { background: 'cheap-model' }, apiKey: 'k', baseUrl: 'http://x', mode: 'api' },
    persona: { name: 'x' },
    chat: {},
  };
  const b = new Brain(cfg, {});
  assert.equal(b.modelFor('chat'), 'main-model');
  assert.equal(b.modelFor('agent'), 'main-model');
  assert.equal(b.modelFor('background'), 'cheap-model');
  assert.equal(b.modelFor('unknown-purpose'), 'main-model');
});

test('两个进程同时写不会互相覆盖（写前并盘）', async () => {
  const { MemeKB } = await import('../src/kb.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbm-'));
  const a = new MemeKB({ dataDir: dir });
  const b = new MemeKB({ dataDir: dir });
  a.addMany([{ name: '甲梗', meaning: 'a' }], { source: 't' });
  b.addMany([{ name: '乙梗', meaning: 'b' }], { source: 't' }); // b 手里没有甲梗
  const names = new MemeKB({ dataDir: dir }).all().map((r) => r.name).sort();
  assert.deepEqual(names, ['乙梗', '甲梗'].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});
