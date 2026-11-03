import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ControlServer } from '../src/control.mjs';
import { DAILY_NEWS_DEFAULTS } from '../src/daily-news.mjs';
import { NEWS_SOURCES } from '../src/daily-catalog.mjs';

async function fixture(t, dailyNews = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-daily-config-'));
  const configPath = path.join(dir, 'config.json');
  const config = {
    control: { host: '127.0.0.1', port: 0, token: 'config-test' },
    storage: { dataDir: dir },
    agent: { targets: ['group:11'], groups: ['22'], hiddenAgentValue: 'keep' },
    chat: { blacklistGroups: ['33'] },
    dailyNews: { ...structuredClone(DAILY_NEWS_DEFAULTS), ...dailyNews },
    llm: { apiKey: 'not-editable' },
    hiddenTop: { keep: true },
    __runtimeOnly: 'do not persist',
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  let restarts = 0;
  const originalSetTimeout = globalThis.setTimeout;
  // A successful config POST normally restarts the service. Never exit the test process.
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 400) { restarts++; return { unref() {} }; }
    return originalSetTimeout(fn, delay, ...args);
  });
  const server = new ControlServer({ config, configPath, bot: { send() { throw new Error('QQ sends forbidden'); } },
    dailyNews: { status: () => ({ enabled: true, recent: {}, today: {} }) },
    log: { info() {}, error() {} } });
  await server.listen();
  t.after(async () => {
    await server.close();
    assert.ok(path.isAbsolute(dir) && dir.startsWith(path.join(os.tmpdir(), 'snowluma-daily-config-')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const request = (route, init = {}) => fetch(base + route, {
    ...init, headers: { authorization: 'Bearer config-test', 'content-type': 'application/json', ...init.headers },
  });
  const post = (patch) => request('/api/config', { method: 'POST', body: JSON.stringify({ patch }) });
  const draft = async () => (await (await request('/api/config')).json()).editable;
  return { server, config, configPath, dir, request, post, draft, restarts: () => restarts };
}

test('complete editable draft roundtrips all 12 IDs and exact custom times without exposing hidden fields', async (t) => {
  const times = Object.fromEntries(NEWS_SOURCES.map((id, i) => [id, `${String(i).padStart(2, '0')}:07`]));
  const f = await fixture(t, { sources: NEWS_SOURCES, sourceTimes: times, notBeforeDate: '2028-02-29', hiddenDailyValue: { keep: true } });
  const draft = await f.draft();
  assert.equal(NEWS_SOURCES.length, 12);
  assert.equal(draft.dailyNews.hiddenDailyValue, undefined);
  assert.equal(draft.llm.apiKey, undefined);
  assert.deepEqual(draft.dailyNews.sourceTimes, times);
  const response = await f.post(draft);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.deepEqual((await f.draft()).dailyNews, draft.dailyNews);
  const saved = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.deepEqual(saved.dailyNews.sourceTimes, times);
  assert.deepEqual(saved.dailyNews.hiddenDailyValue, { keep: true });
  assert.deepEqual(saved.hiddenTop, { keep: true });
  assert.equal(saved.agent.hiddenAgentValue, 'keep');
  assert.equal(saved.llm.apiKey, 'not-editable');
  assert.equal('__runtimeOnly' in saved, false);
  assert.equal(f.restarts(), 1);
});

test('empty sources cancels subscriptions and exact map replacement clears overrides while preserving defaults', async (t) => {
  const f = await fixture(t, { sourceTimes: { epic: '18:09', ai: '10:01' }, notBeforeDate: '2026-11-01', hidden: 42 });
  const response = await f.post({ dailyNews: { sources: [], sourceTimes: {}, notBeforeDate: '', enabled: false } });
  assert.equal(response.status, 200);
  const saved = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.deepEqual(saved.dailyNews.sources, []);
  assert.deepEqual(saved.dailyNews.sourceTimes, {});
  assert.equal(saved.dailyNews.notBeforeDate, '');
  assert.equal(saved.dailyNews.hidden, 42);
  assert.equal(saved.dailyNews.retryMinutes, DAILY_NEWS_DEFAULTS.retryMinutes);
  assert.equal(saved.dailyNews.time, DAILY_NEWS_DEFAULTS.time);
  assert.deepEqual(saved.agent.targets, ['group:11']);
});

test('partial daily patch preserves omitted source times and legacy daily config receives defaults', async (t) => {
  const f = await fixture(t, { sourceTimes: { ai: '09:05', epic: '19:59' } });
  delete f.server.cfg.dailyNews.sourceGapMs;
  const response = await f.post({ dailyNews: { dryRun: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(f.server.cfg.dailyNews.sourceTimes, { ai: '09:05', epic: '19:59' });
  assert.equal(f.server.cfg.dailyNews.sourceGapMs, 1500);
  assert.equal(f.server.cfg.dailyNews.dryRun, true);
});

const invalidDailyPatches = [
  null, [], false, 'bad',
  { enabled: 1 }, { deduplicate: 'true' }, { dryRun: null },
  { time: '24:00' }, { time: '10:60' }, { time: '9:00' }, { time: 1000 }, { time: '10:00\n' },
  { timeZone: 'UTC' }, { timeZone: null },
  { sources: ['unknown'] }, { sources: 'ai' }, { sources: [1] },
  { sourceTimes: [] }, { sourceTimes: null }, { sourceTimes: { unknown: '10:00' } },
  { sourceTimes: { ai: '25:00' } }, { sourceTimes: { ai: 1000 } }, { sourceTimes: { ai: '10:00\n' } },
  { retryMinutes: 0 }, { retryMinutes: 61 }, { retryMinutes: '10' }, { retryMinutes: 1.5 },
  { catchUpMinutes: 0 }, { catchUpMinutes: 181 }, { sourceGapMs: -1 }, { sourceGapMs: 10001 },
  { notBeforeDate: '2026-02-29' }, { notBeforeDate: '2026-04-31' },
  { notBeforeDate: '2026-1-01' }, { notBeforeDate: '2026-01-01T00:00:00Z' }, { notBeforeDate: null },
  { unknown: true },
];

test('invalid daily patches reject the whole operation without mutation, disk writes or restarts', async (t) => {
  const f = await fixture(t, { sourceTimes: { ai: '09:03' }, hidden: true });
  const before = structuredClone(f.server.cfg);
  const disk = fs.readFileSync(f.configPath, 'utf8');
  for (const dailyNews of invalidDailyPatches) {
    const response = await f.post({ agent: { targets: [] }, dailyNews });
    assert.equal(response.status, 400, JSON.stringify(dailyNews));
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, 'string');
    assert.deepEqual(f.server.cfg, before);
    assert.deepEqual(f.config, before);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), disk);
    assert.equal(f.restarts(), 0);
  }
});

test('valid range boundaries and leap day are accepted without coercion', async (t) => {
  const f = await fixture(t);
  for (const dailyNews of [
    { retryMinutes: 1, catchUpMinutes: 1, sourceGapMs: 0, notBeforeDate: '2024-02-29', time: '00:00' },
    { retryMinutes: 60, catchUpMinutes: 180, sourceGapMs: 10000, time: '23:59', notBeforeDate: '' },
  ]) {
    const response = await f.post({ dailyNews });
    assert.equal(response.status, 200);
    for (const [key, value] of Object.entries(dailyNews)) assert.equal(f.server.cfg.dailyNews[key], value);
  }
});

test('malformed JSON and invalid request/patch containers return POST errors without changes', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.server.cfg);
  const disk = fs.readFileSync(f.configPath, 'utf8');
  for (const body of ['{', 'null', '[]', 'false', '{"patch":null}', '{"patch":[]}']) {
    const response = await f.request('/api/config', { method: 'POST', body });
    assert.equal(response.status, 400, body);
    assert.equal((await response.json()).ok, false);
    assert.deepEqual(f.server.cfg, before);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), disk);
  }
  assert.equal(f.restarts(), 0);
});

