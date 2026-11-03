import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInterestNews } from '../src/daily-interest-sources.mjs';

const date = '2026-10-28'; // Wednesday in Shanghai.
const response = data => ({ ok: true, status: 200, json: async () => data });
const offer = {
  id: 'offer-1', title: 'Original Epic Title', link: 'https://store.epicgames.com/p/original',
  is_free_now: true, free_start_at: Date.parse('2020-01-01T00:00:00Z'), free_end_at: Date.parse('2099-01-01T00:00:00Z'),
};
const epic = items => ({ code: 200, data: items });
const subject = { id: 123, name: '原作タイトル', name_cn: '翻译名称', url: 'https://bgm.tv/subject/123', air_date: '2026-10-01' };
const calendar = items => [
  { weekday: { id: 2 }, items: [{ ...subject, name: 'Tuesday title' }] },
  { weekday: { id: 3 }, items },
  { weekday: { id: 7 }, items: [{ ...subject, name: 'Sunday title' }] },
];
const game = { id: 456, name: 'Original Game Title', slug: 'original-game', released: '2026-11-03', tba: false };

async function fetchMock(kind, data, options = {}) {
  return fetchInterestNews(kind, { date, fetchImpl: async () => response(data), ...options });
}

test('Epic retains original title/link and exact current offer dates in bounded result shape', async () => {
  const result = await fetchMock('epic', epic([offer]));
  assert.deepEqual(Object.keys(result).sort(), ['dedupeKey', 'sourceDate', 'sourceUrl', 'text', 'title']);
  assert.equal(result.sourceDate, date);
  assert.match(result.text, /Original Epic Title/);
  assert.ok(result.text.includes(offer.link));
  assert.match(result.text, /当前可领取/);
  assert.match(result.text, /2099-01-01 08:00/);
  assert.match(result.dedupeKey, /^epic:[a-f0-9]{64}$/);
});

test('Epic never presents expired, future-only, paid or invalid windows as current', async () => {
  const excluded = [
    { ...offer, id: 'expired', title: 'Expired', free_end_at: Date.now() - 1 },
    { ...offer, id: 'future', title: 'Future', free_start_at: Date.now() + 86400000 },
    { ...offer, id: 'paid', title: 'Paid', is_free_now: false },
    { ...offer, id: 'invalid', title: 'Invalid', free_end_at: NaN },
    { ...offer, id: 'unsafe', title: 'Unsafe', link: 'javascript:alert(1)' },
  ];
  const result = await fetchMock('epic', epic([offer, ...excluded]));
  for (const item of excluded) assert.ok(!result.text.includes(item.title));
  for (const item of excluded) {
    await assert.rejects(fetchMock('epic', epic([item])), { code: 'DAILY_NEWS_UNAVAILABLE' });
  }
});

test('Epic dedupe excludes snapshot/title/order and changes only actual offer identities/windows', async () => {
  const second = { ...offer, id: 'offer-2', title: 'Other' };
  const original = await fetchMock('epic', epic([offer, second]));
  const later = await fetchMock('epic', epic([{ ...second, title: 'Renamed' }, offer, offer]), { date: '2026-10-29' });
  assert.equal(original.dedupeKey, later.dedupeKey);
  const changed = await fetchMock('epic', epic([{ ...offer, free_end_at: offer.free_end_at + 1 }, second]));
  assert.notEqual(original.dedupeKey, changed.dedupeKey);
});

test('Epic fails over on HTTP, invalid JSON, envelope and stale offers to capped backup', async () => {
  for (const first of [
    () => ({ ok: false, status: 429 }),
    () => ({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } }),
    () => response({ code: 500, data: [offer] }),
    () => response(epic([{ ...offer, free_end_at: 1 }])),
  ]) {
    const calls = [];
    const result = await fetchInterestNews('epic', { date, fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      return calls.length === 1 ? first() : response(epic([offer]));
    } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'https://60s.viki.moe/v2/epic');
    assert.equal(calls[1], 'https://60s.b23.run/v2/epic');
    assert.equal(result.sourceDate, date);
  }
});

test('timeouts bound hung fetch and hung JSON while reserving Epic backup time', async () => {
  for (const hang of [
    () => new Promise(() => {}),
    () => ({ ok: true, json: () => new Promise(() => {}) }),
  ]) {
    let calls = 0;
    const start = Date.now();
    const result = await fetchInterestNews('epic', { date, timeoutMs: 80, fetchImpl: async () => ++calls === 1 ? hang() : response(epic([offer])) });
    assert.equal(calls, 2);
    assert.equal(result.sourceDate, date);
    assert.ok(Date.now() - start < 700);
  }
});

