import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchHotNews } from '../src/daily-hot-sources.mjs';

const date = '2026-10-28';
const response = data => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) });
const item = { title: '原始标题 <不改写>', link: 'https://example.org/article?x=1&y=2' };
const rankKinds = ['ithome-rank', 'weibo', 'douyin', 'rednote'];
const numericEntities = text => [...text].map(char => char.codePointAt(0) > 127 ? `&#${char.codePointAt(0)};` : char).join('');
// ASCII fixtures encode Chinese using valid HTML numeric references: no test dependency
// needed to encode GB18030. The real upstream heading is GB2312, supplied as raw bytes.
const goldHeadingBytes = Buffer.from('b8f7b4f3bdf0b5eabdf1c8d5bdf0bcdb', 'hex');
function goldResponse(rows = [{ brand: '周大福', product: '黄金价格', price: '1202元/克', date }]) {
  const table = rows.map(row => `<tr><td>${numericEntities(row.brand)}</td><td>${numericEntities(row.product)}</td><td>${numericEntities(row.price)}</td><td>${row.date}</td></tr>`).join('');
  const html = Buffer.concat([Buffer.from('<h2>'), goldHeadingBytes, Buffer.from(`</h2><table><tbody>${table}</tbody></table>`)]);
  return { ok: true, status: 200, arrayBuffer: async () => html };
}
const biliResponse = (list, backup = false) => ({ ok: true, status: 200, json: async () => ({
  code: 0, data: backup ? { list } : { trending: { list } },
}) });

test('four public60s adapters preserve titles/links and label snapshot not publication date', async () => {
  const paths = ['/v2/it-news/rank?type=day', '/v2/weibo', '/v2/douyin', '/v2/rednote'];
  for (const [index, kind] of rankKinds.entries()) {
    const result = await fetchHotNews(kind, { date, fetchImpl: async (url, options) => {
      assert.equal(url, `https://60s.viki.moe${paths[index]}`);
      assert.equal(options.method, 'GET');
      assert.ok(options.signal instanceof AbortSignal);
      return response([item]);
    } });
    assert.deepEqual(Object.keys(result).sort(), ['dedupeKey', 'sourceDate', 'sourceUrl', 'text', 'title']);
    assert.equal(result.sourceDate, date);
    assert.match(result.title, /抓取于 2026-10-28/);
    assert.ok(result.text.includes(item.title));
    assert.ok(result.text.includes(item.link));
    assert.match(result.text, /不代表条目发布于抓取当天/);
    assert.ok(result.dedupeKey.startsWith(`${kind}:`));
    if (kind !== 'ithome-rank') assert.match(result.text, /站内搜索，不是新闻原文/);
  }
});

test('rank fingerprints ignore dates, timestamps, heat and order but react to titles/links', async () => {
  const other = { title: '另一标题', link: 'https://example.org/other' };
  for (const kind of rankKinds) {
    const first = await fetchHotNews(kind, { date, fetchImpl: async () => response([item, other]) });
    const next = await fetchHotNews(kind, { date: '2026-10-29', fetchImpl: async () => response([
      { ...other, hot_value: 98000, active_time: '2026-10-29 08:00:00', event_time_at: 123 },
      { ...item, hot_value: 1, score: '999w', rank: 2 }, item,
    ]) });
    assert.equal(first.dedupeKey, next.dedupeKey);
    const changed = await fetchHotNews(kind, { date, fetchImpl: async () => response([{ ...item, title: '已改变' }]) });
    assert.notEqual(first.dedupeKey, changed.dedupeKey);
  }
});

test('bad HTTP, JSON, envelope and empty/stale schema fail over to public backup', async () => {
  for (const bad of [
    () => ({ ok: false, status: 429 }),
    () => ({ ok: true, json: async () => { throw new SyntaxError('HTML not JSON'); } }),
    () => ({ ok: true, json: async () => ({ code: 500, data: [item] }) }),
    () => response([]),
    () => response({ news: [item] }),
  ]) {
    let calls = 0;
    const result = await fetchHotNews('weibo', { date, fetchImpl: async url => {
      if (++calls === 1) return bad();
      assert.equal(url, 'https://60s.b23.run/v2/weibo');
      return response([item]);
    } });
    assert.equal(calls, 2);
    assert.equal(result.sourceDate, date);
  }
});

