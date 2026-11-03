import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DailyNewsScheduler, localNewsTime, selectedNewsGroups } from '../src/daily-news.mjs';
import { NEWS_SOURCES, NEWS_SOURCE_TIMES, fetchScheduledNews } from '../src/daily-catalog.mjs';

function fixture(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-daily-news-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-29T09:00:00+08:00');
  const cfg = { storage: { dataDir: dir }, agent: { targets: ['group:11', 'private:22', 'group:11'], dryRun: false },
    dailyNews: { enabled: true, time: '09:00', timeZone: 'Asia/Shanghai', retryMinutes: 10, catchUpMinutes: 120, sourceGapMs: 0, sources: ['ithome', 'ai', '60s'], ...patch } };
  const sent = [], fetched = [];
  const bot = { status: () => ({ selfId: '3', transport: { http: 'ok' } }), send: async (...args) => { sent.push(args); return sent.length; } };
  const fetchNews = async (kind, { date }) => { fetched.push(kind); return { title: kind, text: `${kind} ${date}`, dedupeKey: `${kind}/${date}`, sourceDate: date, sourceUrl: 'https://example.com' }; };
  const options = { config: cfg, getConfig: () => cfg, bot, fetchNews, now: () => now, log: { info() {}, error() {} } };
  const scheduler = new DailyNewsScheduler(options);
  return { cfg, bot, sent, fetched, scheduler, options, dir, setTime(value) { now = Date.parse(value); } };
}

test('Shanghai clock ignores host timezone; targets never include private', () => {
  assert.deepEqual(localNewsTime(Date.parse('2026-10-29T01:00:00Z')), { date: '2026-10-29', minute: 540 });
  assert.deepEqual(selectedNewsGroups({ agent: { targets: [], groups: [44] } }), []);
  assert.deepEqual(selectedNewsGroups({ agent: { targets: ['private:1', 'group:2', 'group:2', 'group:0', 'x'] } }), ['group:2']);
  assert.deepEqual(selectedNewsGroups({ agent: { groups: [44] } }), []);
  assert.deepEqual(selectedNewsGroups({ agent: { targets: 'bad', groups: [44] } }), []);
  assert.deepEqual(selectedNewsGroups({ agent: { targets: ['group:1','group:2'] }, chat: { muteGroups: [1], whitelistGroups: [1] } }), []);
});

test('no early send, once per group/source/day; restart cannot duplicate', async (t) => {
  const f = fixture(t);
  f.setTime('2026-10-29T08:59:59+08:00');
  assert.equal((await f.scheduler.tick()).reason, 'outside-window');
  f.setTime('2026-10-29T09:00:00+08:00');
  assert.equal((await f.scheduler.tick()).ok, true);
  assert.equal(f.sent.length, 3);
  assert(f.sent.every(([scope]) => scope === 'group:11'));
  assert.equal((await f.scheduler.tick()).reason, 'already-sent');
  assert.equal((await new DailyNewsScheduler(f.options).tick()).reason, 'already-sent');
  f.setTime('2026-10-30T09:00:00+08:00');
  await f.scheduler.tick();
  assert.equal(f.sent.length, 6);
});

test('new install starts tomorrow; restarts catch up only inside window', async (t) => {
  const f = fixture(t, { notBeforeDate: '2026-10-30' });
  assert.equal((await f.scheduler.tick()).reason, 'not-started');
  f.setTime('2026-10-30T10:59:00+08:00');
  await f.scheduler.tick();
  assert.equal(f.sent.length, 3);
  f.setTime('2026-10-31T11:00:00+08:00');
  assert.equal((await f.scheduler.tick()).reason, 'outside-window');
  assert.equal(f.sent.length, 3);
});

test('old/empty source blocked, failed source retries while sent sources do not', async (t) => {
  const f = fixture(t);
  f.options.fetchNews = async (kind, { date }) => ({ sourceDate: kind === 'ai' ? '2026-10-28' : date, text: 'news' });
  const scheduler = new DailyNewsScheduler(f.options);
  const first = await scheduler.tick();
  assert.equal(first.ok, false);
  assert.equal(f.sent.length, 2);
  assert.equal((await scheduler.tick()).reason, 'retry-wait');
  scheduler.fetchNews = async (_, { date }) => ({ sourceDate: date, text: 'fresh AI' });
  f.setTime('2026-10-29T09:10:00+08:00');
  await scheduler.tick();
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2][1], 'fresh AI');
});

