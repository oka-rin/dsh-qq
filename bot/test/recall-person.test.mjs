import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';
import { PeopleBook } from '../src/people.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const call = (name, args = {}) => ({ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } });

test('recall_person：模型能翻出名册之外的群友档案（含事实）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
  fs.mkdirSync(path.join(dir, 'history'));
  const people = new PeopleBook({ dataDir: dir });
  people.note({ uin: '33', name: '老王', text: '在的', at: Date.now() });
  const file = path.join(dir, 'people', '33.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  d.summary = '一个养狗的老群友';
  d.facts = ['养了只柴犬', '在准备考研', '住成都'];
  fs.writeFileSync(file, JSON.stringify(d));
  const book = new PeopleBook({ dataDir: dir });

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
    people: book,
    recent: () => [{ role: 'user', name: '阿强', text: '老王最近咋样', ts: Date.now() - 60_000 }],
    send: async () => 1,
    onebot: { call: async () => ({}) },
  };
  const replies = [
    { tool_calls: [call('recall_person', { query: '考研' })] },
    { tool_calls: [] },
  ];
  const seen = [];
  const brain = {
    chatWithTools: async ({ messages }) => {
      seen.push(messages);
      return replies.shift() || { tool_calls: [] };
    },
  };
  const a = new AgentLoop({ config, bot, brain, log, people: book, search: async () => [], images: async () => [] });
  t.after(() => {
    a.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const out = await a.run('group:1', { reason: 'test' });
  const action = (out.actions || []).find((x) => x.name === 'recall_person');
  assert.ok(action, '应该执行 recall_person');
  assert.equal(action.result.found, 1);
  assert.equal(action.result.people[0].name, '老王');
  assert.match(action.result.people[0].facts[0], /考研/); // 命中的事实排最前
  assert.ok(seen.length >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
