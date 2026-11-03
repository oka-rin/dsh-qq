import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTweetLinks } from '../src/bot.mjs';

test('能从群聊文字里抠出推文链接', () => {
  const text = '看这个 https://x.com/abc/status/1847293847293847293 笑死';
  assert.deepEqual(extractTweetLinks(text), ['https://x.com/abc/status/1847293847293847293']);
});

test('twitter.com 老域名、带参数、带标点都能认', () => {
  const text = '两条：https://twitter.com/foo/status/111111111111111111？还有 https://x.com/i/status/222222222222222222?s=20';
  const out = extractTweetLinks(text);
  assert.equal(out.length, 2);
  assert.match(out[0], /twitter\.com\/foo\/status\/111111111111111111/);
  assert.match(out[1], /x\.com\/i\/status\/222222222222222222/);
});

test('不是推文链接就不认，且最多 3 条', () => {
  assert.deepEqual(extractTweetLinks('https://x.com/abc'), []);
  assert.deepEqual(extractTweetLinks('https://bilibili.com/video/BV1xx'), []);
  assert.deepEqual(extractTweetLinks(''), []);
  const many = [1, 2, 3, 4, 5].map((n) => `https://x.com/u${n}/status/10000000000000000${n}`).join(' ');
  assert.equal(extractTweetLinks(many).length, 3);
});

test('同一条链接重复出现只留一次', () => {
  const u = 'https://x.com/a/status/1234567890123456789';
  assert.equal(extractTweetLinks(`${u} ${u}`).length, 1);
});
