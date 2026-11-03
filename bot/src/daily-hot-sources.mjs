// Read-only public sources, Node 22 built-ins only. No QQ transport or credentials.
// Verified 2026-10-28 against vikiboss/60s src/modules/{it-news,weibo,douyin,rednote}.module.ts.
// Rankings have no publication date. Douyin event_time is a topic's time, NOT a news date;
// its event_time_at is upstream seconds (despite its name), so neither is used for freshness.
// Gold deliberately bypasses /v2/gold-price: that module manufactures updated/date from
// the fetch clock instead of reading the original table's explicit quotation date.
import { createHash } from 'node:crypto';

const BASES = ['https://60s.viki.moe', 'https://60s.b23.run'];
const GOLD_URLS = ['http://www.huangjinjiage.cn/jinrijinjia.html', 'http://huangjinjiage.cn/jinrijinjia.html'];
const BILI_URLS = [
  'https://api.bilibili.com/x/web-interface/wbi/search/square?limit=50',
  'https://app.bilibili.com/x/v2/search/trending/ranking?limit=50',
];
const RANKS = {
  'ithome-rank': { path: '/v2/it-news/rank?type=day', name: 'IT之家日榜', source: 'https://www.ithome.com/', search: false },
  weibo: { path: '/v2/weibo', name: '微博热搜', source: 'https://s.weibo.com/top/summary', search: true },
  douyin: { path: '/v2/douyin', name: '抖音热搜', source: 'https://www.douyin.com/hot', search: true },
  rednote: { path: '/v2/rednote', name: '小红书热点', source: 'https://www.xiaohongshu.com/', search: true },
};
const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const string = value => typeof value === 'string' ? value.trim() : '';

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function requestedDate(value) {
  const date = value === undefined ? shanghai.format(new Date())
    : value instanceof Date && Number.isFinite(value.getTime()) ? shanghai.format(value) : value;
  if (!validDate(date)) throw new TypeError('date must be a valid YYYY-MM-DD date');
  return date;
}

function httpUrl(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : '';
  } catch { return ''; }
}

function fingerprint(kind, rows) {
  // Sorting and de-duplicating ignores rank-only moves and mirror order differences.
  // No fetch dates, upstream timestamps, heat scores, or rendered headings are included.
  const canonical = [...new Set(rows.map(row => JSON.stringify(row)))].sort();
  return `${kind}:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function formatResult(kind, title, date, sourceUrl, note, blocks, content) {
  if (!blocks.length) throw new Error('no valid source items');
  const header = `${title}\n\n${note}\n\n`;
  const footer = `\n\n来源：${sourceUrl}`;
  const selected = [];
  for (const block of blocks) {
    const marker = `\n（仅列出前 ${selected.length + 1} 条，完整内容见来源）`;
    if (`${header}${[...selected, block].join('\n\n')}${marker}${footer}`.length > 3500) break;
    selected.push(block);
  }
  if (!selected.length) throw new Error('source headline/link exceeds message length limit');
  const marker = selected.length < blocks.length
    ? `\n（仅列出前 ${selected.length} 条，完整内容见来源）` : '';
  return {
    title, text: `${header}${selected.join('\n\n')}${marker}${footer}`,
    sourceDate: date, sourceUrl, dedupeKey: fingerprint(kind, content),
  };
}

function parseRank(kind, data, date) {
  if (!Array.isArray(data)) throw new Error('invalid hot ranking data: expected array');
  const config = kind === 'bili'
    ? { name: 'B站热搜', source: 'https://search.bilibili.com/', search: true } : RANKS[kind];
  const seen = new Set();
  const items = data.filter(item => {
    if (!item || !string(item.title) || !httpUrl(item.link)) return false;
    const key = JSON.stringify([string(item.title), item.link]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const blocks = items.map((item, i) => `${i + 1}. ${string(item.title)}\n${item.link}`);
  const note = '实时榜单快照，不代表条目发布于抓取当天。'
    + (config.search ? '链接为对应话题的站内搜索，不是新闻原文。' : '日榜为当前榜单，不是按新闻发布日期筛选。');
  return formatResult(kind, `${config.name}（抓取于 ${date}）`, date, config.source,
    note, blocks, items.map(item => [string(item.title), item.link]));
}

function parseBili(json, date, index) {
  if (json?.code !== 0) throw new Error(`invalid Bilibili envelope (code ${json?.code ?? 'none'})`);
  const list = index === 0 ? json.data?.trending?.list : json.data?.list;
  if (!Array.isArray(list)) throw new Error('invalid Bilibili trending list');
  // Official endpoints return search keywords, not articles. Construct only the official
  // documented search target (also used by /v2/bili), and label it explicitly in the text.
  const items = list.filter(item => item && (index === 0 || String(item.is_commercial) === '0'))
    .map(item => ({
      title: string(item.keyword) || string(item.show_name),
      link: string(item.keyword)
        ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(string(item.keyword))}` : '',
    }));
  return parseRank('bili', items, date);
}

