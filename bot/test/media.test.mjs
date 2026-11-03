import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Bot } from '../src/bot.mjs';
import { Brain } from '../src/brain.mjs';
import { expandForward, framesFromGif, framesFromVideoFile, isAnimated, sniffMime } from '../src/media.mjs';
import { startMockLlm, startMockOneBot } from '../src/mock.mjs';
import { OneBot } from '../src/onebot.mjs';
import { forwardsOf, plainText, videosOf } from '../src/segments.mjs';
import { Store } from '../src/store.mjs';
import { Emitter, sleep } from '../src/util.mjs';
import { collectMedia, warmVideos } from '../src/vision.mjs';

// 3 帧 32x32 的红蓝小动图（ffmpeg 生成），用来测抽帧，不依赖任何外部文件
const TINY_GIF = Buffer.from(
  'R0lGODlhIAAgAPcfMQAAAAAAVQAAqgAA/wAkAAAkVQAkqgAk/wBIAABIVQBIqgBI/wBsAABsVQBsqgBs/wCQAACQVQCQqgCQ/wC0AAC0VQC0qgC0/wDYAADYVQDYqgDY/wD8AAD8VQD8qgD8/yQAACQAVSQAqiQA/yQkACQkVSQkqiQk/yRIACRIVSRIqiRI/yRsACRsVSRsqiRs/ySQACSQVSSQqiSQ/yS0ACS0VSS0qiS0/yTYACTYVSTYqiTY/yT8ACT8VST8qiT8/0gAAEgAVUgAqkgA/0gkAEgkVUgkqkgk/0hIAEhIVUhIqkhI/0hsAEhsVUhsqkhs/0iQAEiQVUiQqkiQ/0i0AEi0VUi0qki0/0jYAEjYVUjYqkjY/0j8AEj8VUj8qkj8/2wAAGwAVWwAqmwA/2wkAGwkVWwkqmwk/2xIAGxIVWxIqmxI/2xsAGxsVWxsqmxs/2yQAGyQVWyQqmyQ/2y0AGy0VWy0qmy0/2zYAGzYVWzYqmzY/2z8AGz8VWz8qmz8/5AAAJAAVZAAqpAA/5AkAJAkVZAkqpAk/5BIAJBIVZBIqpBI/5BsAJBsVZBsqpBs/5CQAJCQVZCQqpCQ/5C0AJC0VZC0qpC0/5DYAJDYVZDYqpDY/5D8AJD8VZD8qpD8/7QAALQAVbQAqrQA/7QkALQkVbQkqrQk/7RIALRIVbRIqrRI/7RsALRsVbRsqrRs/7SQALSQVbSQqrSQ/7S0ALS0VbS0qrS0/7TYALTYVbTYqrTY/7T8ALT8VbT8qrT8/9gAANgAVdgAqtgA/9gkANgkVdgkqtgk/9hIANhIVdhIqthI/9hsANhsVdhsqths/9iQANiQVdiQqtiQ/9i0ANi0Vdi0qti0/9jYANjYVdjYqtjY/9j8ANj8Vdj8qtj8//wAAPwAVfwAqvwA//wkAPwkVfwkqvwk//xIAPxIVfxIqvxI//xsAPxsVfxsqvxs//yQAPyQVfyQqvyQ//y0APy0Vfy0qvy0//zYAPzYVfzYqvzY//z8APz8Vfz8qvz8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEMgAfACwAAAAAIAAgAAAIiAAFDBhIcIDAggPBKVzIsCE4hBAROpy4MKLFARQpXowIbGJHhwUPIhSZceJGiCVBniyYsuFKlgs/NpQpMmTElgxfEsRZUSdGng99ymQ4tOfAmgRJAvX5kydToEF1EvUItarVq1gzFlW4FVzXrlnDih1b8itVh2DJql2L0yzas2zjyrXqdibcgAAAIfkEBTIAAAAsHwAfAAEAAQAACAQAAQQEACH5BAUyAAAALB8AHwABAAEAAAgEAAEEBAA7',
  'base64',
);