test('Bangumi selects Shanghai weekday and preserves original, not translated title', async () => {
  const result = await fetchMock('bangumi', calendar([subject]), { date: new Date('2026-10-27T16:30:00Z') });
  assert.equal(result.sourceDate, date);
  assert.match(result.title, /星期三/);
  assert.ok(result.text.includes(subject.name));
  assert.ok(result.text.includes(subject.url));
  assert.ok(!result.text.includes(subject.name_cn));
  assert.ok(!result.text.includes('Tuesday title'));
  assert.match(result.text, /不代表逐集更新确认/);
});

test('Bangumi Sunday uses weekday 7 and snapshot-independent repeated schedule dedupe', async () => {
  const sunday = await fetchMock('bangumi', calendar([subject]), { date: '2026-11-01' });
  assert.match(sunday.text, /Sunday title/);
  const first = await fetchMock('bangumi', calendar([subject]));
  const nextWeek = await fetchMock('bangumi', calendar([{ ...subject, name: 'Renamed' }]), { date: '2026-11-04' });
  assert.equal(first.dedupeKey, nextWeek.dedupeKey);
  const changed = await fetchMock('bangumi', calendar([{ ...subject, id: 124 }]));
  assert.notEqual(first.dedupeKey, changed.dedupeKey);
});

test('Bangumi excludes future premieres and unsafe/malformed item links', async () => {
  const result = await fetchMock('bangumi', calendar([
    subject,
    { ...subject, id: 124, name: 'Future', air_date: '2027-01-01' },
    { ...subject, id: 125, name: 'Unsafe', url: 'https://user:password@bgm.tv/subject/125' },
    { ...subject, id: 126, name: 'Control', url: 'https://bgm.tv/\nsubject/126' },
  ]));
  assert.ok(result.text.includes(subject.name));
  for (const title of ['Future', 'Unsafe', 'Control']) assert.ok(!result.text.includes(title));
  await assert.rejects(fetchMock('bangumi', {}), /invalid Bangumi calendar/);
  await assert.rejects(fetchMock('bangumi', []), /missing Bangumi weekday/);
  await assert.rejects(fetchMock('bangumi', calendar([])), /no valid source items/);
});

const steamRow = (id, title, release, origin = 'https://store.steamchina.com') => `<a href="${origin}/app/${id}/original/?snr=test" data-ds-appid="${id}" class="search_result_row ds_collapse_flag"><span class="title">${title}</span><div class="search_released responsive_secondrow">${release}</div></a>`;
const steam = rows => ({ success: 1, results_html: rows.join('\n') });

test('games without key uses verified official Steam China upcoming subset transparently', async () => {
  for (const apiKey of [undefined, '', '  ', 123]) {
    const result = await fetchInterestNews('games', { date, apiKey, fetchImpl: async url => {
      assert.equal(new URL(url).origin, 'https://store.steamchina.com');
      assert.equal(new URL(url).searchParams.get('filter'), 'comingsoon');
      return response(steam([steamRow(123, 'Original &amp; Game', '2026 年 12 月 1 日')]));
    } });
    assert.match(result.title, /蒸汽平台PC（中国区）/);
    assert.match(result.text, /不等同Steam全球或全平台/);
    assert.match(result.text, /Original & Game/);
    assert.match(result.text, /2026-12-01/);
    assert.ok(result.text.includes('https://store.steamchina.com/app/123/original/?snr=test'));
  }
});

test('RAWG requests exact near-future date range and labels actual coverage honestly', async () => {
  const result = await fetchInterestNews('games', { date, apiKey: 'private-key', fetchImpl: async url => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.rawg.io');
    assert.equal(parsed.pathname, '/api/games');
    assert.equal(parsed.searchParams.get('key'), 'private-key');
    assert.equal(parsed.searchParams.get('dates'), '2026-10-28,2026-11-27');
    assert.equal(parsed.searchParams.get('ordering'), 'released');
    return response({ results: [game] });
  } });
  assert.ok(result.text.includes(game.name));
  assert.ok(result.text.includes('https://rawg.io/games/original-game'));
  assert.match(result.text, /2026-11-03/);
  assert.match(result.text, /RAWG 跨平台聚合条目，非全部平台完整清单/);
  assert.ok(!result.text.includes('private-key'));
});