function htmlText(value) {
  return value.replace(/<[^>]*>/gu, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (match, entity) => {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const code = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }).trim();
}

function quotationDate(text) {
  const match = /(\d{4})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(\d{1,2})日?/u.exec(text);
  if (!match) return '';
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return validDate(date) ? date : '';
}

function parseGold(html, date) {
  const clean = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, '');
  const section = /<h2\b[^>]*>\s*各大金店今日金价\s*<\/h2\s*>[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table\s*>/iu.exec(clean)?.[1];
  if (!section) throw new Error('gold source table unavailable');
  const rows = [];
  for (const match of section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/giu)].map(cell => htmlText(cell[1]));
    if (cells.length < 4) continue;
    const quoteDate = quotationDate(cells.at(-1));
    const price = /^(\d+(?:\.\d+)?)\s*元\/克$/u.exec(cells[2]);
    // Missing/invalid/future dates and placeholder prices are not verifiable quotations.
    if (!quoteDate || quoteDate > date || !price || Number(price[1]) <= 0 || !cells[0] || !cells[1]) continue;
    rows.push({ brand: cells[0], product: cells[1], price: price[1], quoteDate });
  }
  const blocks = rows.map((row, i) => `${i + 1}. ${row.brand} · ${row.product}：${row.price} 元/克\n原站报价日：${row.quoteDate}${row.quoteDate < date ? '（最近可得报价，非抓取日新报价）' : ''}`);
  const note = '金店零售参考报价，非交易所实时行情、非投资建议；抓取日不等于报价日。'
    + '休市或未更新时仅列原站明确日期的最近报价，不将旧报价冒充今日行情。';
  return formatResult('gold', `黄金价格参考（抓取于 ${date}）`, date, GOLD_URLS[0], note,
    blocks, rows.map(row => [row.brand, row.product, row.price, '元/克']));
}

async function request(url, fetchImpl, timeoutMs, decode) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('source request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, {
        method: 'GET', signal: controller.signal,
        headers: { Accept: 'application/json, text/html;q=0.9', 'User-Agent': 'Mozilla/5.0 QQ-Daily-News/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await decode(response);
    })()]);
  } finally { clearTimeout(timer); }
}

/**
 * Fetch a public ranking/quotation snapshot. sourceDate is the caller's Shanghai fetch
 * date, NOT a publication/quotation date. Gold's original quotation dates appear in text.
 * Returns {title, text (<=3500), sourceDate, sourceUrl, dedupeKey}; failures are retryable
 * DAILY_NEWS_UNAVAILABLE errors. timeoutMs bounds both attempts including body decoding.
 */
export async function fetchHotNews(kind, { date, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!Object.hasOwn(RANKS, kind) && !['gold', 'bili'].includes(kind)) throw new TypeError(`unsupported hot news kind: ${kind}`);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  const target = requestedDate(date);
  const urls = kind === 'gold' ? GOLD_URLS : kind === 'bili' ? BILI_URLS : BASES.map(base => `${base}${RANKS[kind].path}`);
  const failures = [];
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; i < urls.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await request(urls[i], fetchImpl, Math.max(1, Math.floor(remaining / (urls.length - i))), async response => {
        if (kind === 'gold') {
          // Original site advertises GB2312; gb18030 is its backwards-compatible decoder.
          const html = new TextDecoder('gb18030').decode(await response.arrayBuffer());
          return parseGold(html, target);
        }
        const json = await response.json();
        if (kind === 'bili') return parseBili(json, target, i);
        if (!json || json.code !== 200 || json.data === undefined || json.data === null) {
          throw new Error(`invalid API envelope (code ${json?.code ?? 'none'})`);
        }
        return parseRank(kind, json.data, target);
      });
    } catch (error) { failures.push(`${urls[i]}: ${error.message}`); }
  }
  const error = new Error(`${kind} news unavailable for ${target}: ${failures.join('; ') || 'timeout'}`);
  error.code = 'DAILY_NEWS_UNAVAILABLE';
  throw error;
}
