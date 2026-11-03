import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ABSTRACT_RULE, Brain, abstractRule } from '../src/brain.mjs';

const log = { debug() {}, info() {}, warn() {}, error() {} };

function makeConfig(personaOverrides = {}) {
  return {
    llm: { mode: 'echo', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', maxTokens: 100 },
    persona: {
      name: '哈基米',
      identity: '群友',
      style: '短',
      likes: [],
      rules: [],
      ...personaOverrides,
    },
    chat: { maxReplyChars: 160, memesEnabled: true, aiDecide: true },
  };
}

test('人设自带 systemPrompt 时也要注入「抽象 / 生梗」要求', () => {
  // 线上人设走的就是这条早返回分支：以前这里只有输出约束，模型收不到造梗要求
  const brain = new Brain(makeConfig({ systemPrompt: '你是一只猫。' }), { log });
  const prompt = brain.systemPrompt({ scopeLabel: 'QQ 群「测试群」', groupInfo: '群号 1' });
  assert.match(prompt, /说话气质：抽象/);
  assert.match(prompt, /谐音梗/);
  assert.match(prompt, /魔芋爽/);
  assert.match(prompt, /哈基米德/);
  assert.match(prompt, /每 3~4 句至少 1 句带梗/);
});

test('默认（无 systemPrompt）分支也注入，且表情包规则不重复', () => {
  const brain = new Brain(makeConfig(), { log });
  const prompt = brain.systemPrompt({ scopeLabel: 'QQ 群「测试群」', groupInfo: '' });
  assert.match(prompt, /说话气质：抽象/);
  const memeBlocks = prompt.split('发不发图（你自己定）').length - 1;
  assert.equal(memeBlocks, 1, 'MEME_RULE 只应出现一次');
});

test('persona.abstract=false 时整体关掉，不影响其他规则', () => {
  assert.deepEqual(abstractRule({ persona: { abstract: false } }), []);
  assert.equal(abstractRule({ persona: {} }).length, ABSTRACT_RULE.length);
  const brain = new Brain(makeConfig({ abstract: false }), { log });
  const prompt = brain.systemPrompt({ scopeLabel: 'QQ 群「测试群」', groupInfo: '' });
  assert.doesNotMatch(prompt, /磁音梗|谐音梗/);
  assert.match(prompt, /输出规则（重要）/);
});