test('all rank sources unavailable fail closed, no generated content', async () => {
  for (const kind of rankKinds) {
    let calls = 0;
    await assert.rejects(fetchHotNews(kind, { date, fetchImpl: async () => {
      calls++;
      throw new Error('offline');
    } }), error => error.code === 'DAILY_NEWS_UNAVAILABLE' && /offline/.test(error.message));
    assert.equal(calls, 2);
  }
});

test('unsafe links are omitted without creating article replacements', async () => {
  const unsafe = ['javascript:alert(1)', 'file:///tmp/x', 'https://user:pass@example.com/', 'https://example.org/\nmalicious'];
  for (const link of unsafe) await assert.rejects(fetchHotNews('douyin', {
    date, fetchImpl: async () => response([{ ...item, link }]),
  }), /no valid source items/);
});

test('message length <=3500 without cutting any original title/link', async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ ...item, title: `${i}:` + '原标题'.repeat(90) }));
  const result = await fetchHotNews('rednote', { date, fetchImpl: async () => response(items) });
  assert.ok(result.text.length <= 3500);
  assert.ok(result.text.includes(items[0].title));
  assert.ok(result.text.includes(item.link));
  assert.ok(!result.text.includes(items[29].title));
  assert.match(result.text, /仅列出前/);
  await assert.rejects(fetchHotNews('rednote', { date, fetchImpl: async () => response([{ ...item, title: '长'.repeat(4000) }]) }), /length limit/);
});

test('official Bilibili web keywords are explicitly search links, not invented articles', async () => {
  const result = await fetchHotNews('bili', { date, fetchImpl: async url => {
    assert.equal(url, 'https://api.bilibili.com/x/web-interface/wbi/search/square?limit=50');
    return biliResponse([{ keyword: 'B站 原词', show_name: '展示别名', heat_score: 555 }]);
  } });
  assert.ok(result.text.includes('B站 原词'));
  assert.ok(result.text.includes('https://search.bilibili.com/all?keyword=B%E7%AB%99%20%E5%8E%9F%E8%AF%8D'));
  assert.match(result.text, /站内搜索，不是新闻原文/);
});

test('official Bilibili app backup filters commercial entries and malformed data', async () => {
  let calls = 0;
  const result = await fetchHotNews('bili', { date, fetchImpl: async url => {
    if (++calls === 1) return { ok: false, status: 500 };
    assert.equal(url, 'https://app.bilibili.com/x/v2/search/trending/ranking?limit=50');
    return biliResponse([
      { keyword: '真实热词', is_commercial: '0' },
      { keyword: '广告热词', is_commercial: '1' },
      { show_name: '没有关键词不编链接', is_commercial: '0' },
    ], true);
  } });
  assert.match(result.text, /真实热词/);
  assert.doesNotMatch(result.text, /广告热词|没有关键词不编链接/);
  assert.equal(calls, 2);
  await assert.rejects(fetchHotNews('bili', { date, fetchImpl: async () => response([]) }), /invalid Bilibili envelope/);
});

test('gold decodes original GB2312 and preserves explicit quotation date and price', async () => {
  const result = await fetchHotNews('gold', { date, fetchImpl: async url => {
    assert.equal(url, 'http://www.huangjinjiage.cn/jinrijinjia.html');
    return goldResponse();
  } });
  assert.equal(result.sourceDate, date);
  assert.match(result.title, /抓取于 2026-10-28/);
  assert.match(result.text, /周大福 · 黄金价格：1202 元\/克/);
  assert.match(result.text, /原站报价日：2026-10-28/);
  assert.match(result.text, /非交易所实时行情/);
  assert.match(result.text, /抓取日不等于报价日/);
});

