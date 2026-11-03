import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as flushPromises } from 'node:timers/promises';
import { AgentLoop } from '../src/agent.mjs';

// All effects terminate in mocks; only an individually allocated temporary dataDir is written.
const log = { info() {}, warn() {}, debug() {}, error() {} };
const call = (name, args = {}) => ({ id: `test-${name}`, function: { name, arguments: JSON.stringify(args) } });
const response = (...calls) => ({ tool_calls: calls });
const skip = () => response(call('skip', { reason: '隔离测试跳过' }));
const send = () => response(call('send_message', { text: '隔离测试发言' }));
const local = (day, hours, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();

function clock(t, now = local(27, 12)) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  t.after(() => t.mock.timers.reset());
  return { set: (time) => t.mock.timers.setTime(time), tick: (ms) => t.mock.timers.tick(ms) };
}

function harness(t, { cfg = {}, rows = {}, entries = [], brain = {}, search } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'));
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir);
  const ledger = path.join(historyDir, 'agent-log.jsonl');
  fs.writeFileSync(ledger, entries.map((r) => JSON.stringify(r)).join('\n') + (entries.length ? '\n' : ''));
  const sends = [], ops = [], prompts = [], searches = [], instances = [];
  const config = { storage: { dataDir: dir }, agent: {
    enabled: true, targets: ['group:1'], quietHours: [], minPerDay: 0, maxPerDay: 16,
    minGapMs: 0, selfHoldMs: 600_000, everyMinutes: 1, jitterMinutes: 0,
    maxSteps: 6, maxActionsPerRound: 3, ...cfg,
  } };
  const bot = {
    cfg: config, groups: new Map(),
    recent: (scope, limit = 20) => (rows[scope] || []).slice(-limit),
    send: async (scope, text) => { sends.push({ scope, text }); return sends.length; },
    onebot: { call: async (action, params) => { ops.push({ action, params }); return { tid: 'fake-tid' }; } },
  };
  const fakeBrain = {
    ...brain,
    chatWithTools: async (input) => {
      prompts.push(input.messages[1].content);
      return brain.chatWithTools ? brain.chatWithTools(input) : send();
    },
  };
  const fakeSearch = async (...args) => { searches.push(args); return search ? search(...args) : []; };
  // A mistakenly un-injected source or other direct fetch is a test failure, never a network call.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('NETWORK FORBIDDEN IN AGENT AUDIT'); });
  function create() {
    const a = new AgentLoop({ config, bot, brain: fakeBrain, log, search: fakeSearch });
    instances.push(a);
    return a;
  }
  const a = create();
  t.after(() => {
    for (const instance of instances) instance.stop();
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'cleanup must stay directly under tmpdir');
    assert.ok(path.basename(resolved).startsWith('agent-audit-'), 'cleanup requires the allocated audit prefix');
    assert.equal(fs.realpathSync(resolved), resolved, 'cleanup must not follow a replaced symlink');
    fs.rmSync(resolved, { recursive: true });
  });
  const records = () => fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { a, config, rows, sends, ops, prompts, searches, records, create };
}

const persisted = (scope, at, kind = 'speak', extra = {}) => ({ scope, at, kind, ok: true, ...extra });

// Scope accounting, force semantics, and synchronous mutex.
test('cross-scope send cannot exceed private quota or consume the group ledger', async (t) => {
  clock(t);
  const h = harness(t, {
    cfg: { targets: ['group:1', 'private:2'], maxPerDay: 1, maxSteps: 1 },
    entries: [persisted('private:2', Date.now() - 60_000)],
    brain: { chatWithTools: async () => response(call('send_message', { scope: 'private:2', text: '不得越账' })) },
  });
  const out = await h.a.tick();
  assert.equal(out.ok, false);
  assert.equal(h.sends.length, 0);
  assert.equal(h.a.history.length, 0);
  assert.equal(h.records().filter((r) => r.ok && ['speak', 'share'].includes(r.kind)).length, 1);
});

