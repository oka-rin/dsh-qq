import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Brain } from '../src/brain.mjs';
import { Bot } from '../src/bot.mjs';
import { Store } from '../src/store.mjs';
const log = { info() {}, warn() {}, debug() {}, error() {} };

for (const systemPrompt of ['', '你是GPT娘。']) {
  test(`natural banter remains enabled with abstract=false (${systemPrompt ? 'imported' : 'default'} persona)`, () => {
    const brain = new Brain({ persona: { name: 'GPT娘', abstract: false, systemPrompt }, chat: { maxReplyChars: 160 }, llm: {} }, { log });
    const prompt = brain.systemPrompt({ scopeLabel: '测试' });
    assert.match(prompt, /同一个笑点推进半步/);
    assert.match(prompt, /不硬跨作品/);
    assert.match(prompt, /最多 2 句/);
    assert.doesNotMatch(prompt, /每 3~4 句至少|说话气质：抽象/);
    const messages = brain.buildMessages({ history: [{ role: 'user', name: '甲', text: '我先躺了' }], scopeLabel: '测试', memeText: '- 躺平：放弃内卷；例：复活点见' });
    assert.match(messages[1].content, /梗库中与这轮人类消息直接相关/);
    assert.match(messages[1].content, /复活点见/);
    assert.match(messages[1].content, /默认一句，有必要再补一句/);
  });
}

async function fixture(t, { disabled = false, broken = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-banter-test-'));
  const store = new Store(dir);
  const seen = [], queries = [];
  const bot = new Bot({ config: { onebot: { selfId: '9' }, storage: { dataDir: dir }, persona: { name: 'GPT娘' }, kb: { enabled: !disabled }, chat: { enabled: true, replyPrivate: true, quietHours: [], historyTurns: 12, vision: { enabled: false }, webSearch: { enabled: false } } }, store, log,
    brain: { generate: async (args) => { seen.push(args); return { texts: ['复活点给你占着。'] }; } },
    onebot: { call: async () => ({ message_id: 123 }) },
    kb: { relevant(context) { queries.push(context); if (broken) throw new Error('broken KB'); return [{ name: '躺平', meaning: '放弃内卷', example: '复活点见' }]; } },
  });
  t.after(async () => { await bot.stop(); const target = path.resolve(dir); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('qq-banter-test-')); fs.rmSync(target, { recursive: true, force: true }); });
  bot.memory.set('private:456', [{ role: 'bot', name: 'GPT娘', text: '海拉鲁秘密神庙', at: Date.now() }, { role: 'user', userId: '789', text: '别人的游戏', at: Date.now() }, { role: 'user', userId: '456', text: '已经过时的话题', at: Date.now() - 3600_000 }]);
  await bot.onMessage({ post_type: 'message', message_type: 'private', self_id: 9, user_id: 456, message_id: 22, time: Math.floor(Date.now() / 1000), sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '我先躺平了' } }] });
  return { seen, queries };
}

test('passive reply receives local KB references from fresh same-human context only', async (t) => {
  const { seen, queries } = await fixture(t);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /我先躺平了/);
  assert.doesNotMatch(queries[0], /海拉鲁|别人的游戏|已经过时/);
  assert.match(seen[0].memeText, /复活点见/);
});

test('disabled KB does not retrieve and broken KB never prevents replies', async (t) => {
  const disabled = await fixture(t, { disabled: true });
  assert.equal(disabled.queries.length, 0);
  assert.equal(disabled.seen[0].memeText, '');
  const broken = await fixture(t, { broken: true });
  assert.equal(broken.seen.length, 1);
  assert.equal(broken.seen[0].memeText, '');
});
