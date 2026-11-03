import test from 'node:test';
import assert from 'node:assert/strict';
import { missingMust, refinePrompt } from '../src/promptbrain.mjs';

/** 按顺序吐预设结果的假模型；cfg 默认开副脑 */
function fakeBrain(...results) {
  const seen = [];
  return {
    seen,
    complete: async (args) => {
      seen.push(args);
      const r = results.shift();
      if (r instanceof Error) throw r;
      return r ?? '';
    },
  };
}
const cfg = { image: { promptBrain: { enabled: true, timeoutMs: 3000 } } };

test('missingMust 忽略标点空白，能认出被漏掉的要素', () => {
  assert.deepEqual(missingMust('一只橘猫，趴在键盘上', ['橘猫', '键盘']), []);
  assert.deepEqual(missingMust('一只猫趴在键盘上', ['橘猫', '键盘', '霓虹灯']), ['橘猫', '霓虹灯']);
});

test('要素都写进提示词就不返工，直接用它', async () => {
  const brain = fakeBrain(JSON.stringify({ must: ['橘猫', '键盘'], prompt: '一只橘猫趴在机械键盘上，夜景霓虹' }));
  const r = await refinePrompt(brain, '画个橘猫在键盘上', { cfg });
  assert.equal(r.refined, true);
  assert.equal(r.repaired, false);
  assert.equal(r.prompt, '一只橘猫趴在机械键盘上，夜景霓虹');
  assert.equal(brain.seen.length, 1, '不该多调一次');
});

test('漏了要素就让副脑补一遍，用补好的那句', async () => {
  const brain = fakeBrain(
    JSON.stringify({ must: ['橘猫', '机械键盘'], prompt: '一只猫趴在桌上' }),
    '一只猫趴在桌上，桌上是一只橘猫和一把机械键盘',
  );
  const r = await refinePrompt(brain, '画橘猫趴机械键盘上', { cfg });
  assert.equal(r.repaired, true);
  assert.equal(brain.seen.length, 2);
  assert.match(r.prompt, /机械键盘/);
  assert.match(r.prompt, /橘猫/);
});

test('补也补不回来就硬把要素挂在末尾，保证不跑偏', async () => {
  const brain = fakeBrain(
    JSON.stringify({ must: ['哈基米', '橘猫'], prompt: '一只猫在沙发上' }),
    '一只猫在沙发上',
  );
  const r = await refinePrompt(brain, '画哈基米那只橘猫', { cfg });
  assert.deepEqual(r.appended, ['哈基米', '橘猫']);
  assert.match(r.prompt, /画面必须包含：哈基米、橘猫$/);
});

test('repair 关掉时不再多调一次，直接硬补', async () => {
  const brain = fakeBrain(JSON.stringify({ must: ['红色'], prompt: '一辆跑车' }));
  const r = await refinePrompt(brain, '画红色跑车', { cfg: { image: { promptBrain: { enabled: true, repair: false } } } });
  assert.equal(brain.seen.length, 1);
  assert.match(r.prompt, /画面必须包含：红色/);
});

test('模型不可用/报错就退回原句，绝不挡着画图', async () => {
  const off = { prompt: '一只猫', must: [] };
  assert.deepEqual(await refinePrompt(null, '一只猫', { cfg }), { ...off, refined: false, repaired: false, appended: [] });
  const boom = fakeBrain(new Error('boom'));
  assert.equal((await refinePrompt(boom, '一只猫', { cfg })).prompt, '一只猫');
  const disabled = await refinePrompt(fakeBrain('不该被调用'), '一只猫', { cfg: { image: { promptBrain: { enabled: false } } } });
  assert.equal(disabled.prompt, '一只猫');
  assert.equal(disabled.refined, false);
});

test('模型没吐 JSON 时把它当提示词用，至少不比原句差', async () => {
  const brain = fakeBrain('  一只橘猫趴在键盘上，霓虹灯背景  ');
  const r = await refinePrompt(brain, '来张图', { cfg });
  assert.equal(r.prompt, '一只橘猫趴在键盘上，霓虹灯背景');
  assert.deepEqual(r.must, []);
});

test('提示词超长会被截到 maxChars', async () => {
  const long = '一只猫'.repeat(80);
  const brain = fakeBrain(JSON.stringify({ must: ['一只猫'], prompt: long }));
  const r = await refinePrompt(brain, '画猫', { cfg: { image: { promptBrain: { enabled: true, maxChars: 100 } } } });
  assert.equal([...r.prompt].length, 100);
});

test('配了 model 就把模型名透传给 brain.complete（副脑可以用别的模型）', async () => {
  const brain = fakeBrain(JSON.stringify({ must: ['猫'], prompt: '一只猫在窗台上晒太阳' }));
  await refinePrompt(brain, '画猫', { cfg: { image: { promptBrain: { enabled: true, model: 'gemini-3.8-flash-medium' } } } });
  assert.equal(brain.seen[0].model, 'gemini-3.8-flash-medium');
  const plain = fakeBrain(JSON.stringify({ must: ['猫'], prompt: '一只猫在窗台上晒太阳' }));
  await refinePrompt(plain, '画猫', { cfg });
  assert.equal(plain.seen[0].model, undefined, '没配就别塞 model 字段');
});
