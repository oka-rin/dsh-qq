import test from 'node:test';
import assert from 'node:assert/strict';
import { drawPromptOf, expandPrompt, wantsDraw, wantsRedraw, wantsResend, wantsWait } from '../src/imagegen.mjs';

test('wantsDraw 认得「画一张 XX」这类需求', () => {
  for (const t of ['帮我画一张赛博朋克风格的猫', '生成一张二次元美少女壁纸', '能不能画个表情包', '来张图', '画一张图里写着哈基米的梗图']) {
    assert.equal(wantsDraw(t), true, t);
  }
});

test('wantsDraw 不把「说画风/图不错」这类聊天当成画图需求', () => {
  for (const t of ['这图画风不错', '这个漫画挺好看', '你吃了吗', '', '哈哈哈草']) {
    assert.equal(wantsDraw(t), false, t);
  }
});

test('drawPromptOf 把「画一张 的」剥掉，只留画面主体', () => {
  assert.equal(drawPromptOf('帮我画一张赛博朋克风格的猫'), '赛博朋克风格的猫');
  assert.equal(drawPromptOf('生成一张二次元美少女壁纸'), '二次元美少女');
});

test('expandPrompt 拿不到模型就退回原句，不抛错', async () => {
  assert.equal(await expandPrompt(null, '一只猫'), '一只猫');
  const broken = { complete: async () => { throw new Error('boom'); } };
  assert.equal(await expandPrompt(broken, '一只猫'), '一只猫');
});

test('expandPrompt 用模型改写结果', async () => {
  const brain = { complete: async () => '  一只橘猫趴在键盘上，霓虹灯背景  ' };
  assert.equal(await expandPrompt(brain, '来张图'), '一只橘猫趴在键盘上，霓虹灯背景');
});

test('续图三类意图分得开：重发 / 改图 / 催进度', () => {
  // 用户真实原话（2026-11-02 私聊）
  assert.equal(wantsResend('图片又过期了，重发'), true);
  assert.equal(wantsResend('你重新生成一遍吧'), false);
  assert.equal(wantsRedraw('你重新生成一遍吧'), true);
  assert.equal(wantsRedraw('这个是折纸反转好吧，给我重画'), true);
  assert.equal(wantsWait('还没得吗？'), true);
  assert.equal(wantsWait('在画吗'), true);
  assert.equal(wantsWait('哈哈哈'), false);
  assert.equal(wantsResend('哈哈哈'), false);
  assert.equal(wantsRedraw('今天天气不错'), false);
});
