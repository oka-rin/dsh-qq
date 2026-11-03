import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const call = (name, args = {}) => ({ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } });

function harness(t, { agent = {}, brain, shortVideos, videoDownloader } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-video-'));
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  const sent = [];
  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16,
      minGapMs: 0, selfHoldMs: 0, everyMinutes: 1, jitterMinutes: 0, maxSteps: 3, maxActionsPerRound: 2,
      shareEveryHours: 4, qzoneEveryHours: 20, ...agent,
    },
  };
  const bot = {
    cfg: config,
    groups: new Map(),
    recent: () => [{ role: 'user', name: '阿强', text: '哈哈这个好笑', ts: Date.now() - 30_000 }],
    send: async (scope, text) => { sent.push({ scope, text }); return 11; },
    sendVideo: async (scope, file, opts) => {
      sent.push({ scope, video: file, exists: fs.existsSync(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0, caption: opts?.caption || '' });
      return 22;
    },
    sendImage: async () => 33,
    onebot: { call: async () => ({}) },
  };
  const fakeBrain = { chatWithTools: async (input) => brain(input) };
  const a = new AgentLoop({
    config, bot, brain: fakeBrain, log,
    search: async () => [],
    images: async () => [],
    shortVideos,
    videoDownloader,
  });
  t.after(() => { a.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { a, dir, sent };
}

const cand = {
  title: '猫翻车名场面', url: 'https://www.bilibili.com/video/BV1aaa111', bvid: 'BV1aaa111', cid: 101, duration: 18,
};

test('share_video 下载→发送→删掉原件', async (t) => {
  let downloaded = null;
  const { a, dir, sent } = harness(t, {
    shortVideos: async () => [cand],
    videoDownloader: async ({ dir: target }) => {
      fs.mkdirSync(target, { recursive: true });
      const file = path.join(target, 'v-fake.mp4');
      fs.writeFileSync(file, Buffer.alloc(4096, 7));
      downloaded = file;
      return { file, size: 4096 };
    },
    brain: () => ({ tool_calls: [call('share_video', { keyword: '猫 搞笑', text: '这猫有点离谱' })] }),
  });

  const out = await a.act('group:1', { force: true });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].exists, true, '发的时候文件必须还在');
  assert.equal(sent[0].size, 4096);
  assert.equal(sent[0].caption, '这猫有点离谱');
  assert.equal(fs.existsSync(downloaded), false, '发完要删掉下载的原件');
});

test('share_video 找不到 30 秒以内的片就不发', async (t) => {
  const { a, sent } = harness(t, {
    shortVideos: async () => [],
    videoDownloader: async () => assert.fail('不该去下载'),
    brain: () => ({ tool_calls: [call('share_video', { keyword: '长视频' })] }),
  });
  const out = await a.act('group:1', { force: true });
  const action = out.actions.find((x) => x.name === 'share_video');
  assert.equal(action.result.ok, false);
  assert.match(action.result.error, /30 秒以内/);
  assert.equal(sent.length, 0);
});

test('演练模式下不下载也不发', async (t) => {
  const { a, sent } = harness(t, {
    agent: { dryRun: true },
    shortVideos: async () => [cand],
    videoDownloader: async () => assert.fail('演练不该下载'),
    brain: () => ({ tool_calls: [call('share_video', { keyword: '猫' })] }),
  });
  const out = await a.act('group:1', { force: true });
  const action = out.actions.find((x) => x.name === 'share_video');
  assert.equal(action.result.ok, true);
  assert.equal(action.result.dryRun, true);
  assert.equal(sent.length, 0);
});

test('配文里的运营腔会被打回', async (t) => {
  const { a, sent } = harness(t, {
    shortVideos: async () => [cand],
    videoDownloader: async () => assert.fail('被打回就不该下载'),
    brain: () => ({ tool_calls: [call('share_video', { keyword: '猫', text: '强烈推荐这个，必看！' })] }),
  });
  const out = await a.act('group:1', { force: true });
  const action = out.actions.find((x) => x.name === 'share_video');
  assert.equal(action.result.ok, false);
  assert.equal(sent.length, 0);
});

test('图片类爱好的展开方式里包含发短视频', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-video-roll-'));
  const config = {
    storage: { dataDir: dir },
    agent: {
      enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16,
      interestGroups: [{ name: '美图美少女', weight: 100, media: 'image', topics: ['美少女写真'] }],
    },
  };
  const a = new AgentLoop({
    config, bot: { cfg: config, recent: () => [], groups: new Map() }, brain: { chatWithTools: async () => ({}) }, log,
  });
  const counts = { picture: 0, video: 0, talk: 0, other: 0 };
  for (let i = 0; i < 600; i += 1) {
    const plan = a.sharePlanForTest();
    if (counts[plan.style] === undefined) counts.other += 1;
    else counts[plan.style] += 1;
  }
  a.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(counts.video > 90, `video 档太少：${counts.video}`);
  assert.ok(counts.picture > counts.video, `pictures 应该最多：${JSON.stringify(counts)}`);
  assert.equal(counts.other, 0, '不该出现别的形态');
});