test('RAWG excludes past, distant, TBA, missing-year and invalid dates/slugs', async () => {
  const excluded = [
    { ...game, name: 'Past', released: '2026-10-27' },
    { ...game, name: 'Distant', released: '2027-11-03' },
    { ...game, name: 'Unknown', released: null },
    { ...game, name: 'Missing year', released: 'Nov 3' },
    { ...game, name: 'Invalid day', released: '2026-11-31' },
    { ...game, name: 'TBA', tba: true },
    { ...game, name: 'Unsafe', slug: '../foo?bar' },
  ];
  const result = await fetchMock('games', { results: [game, ...excluded] }, { apiKey: 'key' });
  for (const item of excluded) assert.ok(!result.text.includes(item.name));
  await assert.rejects(fetchMock('games', { results: excluded }, { apiKey: 'key' }), /no valid source items/);
});

test('RAWG handles cross-year date window without assuming or rewriting source year', async () => {
  const result = await fetchInterestNews('games', { date: '2026-12-25', apiKey: 'key', fetchImpl: async url => {
    assert.equal(new URL(url).searchParams.get('dates'), '2026-12-25,2027-01-24');
    return response({ results: [{ ...game, released: '2027-01-03' }] });
  } });
  assert.match(result.text, /2027-01-03/);
});

test('RAWG dedupe is stable across snapshots and title changes but tracks release changes', async () => {
  const first = await fetchMock('games', { results: [game] }, { apiKey: 'key' });
  const later = await fetchMock('games', { results: [{ ...game, name: 'Renamed' }] }, { date: '2026-10-29', apiKey: 'key' });
  assert.equal(first.dedupeKey, later.dedupeKey);
  const changed = await fetchMock('games', { results: [{ ...game, released: '2026-11-04' }] }, { apiKey: 'key' });
  assert.notEqual(first.dedupeKey, changed.dedupeKey);
});

test('RAWG failures do not leak credentials or retry indefinitely', async () => {
  let calls = 0;
  await assert.rejects(fetchInterestNews('games', { date, apiKey: 'secret/key', fetchImpl: async url => {
    calls++;
    throw new Error(`Failed ${url}; key secret/key`);
  } }), error => {
    assert.equal(error.code, 'DAILY_NEWS_UNAVAILABLE');
    assert.ok(!error.message.includes('secret/key'));
    assert.ok(!error.message.includes('secret%2Fkey'));
    assert.match(error.message, /redacted/);
    return true;
  });
  assert.equal(calls, 2);
  await assert.rejects(fetchInterestNews('games', { date, apiKey: 'secret key/+', fetchImpl: async url => {
    throw new Error(`Failed ${url}`);
  } }), error => {
    assert.ok(!error.message.includes('secret+key%2F%2B'));
    assert.ok(!error.message.includes('secret key/+'));
    return true;
  });
});

const episode = { episode_id: 123, season_id: 12, title: 'Original Episode Title', pub_index: '第8话', pub_ts: Date.parse('2026-10-28T02:00:00Z') / 1000, published: 0, delay: 0 };
const timeline = episodes => ({ code: 0, result: [{ date: '10-28', date_ts: Date.parse('2026-10-27T16:00:00Z') / 1000, episodes }] });
async function fetchBili(data, options = {}) {
  return fetchInterestNews('bangumi', { date, fetchImpl: async url => {
    if (url.startsWith('https://api.bgm.tv/')) throw new Error('Bangumi offline');
    assert.match(url, /^https:\/\/api\.bilibili\.com\/pgc\/web\/timeline/);
    return response(data);
  }, ...options });
}

test('Bilibili is a transparent official backup with exact date and unconfirmed schedule labeling', async () => {
  const result = await fetchBili(timeline([episode]));
  assert.match(result.title, /B站番剧放送计划/);
  assert.match(result.text, /仅覆盖B站番剧/);
  assert.match(result.text, /计划更新，尚未确认已发布/);
  assert.match(result.text, /Original Episode Title/);
  assert.ok(result.text.includes('https://www.bilibili.com/bangumi/play/ep123'));
  assert.equal(result.sourceDate, date);
  assert.ok(result.text.length <= 3500);
});

test('Bilibili validates full timestamp dates not month-day or today flags', async () => {
  await assert.rejects(fetchBili({ code: 0, result: [{ date: '10-28', is_today: 1, date_ts: Date.parse('2025-10-27T16:00:00Z') / 1000, episodes: [episode] }] }), /missing Bilibili requested-date/);
  await assert.rejects(fetchBili(timeline([{ ...episode, pub_ts: Date.parse('2026-10-29T02:00:00Z') / 1000 }])), /no valid source items/);
  await assert.rejects(fetchBili(timeline([{ ...episode, episode_id: 'javascript:bad' }])), /no valid source items/);
  await assert.rejects(fetchBili({ code: -1, result: [] }), /invalid Bilibili timeline/);
});

