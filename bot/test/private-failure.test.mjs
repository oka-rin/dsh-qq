import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Bot } from '../src/bot.mjs';
import { DecisionLog } from '../src/decisions.mjs';
import { Store } from '../src/store.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const scope = 'private:456';
const privateMessage = (id) => ({
  post_type: 'message', message_type: 'private', self_id: 9, user_id: 456,
  message_id: id, sender: { nickname: '测试用户' },
  message: [{ type: 'text', data: { text: `你好 ${id}` } }],
});

function fixture(t, generate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-private-failure-'));
  const store = new Store(dir);
  const decisions = new DecisionLog({ dataDir: dir, log });
  const sent = [];
  const config = {
    onebot: { selfId: '9' }, storage: { dataDir: dir }, persona: { name: '测试机器人' },
    chat: { enabled: true, replyPrivate: true, historyTurns: 12, quietHours: [] },
  };
  const bot = new Bot({ config, store, decisions, log, brain: { generate }, onebot: {
    async call(action, params) {
      sent.push({ action, params });
      return { message_id: 1000 + sent.length };
    },
  } });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(async () => {
    await bot.stop();
    process.off('unhandledRejection', onUnhandled);
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('qq-private-failure-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { bot, store, decisions, sent, unhandled };
}

for (const { name, error, detail } of [
  {
    name: 'timeout',
    error: Object.assign(new Error('request timed out; Authorization: Bearer sk-secret; response body: private payload'), { name: 'AbortError' }),
    detail: '模型请求超时或中断',
  },
  {
    name: 'endpoint error',
    error: new Error('模型接口 503：Authorization: Bearer sk-secret; response body: private payload'),
    detail: '模型调用异常',
  },
]) {
  test(`private generation ${name} is safely diagnosed without fallback, then same scope recovers`, async (t) => {
    let calls = 0;
    const f = fixture(t, async ({ triggerReason }) => {
      assert.equal(triggerReason, 'private');
      if (++calls === 1) throw error;
      return { texts: ['这次成功了'] };
    });
    await f.bot.onMessage(privateMessage(1));
    const [failure] = f.decisions.recent({ scope });
    assert.equal(failure.scope, scope);
    assert.equal(failure.kind, 'passive');
    assert.equal(failure.reason, '模型生成失败');
    assert.equal(failure.acted, false);
    assert.equal(failure.detail, detail);
    assert.equal(f.decisions.summary({ scope }).silent, 1);
    assert.deepEqual(new DecisionLog({ dataDir: f.store.dataDir }).recent({ scope }), [failure]);
    assert.doesNotMatch(fs.readFileSync(f.decisions.file, 'utf8'), /sk-secret|Authorization|private payload|response body/);
    assert.deepEqual(f.sent, [], 'failed generation must not send a fabricated fallback');
    assert.deepEqual(f.store.tail(scope).map((r) => r.role), ['user']);
    assert.equal(f.store.state.stats.replies, 0);
    assert.equal(f.bot.queues.get(scope).busy, false);
    assert.equal(f.bot.inflight.size, 0);

    await f.bot.onMessage(privateMessage(2));
    assert.equal(calls, 2);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].action, 'send_private_msg');
    assert.equal(f.sent[0].params.user_id, 456);
    assert.deepEqual(f.sent[0].params.message, [
      { type: 'reply', data: { id: '2' } },
      { type: 'text', data: { text: '这次成功了' } },
    ]);
    assert.deepEqual(f.store.tail(scope).map((r) => r.role), ['user', 'user', 'bot']);
    assert.equal(f.store.state.stats.replies, 1);
    assert.equal(f.bot.queues.get(scope).busy, false);
    assert.equal(f.bot.inflight.size, 0);
    await setImmediate();
    assert.deepEqual(f.unhandled, []);
  });
}

test('rejected reply task propagates only to its caller and releases scope/inflight state', async (t) => {
  const f = fixture(t, async () => ({ texts: ['正常生成的回复'] }));
  const failure = new Error('mock reply persistence failure');
  const append = f.store.append.bind(f.store);
  f.store.append = (key, row) => {
    if (row.role === 'bot') throw failure;
    return append(key, row);
  };
  await assert.rejects(f.bot.onMessage(privateMessage(3)), (error) => error === failure);
  assert.equal(f.bot.queues.get(scope).busy, false);
  assert.equal(f.bot.inflight.size, 0);
  await setImmediate();
  assert.deepEqual(f.unhandled, [], 'cleanup must not create an unhandled rejected finally promise');

  f.store.append = append;
  await f.bot.onMessage(privateMessage(4));
  assert.equal(f.store.state.stats.replies, 1);
  assert.equal(f.bot.inflight.size, 0);
  await setImmediate();
  assert.deepEqual(f.unhandled, []);
});
