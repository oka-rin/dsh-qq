import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };

function harness(t, { entries = [], replies = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-style-'));
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir);
  fs.writeFileSync(path.join(historyDir, 'agent-log.jsonl'), entries.map((r) => JSON.stringify(r)).join('\n') + (entries.length ? '\n' : ''));
  const sends = [];
  const queue = [...replies];
  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16, minGapMs: 0,
      selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 4, maxActionsPerRound: 3,
      shareStyleWeights: { talk: 40, link: 40, meme: 20 },
      interestGroups: [{ name: '电脑游戏', weight: 100, topics: ['独立游戏'] }],
    },
  };
  const bot = {
    cfg: config,
    groups: new Map(),
    recent: () => [{ role: 'user', name: '阿强', text: '最近游戏荒了', ts: Date.now() - 60_000 }],
    send: async (scope, text) => { sends.push({ scope, text }); return sends.length; },
    sendImage: async (scope, file) => { sends.push({ scope, file }); return sends.length; },
    memes: { pick: () => ({ file: '/tmp/x.png', caption: '无语', tag: 'sad' }) },
    onebot: { call: async () => ({ tid: 'x' }) },
  };
  const fakeBrain = {
    chatWithTools: async () => queue.shift() || { tool_calls: [] },
  };
  const a = new AgentLoop({ config, bot, brain: fakeBrain, log });
  const orig = a.search.bind(a);
  a.search = async () => [{ title: '这季没啥能打的', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }];
  t.after(() => {
    a.stop();
    a.search = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { a, sends };
}

const call = (name, args = {}) => ({ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } });

test('分享三种形态按权重掷骰，且连着两条链接后不再选带链接', (t) => {
  const { a } = harness(t);
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) seen.add(a.sharePlanForTest().style);
  assert.deepEqual([...seen].sort(), ['link', 'meme', 'talk'], '三种形态都应出现');

  const linked = (at) => ({ scope: 'group:1', at, kind: 'share', ok: true, detail: '看了个视频', urls: ['https://a.example/x'] });
  const { a: b } = harness(t, { entries: [linked(Date.now() - 7200_000), linked(Date.now() - 3600_000)] });
  let links = 0;
  for (let i = 0; i < 200; i += 1) if (b.sharePlanForTest().style === 'link') links += 1;
  assert.equal(links, 0, '连着两条都带链接时必须换花样');
});

test('只说话那一档不搜索也不发链接，带链接那档不许复述标题', (t) => {
  const { a } = harness(t);
  const plans = [];
  for (let i = 0; i < 400; i += 1) plans.push(a.sharePlanForTest());
  const talk = plans.find((p) => p.style === 'talk');
  const link = plans.find((p) => p.style === 'link');
  const meme = plans.find((p) => p.style === 'meme');
  assert.match(talk.brief, /不用发链接/);
  assert.match(link.brief, /不填 source 就是全网一起搜/);
  assert.match(link.brief, /不用非得是 B站或知乎/);
  assert.match(link.brief, /别复述视频标题/);
  assert.match(meme.brief, /send_meme/);
});

test('安利腔会被退回，随口一句能发出去', async (t) => {
  const { a, sends } = harness(t, {
    replies: [
      { tool_calls: [call('send_message', { text: '这个强烈推荐，值得一看！' })] },
      { tool_calls: [call('send_message', { text: '这季的番是真没啥能打的，看两眼就关了。' })] },
    ],
  });
  await a.run({ scope: 'group:1', mode: 'share' });
  assert.equal(sends.length, 1, '安利腔那条不该发出去');
  assert.match(sends[0].text, /没啥能打的/);
});

test('带链接时不强制复述标题，只校验链接来自本轮搜索', async (t) => {
  const { a, sends } = harness(t, {
    replies: [
      { tool_calls: [call('find_content', { source: 'bilibili', keyword: '新番' })] },
      { tool_calls: [call('send_message', { text: '这季能打的没几个，看看这个吐槽。\\nhttps://www.bilibili.com/video/BV1xx411c7mD' })] },
    ],
  });
  await a.run({ scope: 'group:1', mode: 'share' });
  assert.equal(sends.length, 1, '不带标题也该能发');
  assert.match(sends[0].text, /BV1xx411c7mD/);
});

test('不填 source 就全网一起搜，去重并标出来源', async (t) => {
  const { a } = harness(t, {
    replies: [
      { tool_calls: [call('find_content', { keyword: '独立游戏' })] },
      { tool_calls: [call('skip', { reason: '测试' })] },
    ],
  });
  const calls = [];
  a.search = async (source, keyword) => {
    calls.push(source);
    if (source === 'bilibili') return [{ title: 'B站素材', url: 'https://www.bilibili.com/video/BV1aa411c7md' }];
    if (source === 'web') return [
      { title: '网页素材', url: 'https://example.com/post/1' },
      { title: '重复素材', url: 'https://www.bilibili.com/video/BV1aa411c7md' },
    ];
    return [];
  };
  const out = await a.run({ scope: 'group:1', mode: 'share' });
  const finder = out.actions.find((x) => x.name === 'find_content');
  assert.ok(finder, '应当先搜一下');
  assert.equal(calls.length, 5, '不指定平台时应把五个来源都搜一遍');
  const urls = finder.result.items.map((i) => i.url);
  assert.equal(new Set(urls).size, urls.length, '重复 URL 应被去掉');
  assert.ok(finder.result.items.some((i) => i.from === '网页'), '要标出来源');
});