for (const action of ['send_msg', 'send_group_msg', 'send_private_msg', 'send_group_forward_msg', 'send_private_forward_msg', 'send_qzone_msg']) {
  test(`raw ${action} cannot bypass the guarded send executors`, async (t) => {
    clock(t);
    const h = harness(t, { cfg: { maxSteps: 1 }, brain: { chatWithTools: async () => response(call('qq_op', { action, params: { user_id: 2, message: '不得直发' } })) } });
    assert.equal((await h.a.tick()).ok, false);
    assert.equal(h.ops.length, 0);
    assert.equal(h.sends.length, 0);
  });
}

test('one remaining daily credit permits only one write from a multi-step tool batch', async (t) => {
  clock(t);
  const h = harness(t, { cfg: { maxPerDay: 1, maxSteps: 2, maxActionsPerRound: 3 }, brain: {
    chatWithTools: async () => response(...Array.from({ length: 3 }, () => call('qq_op', { action: 'send_like', params: { user_id: 2 } }))),
  } });
  assert.equal((await h.a.tick()).ok, true);
  assert.equal(h.ops.length, 1);
  assert.equal(h.records().filter((r) => r.ok && r.kind === 'op').length, 1);
  assert.equal((await h.a.tick()).reason, 'daily-cap');
});

test('maxActionsPerRound is shared by all model steps, not renewed per step', async (t) => {
  clock(t);
  const h = harness(t, { cfg: { maxSteps: 6, maxActionsPerRound: 3 }, brain: {
    chatWithTools: async () => response(call('read_history')),
  } });
  await h.a.tick();
  assert.equal(h.prompts.length, 3);
  assert.equal(h.records().length, 3);
});

for (const method of ['tick', 'act']) {
  test(`concurrent ${method} calls synchronously reject the second caller as busy`, async (t) => {
    clock(t);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness(t, { cfg: { maxPerDay: 1 }, brain: { chatWithTools: async () => { await gate; return send(); } } });
    const invoke = () => method === 'act' ? h.a.act('group:1') : h.a.tick();
    const first = invoke();
    const second = await invoke();
    assert.equal(second.reason, 'busy');
    release();
    assert.equal((await first).ok, true);
    assert.equal(h.sends.length, 1);
  });
}

for (const [reason, cfg, entries] of [
  ['disabled', { enabled: false }, []],
  ['quiet-hours', { quietHours: ['00:00-23:59'] }, []],
  ['daily-cap', { maxPerDay: 0 }, []],
  ['min-gap', { minGapMs: 300_000 }, [() => persisted('group:1', Date.now() - 60_000)]],
]) {
  test(`act(force:false) respects ${reason}`, async (t) => {
    clock(t);
    const h = harness(t, { cfg, entries: entries.map((entry) => entry()) });
    assert.equal((await h.a.act('group:1', { force: false })).reason, reason);
    assert.equal(h.sends.length, 0);
  });
}

test('force bypasses business gates but never stopped state', async (t) => {
  clock(t);
  const h = harness(t, { cfg: { enabled: false, maxPerDay: 0, quietHours: ['00:00-23:59'] } });
  assert.equal((await h.a.act('group:1', { force: true })).ok, true);
  h.a.stop();
  for (const force of [false, true]) {
    assert.equal((await h.a.act('group:1', { force })).reason, 'stopped');
    assert.equal((await h.a.tick({ force })).reason, 'stopped');
  }
  assert.equal(h.sends.length, 1);
});

test('timer hitting a busy manual round rearms and continues after the slow round', async (t) => {
  const time = clock(t);
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let turns = 0;
  const h = harness(t, { brain: { chatWithTools: async () => {
    turns += 1;
    if (turns === 1) { entered(); await gate; }
    return skip();
  } } });
  h.a.start();
  const first = h.a.act('group:1');
  await started;
  time.tick(60_000);
  await flushPromises();
  assert.ok(h.a.timer, 'busy timer must retain a successor');
  release();
  await first;
  time.tick(60_000);
  await flushPromises();
  assert.equal(turns, 2, 'a subsequent scheduled round must actually reach the model');
});

