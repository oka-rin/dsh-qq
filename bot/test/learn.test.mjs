import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'learn-'));

test('parseNotes 解析「一句话|关键词」，也容忍没关键词的和「无」', async () => {
  const { parseNotes } = await import('../src/learn.mjs');
  const out = parseNotes('- 群里把「红温」当「急了」用|红温,急了\n* 大家最近都在蹲显卡降价，一提 40 系就开骂\n无\n短');
  assert.equal(out.length, 2);
  assert.equal(out[0].text, '群里把「红温」当「急了」用');
  assert.deepEqual(out[0].tags, ['红温', '急了']);
  assert.match(out[1].text, /蹲显卡降价/);
});

test('同一条笔记重复学到只加权不重复存，无关的照常新增', async () => {
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const book = new LearnBook({ dataDir: dir });
  const a = book.addMany([{ text: '群里管「显卡」叫「煤气灶」' }], { kind: 'chat', scope: 'group:1' });
  assert.equal(a.added, 1);
  const b = book.addMany([{ text: '群里管「显卡」叫「煤气灶」。' }, { text: '最近都在等 50 系显卡降价' }], { kind: 'chat', scope: 'group:1' });
  assert.equal(b.added, 1);
  assert.equal(b.merged, 1);
  const notes = book.notes;
  assert.equal(notes.length, 2);
  assert.equal(notes.find((n) => n.text.includes('煤气灶')).weight, 2);
  // 落盘后新实例能读到（别只活在内里）
  const again = new LearnBook({ dataDir: dir });
  assert.equal(again.notes.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderFor 先给本会话的，再按当下这句话的字面关系挑', async () => {
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const book = new LearnBook({ dataDir: dir });
  book.addMany([{ text: '本群管「摸鱼」叫「抗压训练」' }], { kind: 'chat', scope: 'group:1' });
  book.addMany([{ text: '网上最近很火的梗叫「电子榨菜」' }], { kind: 'web', scope: '' });
  book.addMany([{ text: '显卡价格最近又涨了' }], { kind: 'web', scope: '' });
  const local = book.renderFor({ scope: 'group:1', context: '今天又在摸鱼' });
  assert.match(local, /抗压训练/);
  const web = book.renderFor({ scope: 'group:9', context: '电子榨菜是什么' });
  assert.match(web, /电子榨菜/);
  assert.ok(!web.includes('抗压训练'), '别的群的黑话不该串台');
  // 预算小的时候不许超长
  const tight = book.renderFor({ scope: 'group:9', budget: 20 });
  assert.ok([...tight].length <= 25, `budget 没守住：${tight}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('笔记库有上限，超了按权重和新鲜度裁掉最没用的', async () => {
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const book = new LearnBook({ dataDir: dir, maxNotes: 50 });
  const many = Array.from({ length: 80 }, (_, i) => ({ text: `笔记${i}${Math.random().toString(36).slice(2, 10)}，讲的是完全不相干的一件小事` }));
  book.addMany(many, { kind: 'web', scope: '' });
  assert.equal(book.notes.length, 50, '超上限应裁到 50');
  const hot = book.addMany([{ text: '这条被反复学到' }], { kind: 'web' });
  book.addMany([{ text: '这条被反复学到' }], { kind: 'web' });
  assert.equal(hot.added, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('学聊天：只喂新消息、游标往前推，模型给的空话不算数', async () => {
  const { Learner, LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const histDir = path.join(dir, 'history');
  fs.mkdirSync(histDir, { recursive: true });
  const rows = [
    { ts: 1000, role: 'user', name: '老王', text: '这显卡跟煤气灶似的' },
    { ts: 2000, role: 'bot', name: '哈基米', text: '那你别开火啊' },
  ];
  fs.writeFileSync(path.join(histDir, 'group_1.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  let calls = 0;
  let lastPrompt = '';
  const brain = {
    async complete({ prompt }) {
      calls += 1;
      lastPrompt = prompt;
      return '- 本群把发热厉害的显卡叫「煤气灶」|煤气灶,显卡';
    },
  };
  const book = new LearnBook({ dataDir: dir });
  const learner = new Learner({ dataDir: dir, brain, book, scopes: () => ['group:1'], minLines: 1 });
  const out = await learner.learnChats();
  assert.equal(calls, 1);
  assert.match(lastPrompt, /煤气灶/);
  assert.equal(out.added, 1);
  assert.equal(book.notes.length, 1);
  // 第二轮：没有新消息就不该再调模型
  const again = await learner.learnChats();
  assert.equal(calls, 1, '没有新消息还调模型就是浪费');
  assert.equal(again.added, 0);
  // 第三轮：来了新消息，游标生效，只喂新的
  fs.appendFileSync(path.join(histDir, 'group_1.jsonl'), `${JSON.stringify({ ts: 3000, role: 'user', name: '小李', text: '又涨价了' })}\n`);
  await learner.learnChats();
  assert.equal(calls, 2);
  assert.match(lastPrompt, /又涨价了/);
  assert.ok(!lastPrompt.includes('那你别开火啊'), '老消息不该再喂一遍');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('现学一个话题：搜到素材才调模型，搜不到就直接说没学到', async () => {
  const { Learner, LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const book = new LearnBook({ dataDir: dir });
  const prompts = [];
  const brain = {
    async complete({ prompt }) {
      prompts.push(prompt);
      return '- 钟馗新作是黑神话系列的新单机|钟馗,黑神话';
    },
  };
  // sources.mjs 的 searchWeb 走真实网络，这里用注入不了的模块级函数，所以只用空结果分支验证
  const learner = new Learner({ dataDir: dir, brain, book, scopes: () => [] });
  const empty = await learner.learnTopic('');
  assert.equal(empty.ok, false);
  assert.equal(prompts.length, 0, '空话题不该调模型');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('到点才跑：没到 everyHours 就 not-due，force 能强制跑', async () => {
  const { Learner, LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const book = new LearnBook({ dataDir: dir });
  const learner = new Learner({ dataDir: dir, brain: null, book, scopes: () => [], everyHours: 6 });
  book.load().lastRunAt = Date.now();
  book.save();
  assert.equal(learner.due, false);
  const r = await learner.maybeRun();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-due');
  assert.equal((await learner.maybeRun({ force: true })).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('学的笔记会进到被动回复的提示词里（brain 那一段）', async () => {
  const { Brain } = await import('../src/brain.mjs');
  const brain = new Brain(
    { persona: { name: '哈基米', style: '自然' }, chat: { historyChars: 4000, maxReplyChars: 120 }, llm: { mode: 'off' } },
    { log: { info() {}, warn() {}, debug() {} } },
  );
  const messages = brain.buildMessages({
    history: [{ role: 'user', name: '阿强', text: '今天又在摸鱼', ts: Date.now() }],
    scopeLabel: 'QQ 群「测试」',
    triggerReason: 'mention',
    learnText: '· 本群管「摸鱼」叫「抗压训练」',
  });
  const user = messages.find((m) => m.role === 'user');
  const text = typeof user.content === 'string' ? user.content : JSON.stringify(user.content);
  assert.match(text, /你平时自己学到的/);
  assert.match(text, /抗压训练/);
  // 没有笔记时不该多出这一坨
  const plain = brain.buildMessages({
    history: [{ role: 'user', name: '阿强', text: '在吗', ts: Date.now() }],
    scopeLabel: 'QQ 群「测试」',
    triggerReason: 'mention',
  });
  assert.ok(!JSON.stringify(plain).includes('你平时自己学到的'));
});

test('study 工具：给话题就去学，学到的东西真进了笔记库', async () => {
  const { AgentLoop } = await import('../src/agent.mjs');
  const { LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const book = new LearnBook({ dataDir: dir });
  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16, minGapMs: 0,
      selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 3, maxActionsPerRound: 1,
    },
  };
  const bot = {
    cfg: config,
    groups: new Map(),
    learn: book,
    recent: () => [{ role: 'user', name: '阿强', text: '钟馗那个新作出了吗', ts: Date.now() - 60_000 }],
    send: async () => 1,
    onebot: { call: async () => ({}) },
  };
  const learner = {
    async learnTopic(topic) {
      const r = book.addMany([{ text: `「${topic}」是黑神话系列的新作`, tags: [topic] }], { kind: 'web' });
      return { ok: true, topic, found: 3, learned: r.added, added: r.added };
    },
    async learnChats() { return { added: 0, merged: 0, scopes: 1 }; },
  };
  const replies = [{ tool_calls: [{ id: 't1', function: { name: 'study', arguments: JSON.stringify({ topic: '钟馗' }) } }] }, { tool_calls: [] }];
  const noop = { info() {}, warn() {}, debug() {}, error() {} };
  const brain = { chatWithTools: async () => replies.shift() || { tool_calls: [] } };
  const a = new AgentLoop({ config, bot, brain, log: noop, learn: book, learner, search: async () => [], images: async () => [] });
  const out = await a.run('group:1', { reason: 'test' });
  a.stop();
  const action = (out.actions || []).find((x) => x.name === 'study');
  assert.ok(action, '应该执行 study');
  assert.equal(action.result.learned, 1);
  assert.equal(book.notes.length, 1);
  assert.match(book.notes[0].text, /钟馗/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('学 B站 刷到的内容：素材进提示词，笔记按 feed 落库', async () => {
  const { Learner, LearnBook } = await import('../src/learn.mjs');
  const dir = tmp();
  const book = new LearnBook({ dataDir: dir });
  let prompt = '';
  const brain = {
    async complete(input) {
      prompt = input.prompt;
      return '- 显卡吧把 40 系叫「煤气灶」|煤气灶,显卡\n- 评论区在争 DLSS 值不值|DLSS,画质';
    },
  };
  const learner = new Learner({ dataDir: dir, brain, book, scopes: () => [] });
  const r = await learner.learnFeed({
    items: [{
      title: '40 系显卡到底多热',
      desc: '实测功耗',
      author: '硬件UP',
      comments: [{ user: '网友A', content: '这温度能煎蛋' }],
    }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.added, 2);
  assert.match(prompt, /40 系显卡到底多热/);
  assert.match(prompt, /这温度能煎蛋/);
  const note = book.notes.find((n) => n.text.includes('煤气灶'));
  assert.equal(note.kind, 'feed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('学刷到的内容：行为、口头禅分开存，口头禅不会混进知识笔记', async () => {
  const { Learner, LearnBook, parseFeedNotes } = await import('../src/learn.mjs');
  const parsed = parseFeedNotes('[行为] 被人阴阳时先顺着夸一句|接梗,阴阳\n[口头禅] 可以这样说：这波不亏|口头禅\n[想要] 冰可乐\n显卡又涨价了|显卡');
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((n) => n.kind), ['behavior', 'phrase', 'want', 'feed']);

  const dir = tmp();
  const book = new LearnBook({ dataDir: dir });
  const brain = {
    async complete() {
      return '[行为] 群里有人求推荐时先问预算|推荐,预算\n[口头禅] 可以这样说：先别急，让我缓缓|口头禅\n[想要] 冰可乐\n40 系显卡发热大|显卡';
    },
  };
  const learner = new Learner({ dataDir: dir, brain, book, scopes: () => [] });
  const r = await learner.learnFeed({ items: [{ title: '装机视频', liked: true }] });
  assert.equal(book.byKind('behavior').length, 1);
  assert.equal(book.byKind('phrase').length, 1);
  assert.equal(book.byKind('feed').length, 1);
  assert.match(book.byKind('behavior')[0].text, /预算/);
  assert.deepEqual(r.wants, ['冰可乐']);
  assert.equal(book.byKind('want').length, 0, '想要的东西不该混进笔记库');
  fs.rmSync(dir, { recursive: true, force: true });
});
