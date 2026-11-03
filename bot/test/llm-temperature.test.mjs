import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Brain } from '../src/brain.mjs';

const log = { debug() {}, info() {}, warn() {}, error() {} };

function makeConfig() {
  return {
    llm: { mode: 'api', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', apiKey: 'x', maxTokens: 100, temperature: 0.75 },
    persona: { name: '哈基米', identity: '群友', style: '短', likes: [], rules: [] },
    chat: { maxReplyChars: 160, memesEnabled: false, aiDecide: false },
  };
}

test('聊天 0.95 / 决策 0.7 / 后台 0.6：按 purpose 取温度', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const cfg = makeConfig();
    cfg.llm.temperatures = { chat: 0.95, agent: 0.7, background: 0.6 };
    const brain = new Brain(cfg, { log });

    await brain.complete({ prompt: '整理一下', purpose: 'background' });
    await brain.generate({
      history: [{ role: 'user', name: '甲', text: '那我爽', at: Date.now() }],
      scopeLabel: 'QQ 群「测试群」',
      triggerReason: 'mention',
    });

    assert.equal(calls[0].temperature, 0.6, '后台任务应走 background 温度');
    assert.equal(calls[1].temperature, 0.95, '聊天应走 chat 温度');
  } finally {
    globalThis.fetch = orig;
  }
});

test('没配 temperatures 时回落到全局 temperature', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const brain = new Brain(makeConfig(), { log });
    await brain.complete({ prompt: 'x', purpose: 'background' });
    assert.equal(calls[0].temperature, 0.75);
  } finally {
    globalThis.fetch = orig;
  }
});