// Skip/floor must not lose side effects or break the self-talk guard.
test('successful qq_op followed by skip is recorded and never retried or floor-filled', async (t) => {
  clock(t);
  let completeCalls = 0;
  const h = harness(t, { cfg: { minPerDay: 1 }, brain: {
    chatWithTools: async () => response(call('qq_op', { action: 'send_like', params: { user_id: 2 } }), call('skip')),
    complete: async () => { completeCalls += 1; return '不应触发兜底'; },
  } });
  const out = await h.a.tick();
  assert.equal(h.ops.length, 1);
  assert.equal(h.sends.length, 0);
  assert.equal(h.prompts.length, 1);
  assert.equal(completeCalls, 0);
  assert.equal(out.actions.filter((a) => a.name === 'qq_op' && a.result.ok).length, 1);
  assert.equal(h.records().filter((r) => r.kind === 'op' && r.ok).length, 1);
});

test('both skip rounds remain in the ledger and result before a single floor send', async (t) => {
  clock(t);
  const h = harness(t, { cfg: { minPerDay: 1 }, brain: { chatWithTools: async () => skip(), complete: async () => '安全隔离兜底一句' } });
  const out = await h.a.tick();
  assert.equal(out.actions.filter((a) => a.name === 'skip').length, 2);
  assert.equal(h.records().filter((r) => r.kind === 'skip').length, 2);
  assert.equal(h.sends.length, 1);
});

for (const phase of ['round', 'fallback']) {
  test(`a passive bot reply arriving during ${phase} blocks the floor write`, async (t) => {
    clock(t);
    const rows = { 'group:1': [{ role: 'user', text: '刚才的问题', ts: Date.now() - 20_000 }] };
    let completes = 0;
    const appendReply = () => rows['group:1'].push({ role: 'bot', text: '被动回复已到', ts: Date.now() });
    const h = harness(t, { rows, cfg: { minPerDay: 1 }, brain: {
      chatWithTools: async () => { if (phase === 'round') appendReply(); return skip(); },
      complete: async () => { completes += 1; if (phase === 'fallback') appendReply(); return '不应连续自言自语'; },
    } });
    await h.a.tick();
    assert.equal(h.sends.length, 0);
    assert.equal(completes, phase === 'round' ? 0 : 1);
  });
}

// Daily limits reset at local midnight; min-gap does not.
test('natural-day credits reset in a live process exactly as after restart', async (t) => {
  const time = clock(t, local(27, 23, 59));
  const h = harness(t, { cfg: { maxPerDay: 1 } });
  assert.equal((await h.a.tick()).ok, true);
  time.set(local(28, 0, 1));
  assert.equal((await h.a.tick()).ok, true);
  assert.equal((await h.create().tick()).reason, 'daily-cap');
  assert.equal(h.sends.length, 2);
});

test('persisted min-gap includes the previous day across a restart', async (t) => {
  const time = clock(t, local(28, 0, 1));
  const h = harness(t, { cfg: { minGapMs: 300_000 }, entries: [persisted('group:1', local(27, 23, 59))] });
  assert.equal((await h.a.tick()).reason, 'min-gap');
  time.set(local(28, 0, 4));
  assert.equal((await h.a.tick()).ok, true);
  assert.equal(h.sends.length, 1);
});

test('dryRun writes neither real sends nor memory quota and remains repeatable', async (t) => {
  clock(t);
  const h = harness(t, { cfg: { dryRun: true, maxPerDay: 1, minGapMs: 300_000 } });
  assert.equal((await h.a.tick()).ok, true);
  assert.equal((await h.a.tick()).ok, true);
  assert.equal(h.a.history.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.records().length, 2);
  assert.ok(h.records().every((r) => r.dry));
});

