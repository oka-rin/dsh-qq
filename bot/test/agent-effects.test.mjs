import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';

const tool = (name, args) => ({ tool_calls: [{ id: 'test', function: { name, arguments: JSON.stringify(args) } }] });
const article = { title: '原始素材标题', url: 'https://www.bilibili.com/video/BV1234567890' };
function fixture(t, { cfg = {}, reply, throwWrite = false, botExtra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-effects-'));
  const writes = [], decisions = [];
  const config = { storage: { dataDir: dir }, agent: { enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, minGapMs: 0, ...cfg } };
  const bot = { cfg: config, groups: new Map(), recent: () => [],
    send: async (...args) => { if (throwWrite) throw new Error('mock write failed'); writes.push(args); return 1; },
    onebot: { call: async (...args) => { if (throwWrite) throw new Error('mock write failed'); writes.push(args); return { tid: 'mock-tid' }; } },
    ...botExtra,
  };
  const a = new AgentLoop({ config, bot, brain: { chatWithTools: reply }, search: async () => [article],
    decisions: { record: (row) => decisions.push(row) }, log: { info() {}, warn() {}, debug() {}, error() {} } });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden'); });
  t.after(() => {
    a.stop();
    assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('qq-agent-effects-'));
    assert.equal(fs.realpathSync(dir), dir);
    fs.rmSync(dir, { recursive: true });
  });
  const rows = () => fs.readFileSync(path.join(dir, 'history/agent-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { a, writes, decisions, rows };
}

for (const name of ['send_message', 'post_qzone', 'qq_op']) {
  test(`${name}: rejected async write is returned and logged as failure`, async (t) => {
    const args = name === 'send_message' ? { text: '测试' } : name === 'post_qzone' ? { content: '测试' } : { action: 'send_like', params: { user_id: 2 } };
    const h = fixture(t, { cfg: { maxSteps: 1 }, throwWrite: true, reply: async () => tool(name, args) });
    const out = await h.a.tick();
    assert.equal(out.ok, false);
    assert.match(out.actions[0].result.error, /mock write failed/);
    assert.equal(h.rows()[0].ok, false);
    assert.equal(h.a.history.length, 0);
  });
}

test('qzone refuses a fabricated or unsearched URL', async (t) => {
  const h = fixture(t, { cfg: { maxSteps: 1 }, reply: async () => tool('post_qzone', { content: '假链接 https://invalid.example/fake' }) });
  assert.equal((await h.a.tick()).ok, false);
  assert.equal(h.writes.length, 0);
});

test('qzone accepts searched title/link and deduplicates it after first write', async (t) => {
  let n = 0;
  const h = fixture(t, { reply: async () => ++n % 2 ? tool('find_content', { source: 'bilibili', keyword: '游戏' }) : tool('post_qzone', { content: `${article.title}\n${article.url}` }) });
  assert.equal((await h.a.tick()).ok, true);
  assert.equal(h.writes.length, 1);
  assert.equal((await h.a.tick()).ok, false);
  assert.equal(h.writes.length, 1);
  assert.equal(h.rows().filter((r) => r.kind === 'qzone' && r.ok).length, 1);
});

test('read-only _get_group_notice is not classified as a performed write', async (t) => {
  const h = fixture(t, { cfg: { maxSteps: 1 }, reply: async () => tool('qq_op', { action: '_get_group_notice', params: { group_id: 1 } }) });
  assert.equal((await h.a.tick()).ok, true);
  assert.equal(h.rows()[0].kind, 'read');
  assert.equal(h.decisions[0].acted, undefined);
  assert.equal(h.a.history.length, 0);
});

test('send_meme counts as a spoken write with its caption in the log', async (t) => {
  const h = fixture(t, {
    cfg: { maxSteps: 1 },
    botExtra: {
      memes: { pick: () => ({ caption: '猫猫无语', tag: 'confused', file: '/tmp/does-not-matter.png' }) },
      sendImage: async () => 42,
    },
    reply: async () => tool('send_meme', { keyword: '猫' }),
  });
  assert.equal((await h.a.tick()).ok, true);
  const row = h.rows()[0];
  assert.equal(row.kind, 'speak');
  assert.equal(row.ok, true);
  assert.equal(row.detail, '猫猫无语');
  assert.equal(h.a.history.length, 1);
});

test('dry run is visible but never records a real decision achievement', async (t) => {
  const h = fixture(t, { cfg: { dryRun: true }, reply: async () => tool('post_qzone', { content: '演练' }) });
  assert.equal((await h.a.tick()).ok, true);
  assert.equal(h.decisions[0].acted, false);
  assert.match(h.decisions[0].reason, /演练/);
  assert.equal(h.rows()[0].dry, true);
  assert.equal(h.writes.length, 0);
});

test('invalid argument JSON cannot silently execute a default operation', async (t) => {
  const h = fixture(t, { cfg: { maxSteps: 1 }, reply: async () => ({ tool_calls: [{ id: 'bad', function: { name: 'list_groups', arguments: '{' } }] }) });
  const out = await h.a.tick();
  assert.equal(out.ok, false);
  assert.match(out.actions[0].result.error, /JSON/);
});
