import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemeKB } from '../src/kb.mjs';
import { AgentLoop } from '../src/agent.mjs';
import { BANTER_RULE } from '../src/brain.mjs';

function kbFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kb = new MemeKB({ dataDir: dir });
  kb.addMany([
    { name: '泰裤辣', meaning: '太酷啦的谐音', heat: 100 },
    { name: '原生态', meaning: '不用农药的菜，用来回应游戏打得菜', usage: '对方嘲笑游戏水平菜时', example: '没打农药，纯天然的', heat: 5 },
    { name: '电子榨菜', meaning: '吃饭时看的轻松视频', usage: '午饭配视频', heat: 10 },
    { name: 'CPU', meaning: '借处理器说被别人操控', heat: 20 },
  ]);
  return { kb, dir };
}

test('context retrieval exact name wins, no hottest fallback or common-word flood', (t) => {
  const { kb } = kbFixture(t);
  assert.equal(kb.relevant('你这个原生态，游戏水平真菜')[0].name, '原生态');
  assert.deepEqual(kb.relevant('你好，今天这个事情怎么样'), []);
  assert.deepEqual(kb.relevant(''), []);
  assert.deepEqual(kb.relevant('https://example.com/cpusage'), []);
  assert.equal(kb.relevant('你又在 CPU 我')[0].name, 'CPU');
  assert.deepEqual(kb.relevant('视频'), []);
});

test('context retrieval matches usage tokens, limits JSON budget without mutating originals', (t) => {
  const { kb } = kbFixture(t);
  assert.equal(kb.relevant('他们嘲笑我的游戏水平')[0].name, '原生态');
  const before = JSON.stringify(kb.all());
  const rows = kb.relevant('原生态和电子榨菜', { limit: 1, budget: 70 });
  assert.equal(rows.length, 1);
  assert.ok(JSON.stringify(rows).length <= 70);
  assert.equal(JSON.stringify(kb.all()), before);
  assert.deepEqual(kb.relevant('原生态', { budget: 0 }), []);
  assert.deepEqual(kb.relevant('原生态', { limit: 0 }), []);
});

const call = (name, args = {}) => ({ id: name, function: { name, arguments: JSON.stringify(args) } });
function agentFixture(t) {
  const { kb, dir } = kbFixture(t);
  let recent = [{ role: 'user', userId: '1', name: '阿强', text: '原生态', at: 1 }];
  const inputs = [], riffInputs = [], contexts = [];
  const originalRelevant = kb.relevant.bind(kb);
  kb.relevant = (context, options) => { contexts.push(context); return originalRelevant(context, options); };
  const config = { storage: { dataDir: dir }, agent: { enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 20, minGapMs: 0, maxSteps: 1, maxActionsPerRound: 2 } };
  const brain = {
    persona: { abstract: false },
    async chatWithTools(input) { inputs.push(input); return { tool_calls: [call('skip', { reason: 'test' })] }; },
    async complete(input) { riffInputs.push(input); return '没打农药纯天然 ||| 原生态'; },
  };
  const bot = { cfg: config, groups: new Map(), brain, recent: () => recent, onebot: { call: async () => ({}) } };
  const agent = new AgentLoop({ config, bot, brain, kb, log: { info() {}, warn() {}, debug() {} } });
  t.after(() => agent.stop());
  return { agent, brain, kb, inputs, riffInputs, contexts, setRecent: (rows) => { recent = rows; } };
}

test('coin_meme tool reports rejected entries honestly and still stores valid coins', async (t) => {
  const h = agentFixture(t);
  let name = '这是一条超过十四个字所以不能被当作名字保存的句子';
  h.brain.chatWithTools = async () => ({ tool_calls: [call('coin_meme', { name, meaning: '测试自造词', example: '仅测试临时库' })] });
  const before = h.kb.all().length;
  const bad = await h.agent.act('group:1', { force: true, mode: 'chat' });
  assert.equal(bad.actions[0].result.ok, false);
  assert.match(bad.actions[0].result.error, /没有写入/);
  assert.equal(h.kb.all().length, before);
  name = '离线测试梗';
  const good = await h.agent.act('group:1', { force: true, mode: 'chat' });
  assert.equal(good.actions[0].result.saved, 'new');
  assert.equal(h.kb.all().find((r) => r.name === name).source, 'bot');
  assert.equal(h.kb.all().length, before + 1);
});

test('agent contextual KB ignores bot text, shares banter rules and invalidates riff on human scene change', async (t) => {
  const h = agentFixture(t);
  await h.agent.act('group:1', { force: true, mode: 'chat' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.riffInputs.length, 1);
  assert.match(h.inputs[0].messages[1].content, /原生态/);
  assert.doesNotMatch(h.inputs[0].messages[1].content, /泰裤辣|造梗 = 模仿/);
  assert.ok(h.inputs[0].messages[0].content.includes(BANTER_RULE[1]));
  await h.agent.act('group:1', { force: true, mode: 'chat' });
  assert.match(h.inputs.at(-1).messages[1].content, /没打农药纯天然/);
  h.setRecent([{ role: 'bot', text: '电子榨菜', at: 2 }, { role: 'user', name: '阿强', text: '今天天气如何', at: 3 }]);
  await h.agent.act('group:1', { force: true, mode: 'chat' });
  assert.doesNotMatch(h.inputs.at(-1).messages[1].content, /没打农药纯天然|梗库里与眼下/);
  assert.ok(h.contexts.every((text) => !text.includes('电子榨菜')));
  assert.equal(h.riffInputs.length, 1, 'unrelated scene does not launch paid riff generation');
});