for (const tool of ['send_message', 'post_qzone', 'qq_op']) {
  test(`crossing into quiet hours during generation prevents ${tool}`, async (t) => {
    const time = clock(t, local(27, 22, 59));
    const args = tool === 'send_message' ? { text: '不应夜间发送' }
      : tool === 'post_qzone' ? { content: '不应夜间发说说' } : { action: 'send_like', params: { user_id: 2 } };
    const h = harness(t, { cfg: { quietHours: ['23:00-08:00'], maxSteps: 1 }, brain: {
      chatWithTools: async () => { time.set(local(27, 23, 1)); return response(call(tool, args)); },
    } });
    const out = await h.a.tick();
    assert.equal(out.ok, false);
    assert.equal(out.actions[0].result.error, 'quiet-hours');
    assert.equal(h.sends.length + h.ops.length, 0);
  });
}

test('stop during generation blocks pending writes even in forced mode', async (t) => {
  clock(t);
  let stop;
  const h = harness(t, { cfg: { maxSteps: 1 }, brain: { chatWithTools: async () => { stop(); return send(); } } });
  stop = () => h.a.stop();
  await h.a.act('group:1', { force: true });
  assert.equal(h.sends.length, 0);
});

test('target selection excludes a held high-score group and serves an eligible private chat', async (t) => {
  clock(t);
  const h = harness(t, { cfg: { targets: ['group:1', 'private:2'] }, rows: {
    'group:1': [{ role: 'user', text: '@我', toMe: true, ts: Date.now() - 120_000 }, { role: 'bot', text: '已回', ts: Date.now() - 60_000 }],
    'private:2': [{ role: 'user', text: '这边还在等', ts: Date.now() - 60_000 }],
  } });
  assert.equal((await h.a.tick()).ok, true);
  assert.equal(h.sends[0].scope, 'private:2');
});

for (const recentQzone of [false, true]) {
  test(`manual share has a share brief regardless of rotation state (recent qzone=${recentQzone})`, async (t) => {
    clock(t);
    const entries = [persisted('group:1', Date.now() - 60_000, 'share')];
    if (recentQzone) entries.push(persisted('group:1', Date.now() - 60_000, 'qzone'));
    const h = harness(t, { entries, brain: { chatWithTools: async () => skip() } });
    await h.a.act('group:1', { mode: 'share' });
    const prompt = h.prompts[0];
    assert.match(prompt, /本轮任务：share/);
    assert.match(prompt, /这轮的任务是【主动分享】/);
    // 分享现在分三档（只说话 / 带链接 / 发表情包），不再固定要求先搜索
    assert.match(prompt, /不用发链接|find_content|send_meme/);
    assert.doesNotMatch(prompt, /这轮的任务是【发一条 QQ 空间】/);
  });
}

// Search is constructor-injected: no provider/network calls are needed for source validation.
test('find_content returns no old material when all results have already been shared', async (t) => {
  clock(t);
  const url = 'https://example.test/already-shared';
  const h = harness(t, {
    entries: [persisted('group:1', Date.now() - 60_000, 'share', { detail: url, urls: [url] })],
    search: async () => [{ title: '旧标题', url }],
    brain: { chatWithTools: async () => response(call('find_content', { source: 'bilibili', keyword: '隔离素材' }), call('skip')) },
  });
  const out = await h.a.act('group:1');
  assert.deepEqual(out.actions[0].result.items, []);
  assert.match(out.actions[0].result.note, /都分享过/);
  assert.equal(h.searches.length, 1);
  assert.equal(h.sends.length, 0);
});

for (const variant of ['unsearched', 'unknown-url', 'valid']) {
  test(`share URL/title provenance validation: ${variant}`, async (t) => {
    clock(t);
    const url = 'https://example.test/fresh-material';
    const title = '搜源给出的原始标题';
    const text = variant === 'unknown-url' ? `${title} https://example.test/fabricated` : `随口一句 ${url}`;
    const h = harness(t, { cfg: { maxSteps: 1 }, search: async () => [{ title, url }], brain: {
      chatWithTools: async () => response(
        ...(variant === 'unsearched' ? [] : [call('find_content', { keyword: '素材' })]),
        call('send_message', { text }),
      ),
    } });
    const out = await h.a.act('group:1');
    assert.equal(h.sends.length, variant === 'valid' ? 1 : 0);
    assert.equal(out.actions.at(-1).result.ok, variant === 'valid');
    if (variant === 'valid') assert.equal(h.records().at(-1).kind, 'share');
  });
}

