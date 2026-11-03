import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const call = (name, args = {}) => ({ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } });
const response = (...calls) => ({ tool_calls: calls });

function harness(t, { brain, agent = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-topic-'));
  fs.mkdirSync(path.join(dir, 'history'));
  const prompts = [];
  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16,
      minGapMs: 0, selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 3, maxActionsPerRound: 2,
      shareEveryHours: 4, qzoneEveryHours: 20,
      interestGroups: [
        { name: '电脑游戏', weight: 40, topics: ['独立游戏'] },
        { name: '动漫', weight: 30, topics: ['新番'] },
        { name: '科技数码', weight: 30, topics: ['显卡'] },
      ],
      ...agent,
    },
  };
  const bot = {
    cfg: config, groups: new Map(),
    recent: () => [{ role: 'user', name: '阿强', text: '今天的番真难看', ts: Date.now() - 60_000 }],
    send: async () => 1,
    onebot: { call: async () => ({}) },
  };
  const fakeBrain = { chatWithTools: async (input) => { prompts.push(input.messages[1].content); return brain(input); } };
  const a = new AgentLoop({ config, bot, brain: fakeBrain, log, search: async () => [] });
  t.after(() => { a.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { a, prompts, dir };
}

test('分享方向按人设权重掷骰子，不是轮换', async (t) => {
  const h = harness(t, { brain: () => response(call('skip', { reason: 't' })) });
  await h.a.tick();
  const prompt = h.prompts.join('\n');
  assert.match(prompt, /这轮方向是|这个方向/);
  assert.match(prompt, /电脑游戏|动漫|科技数码/);
  assert.doesNotMatch(prompt, /避开它们/);
});

test('掷骰子的分布跟权重一致（40/30/30）', async (t) => {
  const h = harness(t, { brain: () => response(call('skip', { reason: 't' })) });
  const counts = { '电脑游戏': 0, '动漫': 0, '科技数码': 0 };
  const N = 3000;
  for (let i = 0; i < N; i += 1) {
    const pick = h.a.pickInterestForTest();
    counts[pick.group] += 1;
  }
  const ratio = (k) => counts[k] / N;
  assert.ok(Math.abs(ratio('电脑游戏') - 0.4) < 0.06, `电脑游戏 ${ratio('电脑游戏').toFixed(3)}`);
  assert.ok(Math.abs(ratio('动漫') - 0.3) < 0.06, `动漫 ${ratio('动漫').toFixed(3)}`);
  assert.ok(Math.abs(ratio('科技数码') - 0.3) < 0.06, `科技数码 ${ratio('科技数码').toFixed(3)}`);
});

test('分享的措辞要求排除安利腔（三种形态都覆盖）', async (t) => {
  const h = harness(t, { brain: () => response(call('skip', { reason: 't' })) });
  const byStyle = {};
  for (let i = 0; i < 400; i += 1) {
    const plan = h.a.sharePlanForTest();
    byStyle[plan.style] = plan.brief;
  }
  for (const style of ['talk', 'link', 'meme']) {
    assert.ok(byStyle[style], `${style} 形态应当出现`);
    assert.match(byStyle[style], /安利腔/, `${style} 的提示里要有反安利约束`);
  }
  assert.match(byStyle.link, /推荐|自取|值得一看/);
});

test('说说优先接今天聊过的话题', async (t) => {
  const h = harness(t, { brain: () => response(call('skip', { reason: 't' })) });
  fs.writeFileSync(path.join(h.dir, 'history', 'agent-log.jsonl'), JSON.stringify({ scope: 'group:1', at: Date.now() - 600_000, kind: 'share', ok: true, detail: '刚分享过' }) + '\n');
  await h.a.tick();
  const prompt = h.prompts.join('\n');
  assert.match(prompt, /先看今天群里\/私聊都聊了什么|先看今天聊过什么/);
  assert.match(prompt, /只有今天确实没什么可接的/);
});
