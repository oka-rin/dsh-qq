import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kbdb-'));

test('ftsTokens 中文切二元、英文数字整词', async () => {
  const { ftsTokens } = await import('../src/learn-db.mjs');
  const t = ftsTokens('显卡又涨价了 RTX5090');
  assert.match(t, /显卡/);
  assert.match(t, /涨价/);
  assert.match(t, /rtx5090/);
  assert.equal(ftsTokens(''), '');
});

test('原话入库后能按关键词翻出来，且不会串到别的会话', async () => {
  const { LearnDB } = await import('../src/learn-db.mjs');
  const dir = tmp();
  const db = new LearnDB({ file: path.join(dir, 'kb.db') });
  const now = Date.now();
  db.addMessages([
    { scope: 'group:1', ts: now - 2000, speaker: '老王', text: '这 5090 又涨价了，真买不动' },
    { scope: 'group:1', ts: now - 1000, speaker: '哈基米', role: 'bot', text: '电子茅台名不虚传' },
    { scope: 'group:2', ts: now, speaker: '小李', text: '5090 涨价跟我没关系' },
  ]);
  assert.equal(db.messageCount, 3);
  const all = db.searchMessages('涨价 显卡', { k: 5 });
  assert.equal(all.length, 2);
  const only2 = db.searchMessages('涨价', { scope: 'group:2', k: 5 });
  assert.equal(only2.length, 1);
  assert.equal(only2[0].speaker, '小李');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('笔记存 SQLite：检索按相关度、scope 过滤、超上限裁剪', async () => {
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const book = new LearnBook({ dataDir: dir, maxNotes: 50 });
  book.addMany(
    [
      { text: '群里把显卡叫「电子茅台」，涨价时说「买不动」' },
      { text: '老王爱用「哈气」表示生气，别当真' },
      { text: '孙颖莎拿下 WTT 冠军' },
    ],
    { kind: 'chat', scope: 'group:1' }
  );
  assert.equal(book.notes.length, 3);
  const hit = book.search('显卡涨价', { scope: 'group:1', k: 2 });
  assert.equal(hit.length >= 1, true);
  assert.match(hit[0].text, /显卡/);
  // 别的会话只拿得到全局笔记，拿不到 group:1 的
  const other = book.search('哈气', { scope: 'group:9', k: 2 });
  assert.equal(other.length, 0);
  // 数据在硬盘上，新实例能读到
  const again = new LearnBook({ dataDir: dir, maxNotes: 50 });
  assert.equal(again.notes.length, 3);
  // 相处经验会被优先塞进提示词
  again.addMany([{ text: '857 和 243 互怼是玩笑，别真劝架' }], { kind: 'social', scope: 'group:1' });
  const text = again.renderFor({ scope: 'group:1', context: '今天天气不错', budget: 400, limit: 4 });
  assert.match(text, /互怼/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('老 notes.json 会迁进 SQLite，原文件改名留档', async () => {
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'learn'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learn', 'notes.json'),
    JSON.stringify({
      lastRunAt: 123,
      lastChat: { 'group:1': 456 },
      notes: [{ id: 'old1', kind: 'chat', scope: 'group:1', text: '老笔记：群里管加班叫「搬砖」', tags: ['加班'], weight: 2, createdAt: 1, lastSeenAt: 2 }],
    })
  );
  const book = new LearnBook({ dataDir: dir });
  assert.equal(book.migrated, 1);
  assert.equal(book.notes.length, 1);
  assert.equal(book.load().lastRunAt, 123);
  assert.equal(book.load().lastChat['group:1'], 456);
  assert.equal(fs.existsSync(path.join(dir, 'learn', 'notes.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'learn', 'notes.json.migrated')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ingest 把历史原话落库，回填后按需可查', async () => {
  const { LearnBook, Learner } = await import('../src/learn.mjs');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  const rows = [
    { ts: 1, name: '老王', role: 'member', text: '显卡又涨价了' },
    { ts: 2, name: '哈基米', role: 'bot', text: '电子茅台是这样的' },
    { ts: 3, name: '小李', role: 'member', text: '今天天气不错' },
  ];
  fs.writeFileSync(path.join(dir, 'history', 'group_1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  const book = new LearnBook({ dataDir: dir });
  const learner = new Learner({ dataDir: dir, book, brain: null, scopes: () => ['group:1'] });
  const out = await learner.backfill({ distill: false });
  assert.equal(out.messages, 3);
  assert.equal(out.scopes, 1);
  const hits = book.searchMessages('涨价', { k: 3 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].speaker, '老王');
  const { TOOL_NAMES_FOR_TEST } = await import('../src/agent.mjs');
  assert.equal(TOOL_NAMES_FOR_TEST.includes('recall_chat'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 用假的向量接口：把文字映射成「含哪些关键字」的稀疏向量，够验融合逻辑 */
function fakeEmbedder(map) {
  return {
    enabled: true,
    calls: 0,
    async embed(texts) {
      this.calls += 1;
      return texts.map((t) => {
        const v = new Array(8).fill(0);
        for (const [kw, idx] of map) if (String(t).includes(kw)) v[idx] += 1;
        v[7] = 0.01; // 防止全零
        return v;
      });
    },
    async embedOne(t) {
      return (await this.embed([t]))[0];
    },
  };
}

test('向量入库 + 补向量只补缺的，不重复算', async () => {
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const emb = fakeEmbedder([['显卡', 0], ['固态', 1], ['孙颖莎', 2]]);
  const book = new LearnBook({ dataDir: dir, embedder: emb });
  book.addMany([{ text: '显卡又涨价了，群里说电子茅台' }, { text: '孙颖莎拿了 WTT 冠军' }], { kind: 'chat', scope: 'group:1' });
  const first = await book.embedPending({ messages: false });
  assert.equal(first.notes, 2);
  const again = await book.embedPending({ messages: false });
  assert.equal(again.notes, 0);
  assert.equal(book.stats().vectors.notes, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('语义检索能捞到字面查不到的同义原话（fusion 生效）', async () => {
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const emb = fakeEmbedder([['显卡', 0], ['5090', 0], ['固态', 1]]);
  const book = new LearnBook({ dataDir: dir, embedder: emb });
  book.ingest('group:1', [
    { ts: 1, name: '老王', text: '5090 又贵了两千，真买不动' },
    { ts: 2, name: '小李', text: '今天中午吃拉面' },
  ]);
  await book.embedPending({ notes: false });
  const lex = book.searchMessages('显卡', { scope: 'group:1', k: 3 });
  assert.equal(lex.length, 0, '字面确实查不到');
  const smart = await book.searchMessagesSmart('显卡', { scope: 'group:1', k: 3 });
  assert.equal(smart.length, 1);
  assert.equal(smart[0].speaker, '老王');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('embedding 接口挂了就静默退回字面，不抛错', async () => {
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const broken = { enabled: true, async embed() { throw new Error('503'); }, async embedOne() { throw new Error('503'); } };
  const book = new LearnBook({ dataDir: dir, embedder: broken });
  book.addMany([{ text: '群里把加班叫搬砖' }], { kind: 'chat', scope: 'group:1' });
  assert.equal((await book.embedPending({ messages: false })).notes, 0);
  const hits = await book.searchSmart('加班', { scope: 'group:1', k: 3 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /搬砖/);
  const text = await book.renderForSmart({ scope: 'group:1', context: '又要加班', budget: 400, limit: 3, timeBudget: 200 });
  assert.match(text, /搬砖/);
  fs.rmSync(dir, { recursive: true, force: true });
});