test('write errors return 400 without swapping the running config or scheduling restart', async (t) => {
  const f = await fixture(t);
  const before = f.server.cfg;
  f.server.configPath = path.join(f.dir, 'missing-directory', 'config.json');
  const response = await f.post({ dailyNews: { enabled: true } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
  assert.equal(f.server.cfg, before);
  assert.equal(f.restarts(), 0);
});

test('daily status includes last 50 log events including source errors and tolerates malformed JSONL', async (t) => {
  const f = await fixture(t);
  const logFile = path.join(f.dir, 'daily-news-log.jsonl');
  assert.deepEqual((await (await f.request('/api/daily-news')).json()).dailyNews.recentEvents, []);
  const rows = Array.from({ length: 70 }, (_, at) => ({ at, source: 'ai', status: at === 69 ? 'source-error' : 'sent', ...(at === 69 ? { error: 'upstream failure' } : {}) }));
  fs.writeFileSync(logFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n{broken}\n{"partial"');
  const response = await f.request('/api/daily-news');
  assert.equal(response.status, 200);
  const events = (await response.json()).dailyNews.recentEvents;
  assert.deepEqual(events, rows.slice(-50));
  assert.equal(events.at(-1).error, 'upstream failure');
  // A multi-megabyte prefix must not be read or parsed as one growing log.
  fs.writeFileSync(logFile, 'x'.repeat(2 * 1024 * 1024) + '\n' + rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  let largestRead = 0;
  const originalRead = fs.readSync;
  t.mock.method(fs, 'readSync', (...args) => { largestRead = Math.max(largestRead, args[3]); return originalRead(...args); });
  assert.deepEqual((await (await f.request('/api/daily-news')).json()).dailyNews.recentEvents, rows.slice(-50));
  assert.ok(largestRead <= 256 * 1024);
});