const FFMPEG = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
      && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

function makeConfig(overrides = {}) {
  return {
    llm: { mode: 'echo', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', maxTokens: 100, temperature: 0.5 },
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: {
      maxReplyChars: 160,
      historyChars: 4000,
      historyTurns: 24,
      recentSelfEcho: 5,
      vision: { enabled: true, maxImages: 3, maxBytes: 2000000, timeoutMs: 2000, totalFrames: 8 },
      ...overrides.chat,
    },
    ...overrides,
  };
}

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

test('segments 能取出视频段和合并转发段', () => {
  const segs = [
    { type: 'text', data: { text: '看这个' } },
    { type: 'video', data: { file: 'abc.mp4', url: 'https://cdn.example/v.mp4' } },
    { type: 'forward', data: { id: '+ABC' } },
  ];
  assert.deepEqual(videosOf(segs), [{ url: 'https://cdn.example/v.mp4', file: 'abc.mp4', cover: '' }]);
  assert.deepEqual(forwardsOf(segs), [{ id: '+ABC', url: '' }]);
  assert.match(plainText(segs), /\[视频\]/);
  assert.match(plainText(segs), /\[合并转发\]/);
});

test('sniffMime / isAnimated 认得出动图', () => {
  assert.equal(sniffMime(TINY_GIF), 'image/gif');
  assert.equal(isAnimated(TINY_GIF), true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  assert.equal(sniffMime(png), 'image/png');
  assert.equal(isAnimated(png), false);
});

test('expandForward 渲染成「谁：说了什么」，并收集内部的图和视频', async () => {
  const nodes = [
    { sender: { nickname: '阿强', card: '强哥' }, message: [{ type: 'text', data: { text: '晚饭吃啥' } }] },
    { sender: { nickname: '小明' }, message: [{ type: 'text', data: { text: '看这张' } }, { type: 'image', data: { url: 'https://cdn.example/a.jpg', sub_type: 0 } }] },
    { sender: { nickname: '小明' }, message: [{ type: 'video', data: { url: 'https://cdn.example/v.mp4', file: 'v.mp4' } }] },
  ];
  const onebot = {
    async call(action, params) {
      assert.equal(action, 'get_forward_msg');
      assert.equal(params.id, '+FW');
      return { messages: nodes };
    },
  };
  const got = await expandForward(onebot, '+FW', { maxNodes: 10, maxChars: 500 });
  assert.equal(got.count, 3);
  assert.equal(got.used, 3);
  assert.match(got.text, /^\[转发了聊天记录·3条\]/);
  assert.match(got.text, /强哥：晚饭吃啥/);
  assert.match(got.text, /小明：看这张\[图片\]/);
  assert.equal(got.images.length, 1);
  assert.equal(got.images[0].url, 'https://cdn.example/a.jpg');
  assert.equal(got.videos.length, 1);
});

test('expandForward 超时/失败返回 null，不抛错', async () => {
  assert.equal(await expandForward({ call: async () => { throw new Error('boom'); } }, 'x'), null);
  assert.equal(await expandForward(null, 'x'), null);
  assert.equal(await expandForward({ call: async () => ({ messages: [] }) }, 'x'), null);
});

test('动图抽帧：gif → 多张 jpeg', { skip: !FFMPEG && 'ffmpeg 不可用' }, async () => {
  const frames = await framesFromGif(TINY_GIF, { maxFrames: 3, width: 64 });
  assert.equal(frames.length, 3);
  for (const f of frames) assert.equal(sniffMime(f), 'image/jpeg');
});

test('视频抽帧：mp4 → 均匀 N 帧 + 时长', { skip: !FFMPEG && 'ffmpeg 不可用' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-vid-'));
  const file = path.join(dir, 'in.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=5', '-pix_fmt', 'yuv420p', file], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  try {
    const got = await framesFromVideoFile(file, { maxFrames: 3, width: 64 });
    assert.equal(got.frames.length, 3);
    assert.ok(got.durationSec > 1.5, `时长应约 2 秒，实际 ${got.durationSec}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectMedia：动图按帧数占预算，标成「动图1」', { skip: !FFMPEG && 'ffmpeg 不可用' }, async () => {
  const cfg = makeConfig();
  const row = { role: 'user', name: '阿强', text: '[发了一张图]', media: [{ file: `base64://${TINY_GIF.toString('base64')}` }] };
  const got = await collectMedia([row], cfg, { log });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'gif');
  assert.equal(got[0].label, '动图1');
  assert.equal(got[0].frames.length, 3);
  assert.ok(got[0].frames[0].startsWith('data:image/jpeg;base64,'));
  assert.equal(got[0].placeholder, '[发了一张图]');
});

test('端到端：合并转发会被展开，里面的图也送进模型', async () => {
  const mock = await startMockOneBot({ token: 'media-token', port: 0, wsPort: 0 });
  const llm = await startMockLlm({ port: 0, replies: ['看到了'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-media-'));
  const cfg = {
    onebot: {
      httpUrl: `http://127.0.0.1:${mock.httpPort}`,
      wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`,
      accessToken: 'media-token',
      selfId: 0,
    },
    llm: { mode: 'api', baseUrl: `http://127.0.0.1:${llm.port}/v1`, model: 'm', apiKey: 'x', maxTokens: 100, timeoutMs: 5000 },
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: {
      enabled: true,
      replyOnMention: true,
      aiDecide: false,
      cooldownMsPerUser: 0,
      cooldownMsPerGroup: 0,
      maxRepliesPerMinute: 100,
      historyTurns: 10,
      quietHours: [],
      splitReplies: { enabled: true, maxLen: 60, pauseMs: 5 },
      maxReplyChars: 200,
      vision: {
        enabled: true,
        maxImages: 3,
        maxBytes: 2000000,
        timeoutMs: 5000,
        gif: { enabled: false },
        video: { enabled: false },
        forward: { enabled: true, maxNodes: 10, maxChars: 800, timeoutMs: 3000 },
        totalFrames: 8,
      },
    },
    storage: { dataDir: path.join(dir, 'data') },
  };
  mock.setForwardNodes([
    { sender: { nickname: '阿强', card: '强哥' }, message: [{ type: 'text', data: { text: '晚饭吃啥' } }] },
    {
      sender: { nickname: '小明' },
      message: [
        { type: 'text', data: { text: '这张' } },
        { type: 'image', data: { file: 'base64://' + Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64') } },
      ],
    },
  ]);
  const store = new Store(cfg.storage.dataDir);
  const onebot = new OneBot(cfg.onebot, { log, onStatus: () => {} });
  const brain = new Brain(cfg, { log });
  const bot = new Bot({ config: cfg, onebot, store, brain, log, emitter: new Emitter() });
  await bot.start();
  try {
    assert.ok(await onebot.waitForOpen(5000), '事件流应连上 mock WS');
    mock.groupMessage({
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 你瞅瞅这个转发' } },
        { type: 'forward', data: { id: '+FW1' } },
      ],
      userId: 20002,
      name: '测试用户丙',
    });
    for (let i = 0; i < 150 && !llm.requests.length; i += 1) await sleep(30);
    assert.equal(llm.requests.length, 1, '应该打了一次模型请求');
    const content = llm.requests[0].messages[1].content;
    assert.ok(Array.isArray(content), 'user 消息应该是数组');
    const text = content[0].text;
    assert.match(text, /转发了聊天记录·2条/);
    assert.match(text, /强哥：晚饭吃啥/);
    const imgs = content.filter((p) => p.type === 'image_url');
    assert.equal(imgs.length, 1, '转发里的图应该也送进去');
    assert.ok(imgs[0].image_url.url.startsWith('data:image/'));
    // 落库的这一行也要带着展开后的文本，下次回看仍然看得见
    const rows = store.tail('group:123456', 5);
    assert.ok(rows.some((r) => /晚饭吃啥/.test(String(r.text || ''))), '落库文本应含转发内容');
  } finally {
    await bot.stop();
    await mock.close();
    await llm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：群里的视频会抽成多帧送进模型', { skip: !FFMPEG && 'ffmpeg 不可用' }, async () => {
  const mock = await startMockOneBot({ token: 'media-token', port: 0, wsPort: 0 });
  const llm = await startMockLlm({ port: 0, replies: ['看到了'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-media-'));
  const videoFile = path.join(dir, 'v.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=5', '-pix_fmt', 'yuv420p', videoFile], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const server = http.createServer((req, res) => {
    const buf = fs.readFileSync(videoFile);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v.mp4`;

  const cfg = {
    onebot: {
      httpUrl: `http://127.0.0.1:${mock.httpPort}`,
      wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`,
      accessToken: 'media-token',
      selfId: 0,
    },
    llm: { mode: 'api', baseUrl: `http://127.0.0.1:${llm.port}/v1`, model: 'm', apiKey: 'x', maxTokens: 100, timeoutMs: 5000 },
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: {
      enabled: true,
      replyOnMention: true,
      aiDecide: false,
      cooldownMsPerUser: 0,
      cooldownMsPerGroup: 0,
      maxRepliesPerMinute: 100,
      historyTurns: 10,
      quietHours: [],
      splitReplies: { enabled: true, maxLen: 60, pauseMs: 5 },
      maxReplyChars: 200,
      vision: {
        enabled: true,
        maxImages: 3,
        maxBytes: 2000000,
        timeoutMs: 5000,
        gif: { enabled: false },
        video: { enabled: true, maxVideos: 1, maxFrames: 3, maxBytes: 20_000_000, width: 64, timeoutMs: 15000 },
        forward: { enabled: false },
        totalFrames: 6,
      },
    },
    storage: { dataDir: path.join(dir, 'data') },
  };
  const store = new Store(cfg.storage.dataDir);
  const onebot = new OneBot(cfg.onebot, { log, onStatus: () => {} });
  const brain = new Brain(cfg, { log });
  const bot = new Bot({ config: cfg, onebot, store, brain, log, emitter: new Emitter() });
  await bot.start();
  try {
    assert.ok(await onebot.waitForOpen(5000), '事件流应连上 mock WS');
    mock.groupMessage({
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 这视频里是啥' } },
        { type: 'video', data: { file: 'v.mp4', url } },
      ],
      userId: 20002,
      name: '测试用户丙',
    });
    for (let i = 0; i < 250 && !llm.requests.length; i += 1) await sleep(30);
    assert.equal(llm.requests.length, 1, '应该打了一次模型请求');
    const content = llm.requests[0].messages[1].content;
    const text = content[0].text;
    assert.match(text, /视频1/);
    const imgs = content.filter((p) => p.type === 'image_url');
    assert.equal(imgs.length, 3, '应把 3 帧都送进去');
    for (const img of imgs) assert.ok(img.image_url.url.startsWith('data:image/jpeg;base64,'));
  } finally {
    await bot.stop();
    await mock.close();
    await llm.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('视频没抽到帧时会明确告诉模型别编内容', () => {
  const cfg = {
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: { historyChars: 4000 },
  };
  const brain = new Brain(cfg, { log });
  const row = { role: 'user', name: '甲', text: '[视频]', media: [], videos: [{ url: 'http://x/y.mp4', file: 'y.mp4' }] };
  const rawOf = (msgs) => msgs.at(-1).content;
  const textOf = (c) => (typeof c === 'string' ? c : c[0].text);
  const unseen = textOf(rawOf(brain.buildMessages({ history: [row], scopeLabel: '私聊', images: [] })));
  assert.match(unseen, /没取到画面/, '缺帧时要提醒模型别猜');
  assert.match(unseen, /别编/, '并且明确禁止编黑屏之类的细节');
  // 真的拿到帧了就不要再提这茬
  const seen = textOf(rawOf(brain.buildMessages({
    history: [row],
    scopeLabel: '私聊',
    images: [{ row, from: '甲', kind: 'video', frames: ['data:image/jpeg;base64,AA=='], label: '视频1', note: '时长约 3 秒' }],
  })));
  assert.doesNotMatch(seen, /没取到画面/);
});

test('视频预热：收到就开抽，回复时直接命中缓存（只下载一次）', { skip: !FFMPEG && 'ffmpeg 不可用' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-warm-'));
  const videoFile = path.join(dir, 'w.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=5', '-pix_fmt', 'yuv420p', videoFile], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const buf = fs.readFileSync(videoFile);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/w.mp4`;
  const cfg = {
    chat: {
      vision: {
        enabled: true,
        maxImages: 3,
        maxBytes: 2_000_000,
        timeoutMs: 5000,
        gif: { enabled: false },
        video: { enabled: true, maxVideos: 1, maxFrames: 2, maxBytes: 20_000_000, width: 64, timeoutMs: 15000, downloadTimeoutMs: 15000, waitMs: 1000 },
        forward: { enabled: false },
        totalFrames: 4,
      },
    },
  };
  const rows = [{ role: 'user', name: '甲', text: '[视频]', media: [], videos: [{ url, file: 'w.mp4' }] }];
  try {
    assert.equal(await warmVideos(rows, cfg, { log }), 1, '应启动一条视频预热');
    // 预热是后台跑的：等它落进缓存，再模拟回复时的收集
    let items = [];
    for (let i = 0; i < 120; i += 1) {
      items = await collectMedia(rows, cfg, { log });
      if (items.length) break;
      await sleep(50);
    }
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'video');
    assert.equal(items[0].frames.length, 2);
    assert.equal(hits, 1, '预热和回复应共用同一次下载');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('视频下完会补一句：第一句说没看清，第二句看到了（补话）', { skip: !FFMPEG && 'ffmpeg 不可用' }, async () => {
  const mock = await startMockOneBot({ token: 'media-token', port: 0, wsPort: 0 });
  const llm = await startMockLlm({ port: 0, replies: ['我看看…好像还没出来', '哦看到了，是个测试画面'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-vfix-'));
  const videoFile = path.join(dir, 'x.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=5', '-pix_fmt', 'yuv420p', videoFile], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const buf = fs.readFileSync(videoFile);
  const server = http.createServer(async (req, res) => {
    await sleep(1200); // 模拟慢下载：第一句回复来不及拿到画面
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/x.mp4`;

  const cfg = {
    onebot: {
      httpUrl: `http://127.0.0.1:${mock.httpPort}`,
      wsUrl: `ws://127.0.0.1:${mock.wsPort}/event`,
      accessToken: 'media-token',
      selfId: 0,
    },
    llm: { mode: 'api', baseUrl: `http://127.0.0.1:${llm.port}/v1`, model: 'm', apiKey: 'x', maxTokens: 100, timeoutMs: 5000 },
    persona: { name: '哈基米', identity: '群友', style: '简短', likes: [], rules: [] },
    chat: {
      enabled: true,
      replyOnMention: true,
      aiDecide: false,
      cooldownMsPerUser: 0,
      cooldownMsPerGroup: 0,
      maxRepliesPerMinute: 100,
      historyTurns: 10,
      quietHours: [],
      splitReplies: { enabled: false, maxLen: 60, pauseMs: 5 },
      maxReplyChars: 200,
      vision: {
        enabled: true,
        maxImages: 3,
        maxBytes: 2000000,
        timeoutMs: 5000,
        gif: { enabled: false },
        video: { enabled: true, maxVideos: 1, maxFrames: 2, maxBytes: 20_000_000, width: 64, timeoutMs: 15000, downloadTimeoutMs: 15000, waitMs: 0, followUp: true, followUpMs: 20000 },
        forward: { enabled: false },
        totalFrames: 4,
      },
    },
    storage: { dataDir: path.join(dir, 'data') },
  };
  const store = new Store(cfg.storage.dataDir);
  const onebot = new OneBot(cfg.onebot, { log, onStatus: () => {} });
  const brain = new Brain(cfg, { log });
  const bot = new Bot({ config: cfg, onebot, store, brain, log, emitter: new Emitter() });
  await bot.start();
  try {
    assert.ok(await onebot.waitForOpen(5000), '事件流应连上 mock WS');
    mock.groupMessage({
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 看这个视频' } },
        { type: 'video', data: { file: 'x.mp4', url } },
      ],
      userId: 20002,
      name: '测试用户丙',
    });
    for (let i = 0; i < 400 && llm.requests.length < 2; i += 1) await sleep(50);
    assert.equal(llm.requests.length, 2, '应打两次模型请求：第一句 + 补话');
    const first = llm.requests[0].messages[1].content;
    const firstText = Array.isArray(first) ? first[0].text : first;
    assert.match(firstText, /没取到画面/, '第一句要老实说没看到');
    assert.equal(Array.isArray(first) ? first.filter((p) => p.type === 'image_url').length : 0, 0, '第一句没有帧');
    const second = llm.requests[1].messages[1].content;
    assert.ok(Array.isArray(second), '补话这条应该带帧');
    assert.ok(second.filter((p) => p.type === 'image_url').length >= 2, '补话应带上视频帧');
    assert.match(second[0].text, /视频1/);
    assert.match(second[0].text, /补一句/);
    // 用户真的会收到两条消息
    for (let i = 0; i < 60 && mock.sentTexts().length < 2; i += 1) await sleep(50);
    assert.ok(mock.sentTexts().length >= 2, '补话要真的发出去');
    assert.match(mock.sentTexts().join('\n'), /测试画面/);
    // 后面再聊别的，不能把这条旧视频再补一遍（否则会一连串刷屏）
    mock.groupMessage({ message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 在吗' } }], userId: 20002, name: '测试用户丙' });
    for (let i = 0; i < 150 && llm.requests.length < 3; i += 1) await sleep(50);
    assert.equal(llm.requests.length, 3, '普通消息正常回一条');
    await sleep(4500); // 超过一次补话轮询间隔
    assert.equal(llm.requests.length, 3, '旧视频不许再触发补话');
  } finally {
    await bot.stop();
    await mock.close();
    await llm.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('视频下载失败会记一会儿，不反复重试', { skip: !FFMPEG && 'ffmpeg 不可用' }, async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(500).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/bad.mp4`;
  const cfg = {
    chat: {
      vision: {
        enabled: true, maxImages: 3, maxBytes: 2_000_000, timeoutMs: 3000,
        gif: { enabled: false },
        video: { enabled: true, maxVideos: 1, maxFrames: 2, maxBytes: 20_000_000, width: 64, timeoutMs: 4000, downloadTimeoutMs: 4000, waitMs: 4000 },
        forward: { enabled: false }, totalFrames: 4,
      },
    },
  };
  const rows = [{ role: 'user', name: '甲', text: '[视频]', media: [], videos: [{ url, file: 'bad.mp4' }] }];
  try {
    assert.deepEqual(await collectMedia(rows, cfg, { log }), []);
    assert.deepEqual(await collectMedia(rows, cfg, { log }), []);
    assert.equal(hits, 1, '失败后短时间内不该再打一次下载');
  } finally {
    server.close();
  }
});
