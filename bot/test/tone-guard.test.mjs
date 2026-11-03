import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TONE_GUARD } from '../src/bot.mjs';

const hit = (text) => TONE_GUARD.some((re) => re.test(String(text)));

test('普通还嘴放行：护栏只拦越线的', () => {
  for (const t of ['你才是煞笔', '滚蛋吧你', '有病吧', '菜就多练', '抖M是吧']) {
    assert.equal(hit(t), false, `${t} 不该被拦`);
  }
});

test('骂家人 / 动手威胁 / 咒人去死仍然拦下', () => {
  for (const t of ['你妈才煞笔', '信不信我收拾你', '弄死你', '去死吧', '你全家']) {
    assert.equal(hit(t), true, `${t} 应该被拦`);
  }
});
