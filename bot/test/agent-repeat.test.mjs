import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const call = (name, args = {}) => ({ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } });
const response = (...calls) => ({ tool_calls: calls });

function harness(t, { entries = [], brain }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-repeat-'));
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir);
  const ledger = path.join(historyDir, 'agent-log.jsonl');
  fs.writeFileSync(ledger, entries.map((r) => JSON.stringify(r)).join('\n') + (entries.length ? '\n' : ''));
  const sends = [];
  const prompts = [];
  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16,
      minGapMs: 0, selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 4, maxActionsPerRound: 2,
    },
  };
  const bot = {
    cfg: config,
    groups: new Map(),
    recent: () => [{ role: 'user', name: '阿强', text: '最近游戏荒了', ts: Date.now() - 60_000 }],
    send: async (scope, text) => { sends.push({ scope, text }); return sends.length; },
    onebot: { call: async () => ({ tid: 'x' }) },
  };
  const fakeBrain = {
    chatWithTools: async (input) => { prompts.push(input.messages[1].content); return brain(); },
  };
  const a = new AgentLoop({ config, bot, brain: fakeBrain, log });
  t.after(() => {
    a.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { a, sends, prompts };
}

const said = (text, at = Date.now() - 3600_000) => ({ scope: 'group:1', at, kind: 'speak', ok: true, detail: text });

test('跟上一条几乎一样的发言会被打回，不会发出去', async (t) => {
  const h = harness(t, {
    entries: [said('愿望单里几个demo试了一圈，结果全特么是换皮肉鸽，找个正经单机玩比登天还难。')],
    brain: () => response(call('send_message', { text: 'demo 试了一圈全特么换皮肉鸽，找正经单机玩太难了。' })),
  });
  const out = await h.a.tick();
  assert.equal(h.sends.length, 0, '相似内容不该发出去');
  assert.ok(out.actions.some((x) => /几乎一样/.test(String(x.result?.error || ''))), '应给出重说提示');
});

test('换个话题照常发', async (t) => {
  const h = harness(t, {
    entries: [said('愿望单里几个demo试了一圈，结果全特么是换皮肉鸽，找个正经单机玩比登天还难。')],
    brain: () => response(call('send_message', { text: '固态硬盘这两天又偷偷涨价了，仓储盘真买不起。' })),
  });
  await h.a.tick();
  assert.equal(h.sends.length, 1);
});

test('上下文里会列出最近说过的话并提示换角度', async (t) => {
  const h = harness(t, {
    entries: [said('固态又涨价了'), said('换皮肉鸽太多了')],
    brain: () => response(call('skip', { reason: '测试' })),
  });
  await h.a.tick();
  const prompt = h.prompts.join('\n');
  assert.match(prompt, /你最近主动说过的话/);
  assert.match(prompt, /别换个说法再来一遍/);
});

test('字面不像但意思一样：模型判定重复就不发', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-repeat-'));
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir);
  fs.writeFileSync(
    path.join(historyDir, 'agent-log.jsonl'),
    JSON.stringify({ scope: 'group:1', at: Date.now() - 3600_000, kind: 'speak', ok: true, detail: '在新品节翻了一圈demo，十个里面有八个在缝换皮肉鸽……游戏荒也不能这么折磨人吧。' }) + '\n',
  );
  const sends = [];
  const config = {
    storage: { dataDir: dir },
    agent: { enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16, minGapMs: 0, selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 2, maxActionsPerRound: 1 },
  };
  const bot = {
    cfg: config, groups: new Map(),
    recent: () => [{ role: 'user', name: '阿强', text: '最近没啥可玩的', ts: Date.now() - 60_000 }],
    send: async (scope, text) => { sends.push(text); return sends.length; },
    onebot: { call: async () => ({}) },
  };
  const brain = {
    chatWithTools: async () => response(call('send_message', { text: '愿望单里几个标着好评如潮的demo试了一圈，结果全特么是换皮肉鸽，找个正经单机玩比登天还难。' })),
    complete: async () => '重复',
  };
  const a = new AgentLoop({ config, bot, brain, log });
  t.after(() => { a.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const out = await a.tick();
  assert.equal(sends.length, 0, '同义改写不该发出去');
  assert.ok(out.actions.some((x) => /同一个意思/.test(String(x.result?.error || ''))));
});

test('判定不重复就照常发', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-repeat-'));
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir);
  fs.writeFileSync(
    path.join(historyDir, 'agent-log.jsonl'),
    JSON.stringify({ scope: 'group:1', at: Date.now() - 3600_000, kind: 'speak', ok: true, detail: '在新品节翻了一圈demo，全是换皮肉鸽。' }) + '\n',
  );
  const sends = [];
  const config = {
    storage: { dataDir: dir },
    agent: { enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16, minGapMs: 0, selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 2, maxActionsPerRound: 1 },
  };
  const bot = {
    cfg: config, groups: new Map(),
    recent: () => [{ role: 'user', name: '阿强', text: '硬盘又涨价了', ts: Date.now() - 60_000 }],
    send: async (scope, text) => { sends.push(text); return sends.length; },
    onebot: { call: async () => ({}) },
  };
  const brain = {
    chatWithTools: async () => response(call('send_message', { text: '固态这两天又偷偷涨价，仓储盘真买不起，得趁还没疯赶紧补一块。' })),
    complete: async () => '不重复',
  };
  const a = new AgentLoop({ config, bot, brain, log });
  t.after(() => { a.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await a.tick();
  assert.equal(sends.length, 1);
});