test('uncertain/null send fails closed, never replayed after restart', async (t) => {
  const f = fixture(t, { sources: ['60s'] });
  f.bot.send = async (...args) => { f.sent.push(args); return null; };
  const result = await f.scheduler.tick();
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, 'uncertain');
  f.setTime('2026-10-29T09:10:00+08:00');
  assert.equal((await new DailyNewsScheduler(f.options).tick()).reason, 'already-sent');
  assert.equal(f.sent.length, 1);
});

test('pending send intent survives crash and corrupted state does not reset receipts', async (t) => {
  const f = fixture(t, { sources: ['60s'] });
  fs.writeFileSync(f.scheduler.file, JSON.stringify({ receipts: { '2026-10-29/group:11/60s': { status: 'sending' } } }));
  assert.equal((await new DailyNewsScheduler(f.options).tick()).reason, 'already-sent');
  fs.writeFileSync(f.scheduler.file, '{bad');
  assert.throws(() => new DailyNewsScheduler(f.options));
  assert.equal(f.sent.length, 0);
});

test('offline/dry do not consume receipt; unselected targets never receive', async (t) => {
  const f = fixture(t);
  f.bot.status = () => ({ transport: { http: 'error' } });
  assert.equal((await f.scheduler.tick()).reason, 'offline');
  f.cfg.agent.dryRun = true;
  f.setTime('2026-10-29T09:10:00+08:00');
  const dry = await f.scheduler.tick();
  assert(dry.results.every((r) => r.dry));
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.scheduler.state.receipts, {});
  f.cfg.agent.dryRun = false;
  f.bot.status = () => ({ selfId: '3', transport: { http: 'ok' } });
  f.setTime('2026-10-29T09:20:00+08:00');
  await f.scheduler.tick();
  assert.equal(f.sent.length, 3);
});

test('unsubscribe or stop during fetch prevents send; no new targets leak', async (t) => {
  const f = fixture(t);
  f.scheduler.fetchNews = async (_, { date }) => { f.cfg.agent.targets = ['private:22']; return { text: 'news', sourceDate: date }; };
  await f.scheduler.tick();
  assert.equal(f.sent.length, 0);
  const g = fixture(t);
  g.scheduler.fetchNews = async (_, { date }) => { g.scheduler.stop(); return { text: 'news', sourceDate: date }; };
  await g.scheduler.tick();
  assert.equal(g.sent.length, 0);
});

test('falsy persisted receipts fail closed rather than replay', async (t) => {
  const f = fixture(t, { sources: ['60s'] });
  for (const value of [null, false, 0, '']) {
    fs.writeFileSync(f.scheduler.file, JSON.stringify({ receipts: { '2026-10-29/group:11/60s': value } }));
    assert.equal((await new DailyNewsScheduler(f.options).tick()).reason, 'already-sent');
  }
  assert.equal(f.sent.length, 0);
});

function recoveringBot(f, probe) {
  let http = 'error';
  f.bot.selfId = '';
  f.bot.status = () => ({ selfId: f.bot.selfId, transport: { http } });
  f.bot.onebot = { loginInfo: async () => { const info = await probe(); http = 'ok'; return info; } };
}

test('offline startup recovers identity using read-only login probe', async (t) => {
  const f = fixture(t);
  recoveringBot(f, async () => ({ user_id: 3, nickname: 'recovered' }));
  assert.equal((await f.scheduler.tick()).ok, true);
  assert.equal(f.bot.selfId, '3');
  assert.equal(f.bot.nickname, 'recovered');
  assert.equal(f.sent.length, 3);
});

test('failed or invalid identity probe never fetches or sends; later recovery retries', async (t) => {
  const f = fixture(t);
  let response = new Error('offline');
  recoveringBot(f, async () => { if (response instanceof Error) throw response; return response; });
  assert.equal((await f.scheduler.tick()).reason, 'offline');
  response = { user_id: 0 };
  f.setTime('2026-10-29T09:10:00+08:00');
  assert.equal((await f.scheduler.tick()).reason, 'offline');
  response = {};
  f.setTime('2026-10-29T09:20:00+08:00');
  assert.equal((await f.scheduler.tick()).reason, 'offline');
  assert.equal(f.fetched.length, 0);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.scheduler.state.receipts, {});
  response = { uin: 3 };
  f.setTime('2026-10-29T09:30:00+08:00');
  assert.equal((await f.scheduler.tick()).ok, true);
  assert.equal(f.sent.length, 3);
});