test('a long URL is persisted whole and remains deduplicated after restart despite detail truncation', async (t) => {
  clock(t);
  const title = '长链接原始标题';
  const url = `https://example.test/${'material-'.repeat(50)}`;
  let attempt = 0;
  const h = harness(t, { search: async () => [{ title, url }], brain: {
    chatWithTools: async () => ++attempt === 1
      ? response(call('find_content', { keyword: '长链接' }), call('send_message', { text: `${title} ${url}` }))
      : response(call('find_content', { keyword: '长链接' }), call('skip')),
  } });
  assert.equal((await h.a.act('group:1')).ok, true);
  const write = h.records().find((r) => r.kind === 'share' && r.ok);
  assert.equal(write.detail.length, 200);
  assert.ok(!write.detail.includes(url), 'legacy detail is too short for the whole URL');
  assert.deepEqual(write.urls, [url]);
  const out = await h.create().act('group:1');
  assert.deepEqual(out.actions[0].result.items, []);
  assert.equal(h.sends.length, 1);
});

test('说话隔了 10 分钟以上，上下文里会标出「话题已经过去了」', async () => {
  const { Brain } = await import('../src/brain.mjs');
  const b = new Brain({ llm: {}, persona: { name: '我' }, chat: {} }, {});
  const now = Date.now();
  const out = b.renderTranscript([
    { role: 'user', name: '测试用户甲', text: '赏你一个红包', ts: now - 40 * 60000 },
    { role: 'user', name: '测试用户乙', text: '玩不了', ts: now },
  ]);
  assert.match(out, /隔了 40 分钟没人说话/);
  assert.match(out, /测试用户甲: 赏你一个红包/);
});

test('回复某个人时明确「别人发的图和旧玩笑不算他头上」', async () => {
  const { Brain } = await import('../src/brain.mjs');
  const b = new Brain({ llm: {}, persona: { name: '我' }, chat: { historyChars: 6000, recentSelfEcho: 5 } }, {});
  const now = Date.now();
  const m = b.buildMessages({
    history: [
      { role: 'user', name: '测试用户甲', text: '赏你一个红包', ts: now - 40 * 60000 },
      { role: 'user', name: '测试用户乙', text: '玩不了', ts: now },
    ],
    scopeLabel: '群',
    groupInfo: null,
    triggerReason: 'mention',
  });
  const text = m[1].content;
  assert.match(text, /只对着 测试用户乙 说话/);
  assert.match(text, /红包/);
  assert.match(text, /不能接着安给他/);
});

test('同一人第一次出现带 QQ 号；符号昵称给稳定的「群友+后四位」', async () => {
  const { Brain } = await import('../src/brain.mjs');
  const b = new Brain({ llm: {}, persona: { name: '我' }, chat: {} }, {});
  const now = Date.now();
  const out = b.renderTranscript([
    { role: 'user', name: '测试用户甲', userId: '10000001', text: '你是n卡？', ts: now - 60000 },
    { role: 'user', name: '★☆★', userId: '10000005', text: '开离线还要开关客户端一次', ts: now - 30000 },
    { role: 'user', name: '测试用户甲', userId: '10000001', text: '对', ts: now - 1000 },
  ]);
  assert.match(out, /测试用户甲（QQ 10000001）: 你是n卡？/);
  assert.match(out, /群友0005（QQ 10000005）:/);
  assert.match(out, /\n测试用户甲: 对/); // 第二次不再重复 QQ 号
  assert.ok(!out.includes('★☆★'), '符号昵称不该出现在上下文里');
});