test('gold stale/weekend prices are explicitly dated and never called current prices', async () => {
  const rows = [{ brand: '周大福', product: '黄金价格', price: '1202元/克', date: '2026-10-23' }];
  const first = await fetchHotNews('gold', { date: '2026-10-24', fetchImpl: async () => goldResponse(rows) });
  assert.match(first.text, /原站报价日：2026-10-23（最近可得报价，非抓取日新报价）/);
  assert.equal(first.sourceDate, '2026-10-24');
  const next = await fetchHotNews('gold', { date: '2026-10-25', fetchImpl: async () => goldResponse([{ ...rows[0], date: '2026-10-24' }]) });
  assert.equal(first.dedupeKey, next.dedupeKey, 'unchanged price should not re-push on date-only changes');
  const changed = await fetchHotNews('gold', { date, fetchImpl: async () => goldResponse([{ ...rows[0], price: '1203元/克' }]) });
  assert.notEqual(changed.dedupeKey, first.dedupeKey);
});

test('gold missing/future/invalid quotation dates or placeholder prices fail closed', async () => {
  for (const overrides of [{ date: '' }, { date: '2026-10-29' }, { date: '2026-02-30' }, { price: '--' }, { price: '0元/克' }]) {
    await assert.rejects(fetchHotNews('gold', { date, fetchImpl: async () => goldResponse([
      { brand: '周大福', product: '黄金价格', price: '1202元/克', date, ...overrides },
    ]) }), { code: 'DAILY_NEWS_UNAVAILABLE' });
  }
});

test('gold original-site backup works but both entries unavailable fail for retry', async () => {
  let calls = 0;
  await fetchHotNews('gold', { date, fetchImpl: async url => {
    if (++calls === 1) throw new Error('primary down');
    assert.equal(url, 'http://huangjinjiage.cn/jinrijinjia.html');
    return goldResponse();
  } });
  assert.equal(calls, 2);
  await assert.rejects(fetchHotNews('gold', { date, fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('deadline includes hung main fetch and body parsing; backup gets reserved budget', async () => {
  for (const hang of [() => new Promise(() => {}), () => ({ ok: true, json: () => new Promise(() => {}) })]) {
    let calls = 0;
    let firstSignal;
    const start = Date.now();
    await fetchHotNews('weibo', { date, timeoutMs: 80, fetchImpl: async (url, options) => {
      if (++calls === 1) { firstSignal = options.signal; return hang(); }
      return response([item]);
    } });
    assert.equal(calls, 2);
    assert.equal(firstSignal.aborted, true);
    assert.ok(Date.now() - start < 500);
  }
});

test('all hung endpoints respect overall deadline and fail retryably', async () => {
  const start = Date.now();
  let calls = 0;
  await assert.rejects(fetchHotNews('weibo', { date, timeoutMs: 70, fetchImpl: async () => {
    calls++;
    return new Promise(() => {});
  } }), { code: 'DAILY_NEWS_UNAVAILABLE' });
  assert.equal(calls, 2);
  assert.ok(Date.now() - start < 500);
});

test('validates kind, dates, fetch and timeout before network access', async () => {
  const fetchImpl = async () => { throw new Error('network must not run'); };
  for (const bad of ['2026-02-30', '2026-10-2', 'nonsense', null, new Date(NaN)]) {
    await assert.rejects(fetchHotNews('weibo', { date: bad, fetchImpl }), TypeError);
  }
  for (const kind of ['unsupported', 'toString', '__proto__']) await assert.rejects(fetchHotNews(kind, { date, fetchImpl }), /unsupported/);
  for (const timeoutMs of [0, -1, NaN, Infinity]) await assert.rejects(fetchHotNews('weibo', { date, timeoutMs, fetchImpl }), /positive/);
  await assert.rejects(fetchHotNews('weibo', { date, fetchImpl: null }), /function/);
  const result = await fetchHotNews('weibo', { date: new Date('2026-10-27T16:01:00Z'), fetchImpl: async () => response([item]) });
  assert.equal(result.sourceDate, date);
});
