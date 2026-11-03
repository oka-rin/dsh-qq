import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXhsUrl, extractNote, _internals } from '../src/xhs.mjs';
import { extractXhsLinks } from '../src/bot.mjs';
import { TOOL_NAMES_FOR_TEST } from '../src/agent.mjs';

test('认出各种小红书链接', () => {
  assert.equal(parseXhsUrl('https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a').id, '65f0a1b2c3d4e5f60718293a');
  assert.equal(parseXhsUrl('https://www.xiaohongshu.com/discovery/item/65f0a1b2c3d4e5f60718293a').id, '65f0a1b2c3d4e5f60718293a');
  assert.equal(parseXhsUrl('https://xhslink.com/aBcD12').short, true);
  assert.equal(parseXhsUrl('65f0a1b2c3d4e5f60718293a').id, '65f0a1b2c3d4e5f60718293a');
  assert.equal(parseXhsUrl('https://example.com/abc'), null);
});

test('从消息里抓小红书链接并去重', () => {
  const text = '看这个 https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a 还有 https://xhslink.com/aBcD12 。再贴一遍 https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a';
  const got = extractXhsLinks(text);
  assert.equal(got.length, 2);
  assert.ok(got[0].includes('explore/65f0'));
  assert.ok(got[1].includes('xhslink'));
  assert.deepEqual(extractXhsLinks('没有链接'), []);
});

test('只认小红书 CDN 的媒体地址', () => {
  assert.ok(_internals.mediaUrl('https://sns-webpic-qc.xhscdn.com/2026/abc.jpg'));
  assert.ok(_internals.mediaUrl('//sns-video-bd.xhscdn.com/stream/x.mp4'));
  assert.equal(_internals.mediaUrl('https://evil.com/x.jpg'), '');
  assert.equal(_internals.mediaUrl('javascript:alert(1)'), '');
});

test('从页面里挖出图片和视频', () => {
  const note = {
    title: '今天的穿搭',
    desc: '氛围感',
    user: { nickname: '小红' },
    imageList: [
      { urlDefault: 'https://sns-webpic-qc.xhscdn.com/a.jpg' },
      { urlDefault: 'https://sns-webpic-qc.xhscdn.com/b.jpg' },
    ],
  };
  const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ feed: { noteDetailMap: { n1: { note } } } })}</script>`;
  const got = extractNote(html, 'n1');
  assert.equal(got.title, '今天的穿搭');
  assert.equal(got.images.length, 2);
  assert.equal(got.author, '小红');

  const withVideo = {
    title: '视频笔记',
    video: { media: { stream: { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/x.mp4' }] } } },
    imageList: [],
  };
  const html2 = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ feed: { noteDetailMap: { n2: { note: withVideo } } } })}</script>`;
  assert.equal(extractNote(html2, 'n2').video, 'https://sns-video-bd.xhscdn.com/x.mp4');
});

test('页面里没有 INITIAL_STATE 就返回 null', () => {
  assert.equal(extractNote('<html>登录后查看</html>', 'x'), null);
});

test('agent 里有 share_xhs 工具', () => {
  assert.ok(TOOL_NAMES_FOR_TEST.includes('share_xhs'));
});