for (const change of ['unsubscribe', 'dry']) {
  test(`config ${change} during login probe blocks real delivery`, async (t) => {
    const f = fixture(t);
    recoveringBot(f, async () => {
      if (change === 'unsubscribe') f.cfg.agent.targets = [];
      else f.cfg.agent.dryRun = true;
      return { user_id: 3 };
    });
    await f.scheduler.tick();
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.scheduler.state.receipts, {});
  });
}

for (const change of ['sources', 'time', 'notBeforeDate', 'enabled', 'catchUpMinutes']) {
  test(`config ${change} changed during fetch blocks stale work`, async (t) => {
    const f = fixture(t, { sources: ['60s'] });
    f.scheduler.fetchNews = async (_, { date }) => {
      if (change === 'sources') f.cfg.dailyNews.sources = [];
      if (change === 'time') f.cfg.dailyNews.time = '10:00';
      if (change === 'notBeforeDate') f.cfg.dailyNews.notBeforeDate = '2026-10-30';
      if (change === 'enabled') f.cfg.dailyNews.enabled = false;
      if (change === 'catchUpMinutes') { f.cfg.dailyNews.catchUpMinutes = 1; f.setTime('2026-10-29T09:01:00+08:00'); }
      return { text: 'news', sourceDate: date };
    };
    await f.scheduler.tick();
    assert.equal(f.sent.length, 0);
  });
}

test('synchronous busy guard blocks concurrent scheduler entry', async (t) => {
  const f = fixture(t, { sources: ['60s'] });
  let release;
  f.scheduler.fetchNews = async (_, { date }) => { await new Promise((resolve) => { release = resolve; }); return { text: 'news', sourceDate: date }; };
  const first = f.scheduler.tick();
  assert.equal((await f.scheduler.tick()).reason, 'busy');
  release(); await first;
  assert.equal(f.sent.length, 1);
});

test('all twelve sources split 10am and 6pm with separate retry clocks', async (t) => {
  assert.equal(NEWS_SOURCES.length, 12);
  const f = fixture(t, { sources: NEWS_SOURCES, time: '10:00', sourceTimes: NEWS_SOURCE_TIMES });
  f.setTime('2026-10-29T09:59:59+08:00');
  assert.equal((await f.scheduler.tick()).reason, 'outside-window');
  f.setTime('2026-10-29T10:00:00+08:00');
  await f.scheduler.tick();
  assert.equal(f.sent.length, 5);
  assert.deepEqual(f.fetched.sort(), ['60s', 'ai', 'ithome', 'ithome-rank', 'gold'].sort());
  f.setTime('2026-10-29T12:00:00+08:00');
  assert.equal((await f.scheduler.tick()).reason, 'outside-window');
  // Even 10-minute retry throttling from another source must not delay new evening work.
  f.scheduler.lastAttempts.set('ai', Date.parse('2026-10-29T17:59:00+08:00'));
  f.setTime('2026-10-29T18:00:00+08:00');
  await f.scheduler.tick();
  assert.equal(f.sent.length, 12);
  assert.equal((await f.scheduler.tick()).reason, 'already-sent');
  f.setTime('2026-10-30T20:00:00+08:00');
  assert.equal((await f.scheduler.tick()).reason, 'outside-window');
});

test('unchanged content is skipped across days and restarts, changed Epic sends', async (t) => {
  const f = fixture(t, { sources: ['epic'], time: '18:00', sourceTimes: { epic: '18:00' } });
  let offers = 'offer-A/window-A';
  f.scheduler.fetchNews = async (_, { date }) => ({ sourceDate: date, text: `Epic ${date}`, dedupeKey: offers });
  f.setTime('2026-10-29T18:00:00+08:00');
  await f.scheduler.tick();
  f.setTime('2026-10-30T18:00:00+08:00');
  const restarted = new DailyNewsScheduler({ ...f.options, fetchNews: f.scheduler.fetchNews });
  const unchanged = await restarted.tick();
  assert.equal(unchanged.results[0].status, 'unchanged');
  assert.equal(f.sent.length, 1);
  assert.equal((await restarted.tick()).reason, 'already-sent');
  offers = 'offer-B/window-B';
  f.setTime('2026-10-31T18:00:00+08:00');
  await restarted.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(restarted.status().today['2026-10-31/group:11/epic'].status, 'sent');
});

