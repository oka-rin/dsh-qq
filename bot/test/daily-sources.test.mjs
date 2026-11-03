import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDailyNews } from '../src/daily-sources.mjs';

const date = '2026-10-28';
const response = data => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) });
const sixty = { date, news: ['原始新闻一', '原始新闻二'], link: 'https://mp.weixin.qq.com/s/original' };
const aiItem = { title: 'AI 原始标题', link: 'https://example.org/ai?x=1&y=2', date };
const itItem = { title: 'IT 原始标题', link: 'https://www.ithome.com/1/018/744.htm', created: `${date} 09:25:34` };

test('60s preserves headlines, explicit requested date, source and stable return shape', async () => {
  const urls = [];
  const result = await fetchDailyNews('60s', { date, fetchImpl: async url => { urls.push(url); return response(sixty); } });
  assert.deepEqual(Object.keys(result).sort(), ['sourceDate', 'sourceUrl', 'text', 'title']);
  assert.equal(result.sourceDate, date);
  assert.equal(result.sourceUrl, sixty.link);
  assert.match(result.text, /原始新闻一/);
  assert.match(result.text, /原始新闻二/);
  assert.match(urls[0], /\/v2\/60s\?date=2026-10-28$/);
});

test('rejects yesterday 60s even if fetched today', async () => {
  await assert.rejects(fetchDailyNews('60s', { date, fetchImpl: async () => response({ ...sixty, date: '2026-10-27', api_updated: date }) }), /stale or missing source date/);
});

test('AI requests today, preserves original title/link and labels actual source', async () => {
  const result = await fetchDailyNews('ai', { date, fetchImpl: async url => {
    assert.match(url, /ai-news\?date=2026-10-28$/);
    return response({ date, news: [aiItem] });
  } });
  assert.match(result.text, /AI 原始标题/);
  assert.ok(result.text.includes(aiItem.link));
  assert.match(result.title, /AI工具集/);
  assert.equal(result.sourceDate, date);
});

test('AI rejects empty current date, previous wrapper, and misleading item dates', async () => {
  for (const data of [
    { date, news: [] },
    { date: '2026-10-27', news: [aiItem] },
    { date, news: [{ ...aiItem, date: '2026-10-27' }] },
    { date, news: [{ title: 'missing date', link: aiItem.link }] },
  ]) await assert.rejects(fetchDailyNews('ai', { date, fetchImpl: async () => response(data) }), { code: 'DAILY_NEWS_UNAVAILABLE' });
});

test('IT filters to actual source date and uses Shanghai timestamp dates', async () => {
  const result = await fetchDailyNews('ithome', { date, fetchImpl: async () => response([
    { ...itItem, title: '昨日新闻', created: '2026-10-27 23:59:59' },
    { ...itItem, created: 'ignored', created_at: Date.parse('2026-10-27T16:01:00Z') },
    { ...itItem, title: '无日期新闻', created: '' },
  ]) });
  assert.ok(result.text.includes(itItem.title));
  assert.ok(!result.text.includes('昨日新闻'));
  assert.ok(!result.text.includes('无日期新闻'));
  assert.equal(result.sourceDate, date);
});

test('IT stale-only response throws rather than reporting it as today', async () => {
  await assert.rejects(fetchDailyNews('ithome', { date, fetchImpl: async () => response([{ ...itItem, created: '2026-10-27 09:00:00' }]) }), /no valid items/);
});

test('HTTP, JSON, bad envelope and stale data fail over to tested public backup', async () => {
  for (const failure of [
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('HTML not JSON'); } }),
    async () => ({ ok: true, json: async () => ({ code: 500, data: sixty }) }),
    async () => response({ ...sixty, date: '2026-10-27' }),
  ]) {
    let count = 0;
    const result = await fetchDailyNews('60s', { date, fetchImpl: async url => {
      if (++count === 1) return failure();
      assert.match(url, /^https:\/\/60s\.b23\.run\//);
      return response(sixty);
    } });
    assert.equal(count, 2);
    assert.equal(result.sourceDate, date);
  }
});

test('all unavailable sources throw for retry without external calls', async () => {
  await assert.rejects(fetchDailyNews('60s', { date, fetchImpl: async () => { throw new Error('offline'); } }), error => {
    assert.equal(error.code, 'DAILY_NEWS_UNAVAILABLE');
    assert.match(error.message, /offline/);
    return true;
  });
});

test('caps message length without cutting original headlines or links', async () => {
  const news = Array.from({ length: 30 }, (_, i) => ({ ...aiItem, title: `${i}:` + '原题'.repeat(140) }));
  const result = await fetchDailyNews('ai', { date, fetchImpl: async () => response({ date, news }) });
  assert.ok(result.text.length <= 3500);
  assert.ok(result.text.includes(news[0].title));
  assert.ok(result.text.includes(aiItem.link));
  assert.ok(!result.text.includes(news[8].title));
  assert.match(result.text, /仅列出前/);
});

test('60s includes all fifteen normal headlines', async () => {
  const news = Array.from({ length: 15 }, (_, i) => `原文新闻第${i + 1}条`);
  const result = await fetchDailyNews('60s', { date, fetchImpl: async () => response({ ...sixty, news }) });
  for (const headline of news) assert.ok(result.text.includes(headline));
  assert.ok(!result.text.includes('仅列出前'));
});

test('rejects unsafe article links without inventing replacements', async () => {
  await assert.rejects(fetchDailyNews('ai', { date, fetchImpl: async () => response({ date, news: [{ ...aiItem, link: 'javascript:alert(1)' }] }) }), /no valid items/);
});

test('timeout bounds hanging fetch implementations and tries backup', async () => {
  const start = Date.now();
  let calls = 0;
  const result = await fetchDailyNews('60s', { date, timeoutMs: 60, fetchImpl: async () => {
    if (++calls === 1) return new Promise(() => {});
    return response(sixty);
  } });
  assert.equal(calls, 2);
  assert.ok(Date.now() - start < 500);
  assert.equal(result.sourceDate, date);
});

test('validates dates and kind before network calls', async () => {
  const fetchImpl = async () => { throw new Error('must not call'); };
  for (const bad of ['2026-02-30', '2026-10-2', 'nonsense', null]) {
    await assert.rejects(fetchDailyNews('60s', { date: bad, fetchImpl }), TypeError);
  }
  await assert.rejects(fetchDailyNews('other', { date, fetchImpl }), /unsupported/);
  await assert.rejects(fetchDailyNews('60s', { date, fetchImpl, timeoutMs: 0 }), /positive/);
});
