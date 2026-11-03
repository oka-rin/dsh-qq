import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  parseTweetUrl,
  pickTweetMedia,
  downloadMedia,
  _internals,
} from '../src/twitter.mjs';

test('能认出各种形态的推文地址', () => {
  const id = '440322224407314432';
  assert.equal(parseTweetUrl(`https://x.com/TheEllenShow/status/${id}`), id);
  assert.equal(parseTweetUrl(`https://twitter.com/foo/status/${id}?s=20&t=abc`), id);
  assert.equal(parseTweetUrl(`https://x.com/i/web/status/${id}`), id);
  assert.equal(parseTweetUrl(id), id);
  assert.equal(parseTweetUrl('https://x.com/TheEllenShow'), null);
  assert.equal(parseTweetUrl('随便一句话'), null);
  assert.equal(parseTweetUrl(''), null);
});

test('优先选时长合规的视频，取最高码率', () => {
  const tweet = {
    media: {
      all: [
        {
          type: 'video',
          duration: 12.5,
          variants: [
            { url: 'https://video.twimg.com/a-low.mp4?tag=1', bitrate: 320000 },
            { url: 'https://video.twimg.com/a-high.mp4?tag=1', bitrate: 2176000 },
            { url: 'https://video.twimg.com/a.m3u8', bitrate: 9999 },
          ],
        },
        { type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg', width: 100, height: 100 },
      ],
    },
  };
  const got = pickTweetMedia(tweet, { maxSeconds: 30 });
  assert.equal(got.kind, 'video');
  assert.match(got.url, /a-high\.mp4/);
  assert.equal(got.durationSec, 12.5);
});

test('视频超时长就退回图片，并挑最大的那张', () => {
  const tweet = {
    media: {
      all: [
        { type: 'video', duration: 95, variants: [{ url: 'https://video.twimg.com/long.mp4', bitrate: 999 }] },
        { type: 'photo', url: 'https://pbs.twimg.com/media/small.jpg', width: 200, height: 200 },
        { type: 'photo', url: 'https://pbs.twimg.com/media/big.jpg', width: 1920, height: 1080 },
      ],
    },
  };
  const got = pickTweetMedia(tweet, { maxSeconds: 30 });
  assert.equal(got.kind, 'photo');
  assert.match(got.url, /big\.jpg/);
});

test('没有可用媒体时返回 null', () => {
  assert.equal(pickTweetMedia({ media: { all: [] } }), null);
  assert.equal(pickTweetMedia({}), null);
  assert.equal(
    pickTweetMedia({ media: { all: [{ type: 'video', duration: 61, variants: [{ url: 'https://video.twimg.com/x.mp4' }] }] } }),
    null,
  );
});

test('只允许从 twimg 域名下载（挡住任意 URL）', async () => {
  await assert.rejects(() => downloadMedia('https://example.com/a.jpg'), /不认识的媒体域名/);
  await assert.rejects(() => downloadMedia('file:///etc/passwd'), /不认识的媒体域名/);
  await assert.rejects(() => downloadMedia('not a url'), /不是合法的媒体地址/);
  assert.deepEqual(_internals.MEDIA_HOSTS, ['pbs.twimg.com', 'video.twimg.com']);
});

test('agent 里挂了 share_tweet，并且默认限额存在', () => {
  const src = fs.readFileSync(new URL('../src/agent.mjs', import.meta.url), 'utf8');
  assert.match(src, /name: 'share_tweet'/);
  assert.match(src, /case 'share_tweet':/);
  assert.match(src, /maxTweetMB: 30/);
  // 发完必须删原件
  assert.match(src, /if \(twFile\) fs\.rmSync\(twFile, \{ force: true \}\)/);
});