test('dedupe is per group/source, not global; only real successful sends update latest', async (t) => {
  const f = fixture(t, { sources: ['gold'], sourceTimes: { gold: '09:00' } });
  f.scheduler.fetchNews = async (_, { date }) => ({ sourceDate: date, text: 'price', dedupeKey: 'same-price' });
  f.cfg.agent.dryRun = true;
  await f.scheduler.tick();
  assert.equal(f.scheduler.state.latest, undefined);
  f.cfg.agent.dryRun = false;
  f.setTime('2026-10-29T09:10:00+08:00');
  f.bot.send = async () => null;
  await f.scheduler.tick();
  assert.equal(f.scheduler.state.latest, undefined);
  f.setTime('2026-10-30T09:00:00+08:00');
  f.bot.send = async (...args) => { f.sent.push(args); return 44; };
  await f.scheduler.tick();
  f.cfg.agent.targets.push('group:99');
  f.setTime('2026-10-31T09:00:00+08:00');
  const result = await f.scheduler.tick();
  assert.equal(result.results[0].status, 'unchanged');
  assert.equal(result.results[1].scope, 'group:99');
  assert.equal(result.results[1].status, 'sent');
  assert.equal(f.sent.length, 2);
});

test('editing a source time during fetch stops stale send', async (t) => {
  const f = fixture(t, { sources: ['epic'], sourceTimes: { epic: '09:00' } });
  f.scheduler.fetchNews = async (_, { date }) => {
    f.cfg.dailyNews.sourceTimes.epic = '18:00';
    return { text: 'offer', sourceDate: date };
  };
  await f.scheduler.tick();
  assert.equal(f.sent.length, 0);
});

test('legacy receipts migrate without repeat and source failures do not block others', async (t) => {
  const f = fixture(t, { sources: NEWS_SOURCES, sourceTimes: NEWS_SOURCE_TIMES });
  fs.writeFileSync(f.scheduler.file, JSON.stringify({ receipts: { '2026-10-29/group:11/60s': { status: 'sent' } } }));
  f.setTime('2026-10-29T10:00:00+08:00');
  const s = new DailyNewsScheduler({ ...f.options, fetchNews: async (kind, { date }) => {
    f.fetched.push(kind);
    if (kind === 'ai') throw new Error('not updated');
    return { sourceDate: date, text: kind };
  } });
  assert.equal((await s.tick()).ok, false);
  assert.equal(f.fetched.includes('60s'), false);
  assert.equal(f.sent.length, 3);
  assert.equal((await s.tick()).reason, 'retry-wait');
  f.setTime('2026-10-29T10:10:00+08:00');
  await s.tick();
  assert.equal(f.sent.length, 3);
});

test('invalid message acknowledgements never create a sent fingerprint', async (t) => {
  for (const id of ['', false, {}, [], 0, NaN, '0', ' 12', 'not-an-id']) {
    const f = fixture(t, { sources: ['60s'] });
    f.bot.send = async () => id;
    assert.equal((await f.scheduler.tick()).results[0].status, 'uncertain');
    assert.equal(f.scheduler.state.latest, undefined);
  }
  const f = fixture(t, { sources: ['60s'] });
  f.bot.send = async () => '-123';
  assert.equal((await f.scheduler.tick()).results[0].status, 'sent');
});

test('expanded sources use safe evening defaults without a sourceTimes map', async (t) => {
  const f = fixture(t, { sources: NEWS_SOURCES, time: '10:00' });
  f.setTime('2026-10-29T10:00:00+08:00');
  await f.scheduler.tick();
  assert.equal(f.sent.length, 5);
  f.setTime('2026-10-29T18:00:00+08:00');
  await f.scheduler.tick();
  assert.equal(f.sent.length, 12);
});

test('catalog rejects unknown source without network', async () => {
  await assert.rejects(fetchScheduledNews('not-a-source'), /unsupported/);
});
