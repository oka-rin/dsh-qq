import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const call = (name, args = {}) => ({ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } });
const response = (...calls) => ({ tool_calls: calls });

function harness(t, { logRows = [], agent = {}, recent = () => [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-private-'));
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir);
  if (logRows.length) {
    fs.writeFileSync(path.join(historyDir, 'agent-log.jsonl'), logRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:10000003', 'private:10000001'], quietHours: [], everyMinutes: 1, jitterMinutes: 0,
      maxSteps: 2, maxActionsPerRound: 1, selfHoldMs: 0, minGapMs: 0,
      minPerDay: 0, maxPerDay: 16,
      group: { minPerDay: 8, maxPerDay: 16, minGapMs: 0 },
      private: { minPerDay: 4, maxPerDay: 8, minGapMs: 0 },
      interestGroups: [{ name: '动漫', weight: 30, topics: ['新番'] }],
      ...agent,
    },
  };
  const bot = { cfg: config, groups: new Map(), recent: (scope, n) => recent(scope, n), send: async () => 1, onebot: { call: async () => ({}) } };
  const a = new AgentLoop({ config, bot, brain: { chatWithTools: async () => response(call('skip', { reason: 't' })) }, log, search: async () => [] });
  t.after(() => { a.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { a, config, dir };
}

const now = () => Date.now();
const row = (scope, kind, minsAgo = 30) => ({ scope, kind, at: now() - minsAgo * 60_000, ok: true, detail: 'x' });

test('群already刷满、私聊欠下限时，应该轮到私聊', async (t) => {
  const h = harness(t, {
    logRows: [
      ...Array.from({ length: 8 }, (_, i) => row('group:10000003', 'speak', 60 + i)),
      ...Array.from({ length: 2 }, (_, i) => row('private:10000001', 'speak', 90 + i)),
    ],
    recent: (scope) => (scope.startsWith('group:')
      ? [{ role: 'user', name: '阿强', text: '在吗在吗', ts: now() - 60_000 }]
      : [{ role: 'user', name: '测试用户丁', text: '早', ts: now() - 5 * 3600_000 }]),
  });
  const scope = await h.a.pickScopeForTest({});
  assert.equal(scope, 'private:10000001', '私聊还欠 2 次，应该优先补上限');
});

test('私聊已经达标时，仍按活跃度选群', async (t) => {
  const h = harness(t, {
    logRows: Array.from({ length: 4 }, (_, i) => row('private:10000001', 'speak', 120 + i)),
    recent: (scope) => (scope.startsWith('group:')
      ? [{ role: 'user', name: '阿强', text: '在吗在吗', ts: now() - 60_000 }]
      : []),
  });
  const scope = await h.a.pickScopeForTest({});
  assert.equal(scope, 'group:10000003');
});

test('私聊今天一条都没发过时算 starving，会被推上来', async (t) => {
  const h = harness(t, {
    logRows: [row('group:10000003', 'speak', 10)],
    recent: (scope) => [{ role: 'user', name: 'x', text: '嗯嗯最近怎么样啊', ts: now() - 60_000 }],
  });
  const scope = await h.a.pickScopeForTest({});
  assert.equal(scope, 'private:10000001');
});
