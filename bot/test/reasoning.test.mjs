import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brain } from '../src/brain.mjs';
import { reasoningEffortFor, validateReasoningConfig, REASONING_OPTIONS } from '../src/reasoning.mjs';
const log = { debug() {}, info() {}, warn() {}, error() {} };
const config = () => ({ llm: { mode: 'api', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', apiKey: 'x', maxTokens: 100, timeoutMs: 1000 }, persona: {}, chat: {} });

test('default omission, inheritance, explicit none and every supported level', () => {
  assert.equal(reasoningEffortFor({}), '');
  for (const { value } of REASONING_OPTIONS) {
    assert.equal(reasoningEffortFor({ reasoningEffort: value }), value);
    assert.equal(reasoningEffortFor({ reasoningEffort: 'high', reasoningEfforts: { chat: value } }), value || 'high');
  }
  assert.equal(reasoningEffortFor({ reasoningEffort: 'high', reasoningEfforts: { chat: 'none' } }), 'none');
  for (const bad of ['auto', 'maximum', null, 0, {}]) assert.throws(() => validateReasoningConfig({ reasoningEffort: bad }));
  for (const bad of [null, [], 'high', { nope: 'high' }, { chat: 'oops' }]) assert.throws(() => validateReasoningConfig({ reasoningEfforts: bad }));
});

test('actual chat/completions payload sends exact reasoning_effort per purpose and omits unset', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, ...JSON.parse(opts.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '好', tool_calls: [] } }] }), { status: 200 });
  });
  const cfg = config();
  const brain = new Brain(cfg, { log });
  await brain.complete({ prompt: 'unset' });
  assert.equal(Object.hasOwn(calls.at(-1), 'reasoning_effort'), false);
  cfg.llm.reasoningEffort = 'medium';
  cfg.llm.reasoningEfforts = { chat: 'low', agent: 'high', background: 'none' };
  await brain.complete({ prompt: 'chat' });
  assert.equal(calls.at(-1).reasoning_effort, 'low');
  await brain.chatWithTools({ messages: [{ role: 'user', content: 'choose' }], tools: [] });
  assert.equal(calls.at(-1).reasoning_effort, 'high');
  await brain.complete({ prompt: 'distill', purpose: 'background' });
  assert.equal(calls.at(-1).reasoning_effort, 'none');
  cfg.llm.background = { model: 'cheap', baseUrl: 'http://127.0.0.1:2/v1' };
  await brain.complete({ prompt: 'distill', purpose: 'background' });
  assert.equal(calls.at(-1).model, 'cheap');
  assert.equal(calls.at(-1).reasoning_effort, 'none');
  cfg.llm.reasoningEfforts.chat = '';
  await brain.generate({ history: [{ role: 'user', name: '测试', text: '你好' }], scopeLabel: '私聊' });
  assert.equal(calls.at(-1).reasoning_effort, 'medium');
  cfg.llm.reasoningEffort = '';
  await brain.complete({ prompt: 'back to default' });
  assert.equal(Object.hasOwn(calls.at(-1), 'reasoning_effort'), false);
});