test('Bilibili episode dedupe excludes snapshot/header but includes episode index and actual timestamps', async () => {
  const original = await fetchBili(timeline([episode]));
  const renamed = await fetchBili(timeline([{ ...episode, title: 'Renamed' }]));
  assert.equal(original.dedupeKey, renamed.dedupeKey);
  const changed = await fetchBili(timeline([{ ...episode, pub_index: '第9话' }]));
  assert.notEqual(original.dedupeKey, changed.dedupeKey);
  const delayed = await fetchBili(timeline([{ ...episode, delay: 1 }]));
  assert.match(delayed.text, /已延期/);
  assert.notEqual(original.dedupeKey, delayed.dedupeKey);
});

test('Steam China excludes ambiguous, past, invalid and more-than-six-month dates', async () => {
  const rows = [
    steamRow(1, 'Good', '2026 年 12 月 1 日'),
    steamRow(2, 'Quarter', '2026 年第四季度'),
    steamRow(3, 'Year only', '2026 年'),
    steamRow(4, 'Missing year', '12 月 1 日'),
    steamRow(5, 'Invalid day', '2026 年 11 月 31 日'),
    steamRow(6, 'Past', '2026 年 10 月 27 日'),
    steamRow(7, 'Today', '2026 年 10 月 28 日'),
    steamRow(8, 'Too distant', '2027 年 5 月 1 日'),
    steamRow(9, 'Unsafe', '2026 年 12 月 1 日', 'https://evil.example'),
  ];
  const result = await fetchMock('games', steam(rows));
  assert.match(result.text, /Good/);
  for (const title of ['Quarter', 'Year only', 'Missing year', 'Invalid day', 'Past', 'Today', 'Too distant', 'Unsafe']) assert.ok(!result.text.includes(title));
  await assert.rejects(fetchMock('games', steam(rows.slice(1))), /no valid source items/);
});

test('Steam China dedupe is stable across snapshots and upstream title changes', async () => {
  const original = await fetchMock('games', steam([steamRow(123, 'Original', '2026 年 12 月 1 日')]));
  const later = await fetchMock('games', steam([steamRow(123, 'Renamed', '2026 年 12 月 1 日')]), { date: '2026-10-29' });
  assert.equal(original.dedupeKey, later.dedupeKey);
  const moved = await fetchMock('games', steam([steamRow(123, 'Original', '2026 年 12 月 2 日')]));
  assert.notEqual(original.dedupeKey, moved.dedupeKey);
});

test('RAWG failure reserves budget for Steam China fallback', async () => {
  let calls = 0;
  const result = await fetchInterestNews('games', { date, apiKey: 'key', timeoutMs: 80, fetchImpl: async url => {
    calls++;
    if (new URL(url).origin === 'https://api.rawg.io') return new Promise(() => {});
    return response(steam([steamRow(123, 'Backup Original', '2026 年 12 月 1 日')]));
  } });
  assert.equal(calls, 2);
  assert.match(result.text, /Backup Original/);
});

test('length cap retains whole original titles/links with omission marker', async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ ...subject, id: 100 + i, name: `Original ${i} ${'題'.repeat(180)}`, url: `https://bgm.tv/subject/${100 + i}` }));
  const result = await fetchMock('bangumi', calendar(items));
  assert.ok(result.text.length <= 3500);
  assert.ok(result.text.includes(items[0].name));
  assert.ok(result.text.includes(items[0].url));
  assert.match(result.text, /仅列出前/);
});

test('invalid input is rejected before fetching and oversized single title fails explicitly', async () => {
  const fetchImpl = async () => assert.fail('must not call network');
  for (const value of ['2026-02-30', 'bad', null, new Date(NaN)]) {
    await assert.rejects(fetchInterestNews('bangumi', { date: value, fetchImpl }), TypeError);
  }
  await assert.rejects(fetchInterestNews('unknown', { date, fetchImpl }), /unsupported/);
  await assert.rejects(fetchInterestNews('epic', { date, fetchImpl: null }), /must be a function/);
  await assert.rejects(fetchInterestNews('epic', { date, timeoutMs: 0, fetchImpl }), /positive/);
  await assert.rejects(fetchMock('bangumi', calendar([{ ...subject, name: '題'.repeat(4000) }])), /exceeds message length/);
});
