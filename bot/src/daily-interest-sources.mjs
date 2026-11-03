// Public, read-only interest sources. Node 22; no QQ transport or external packages.
// Schemas: github.com/vikiboss/60s/src/modules/epic.module.ts,
// github.com/bangumi/api/open-api/api.yml, https://rawg.io/apidocs.
import { createHash } from 'node:crypto';

const EPIC_BASES = ['https://60s.viki.moe', 'https://60s.b23.run'];
const BANGUMI_URL = 'https://api.bgm.tv/calendar';
const BILIBILI_URL = 'https://api.bilibili.com/pgc/web/timeline?types=1&before=0&after=6';
const RAWG_URL = 'https://api.rawg.io/api/games';
const STEAMCHINA_URL = 'https://store.steamchina.com/search/results/?start=0&count=50&filter=comingsoon&infinite=1&json=1&l=schinese&cc=cn';
const MAX_TEXT = 3500;
const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const wallTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const string = value => typeof value === 'string' ? value.trim() : '';
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function requestedDate(value) {
  const result = value === undefined ? shanghai.format(new Date())
    : value instanceof Date && Number.isFinite(value.getTime()) ? shanghai.format(value) : value;
  if (!validDate(result)) throw new TypeError('date must be a valid YYYY-MM-DD date');
  return result;
}
function httpUrl(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : '';
  } catch { return ''; }
}
function fingerprint(kind, identities) {
  return `${kind}:${createHash('sha256').update(JSON.stringify(identities.toSorted())).digest('hex')}`;
}
function result(title, date, sourceUrl, entries, kind, note = '') {
  if (!entries.length) throw new Error('no valid source items');
  const blocks = [];
  const header = `${title}\n${note ? `\n${note}\n` : ''}`;
  const footer = `\n\n来源：${sourceUrl}`;
  for (const entry of entries) {
    const block = `${blocks.length + 1}. ${entry.text}`;
    const omitted = `\n（仅列出前 ${blocks.length + 1} 条，完整内容见来源）`;
    if (`${header}\n${[...blocks, block].join('\n\n')}${omitted}${footer}`.length > MAX_TEXT) break;
    blocks.push(block);
  }
  if (!blocks.length) throw new Error('source headline/link exceeds message length limit');
  const omitted = blocks.length < entries.length
    ? `\n（仅列出前 ${blocks.length} 条，完整内容见来源）` : '';
  return {
    title, text: `${header}\n${blocks.join('\n\n')}${omitted}${footer}`,
    sourceDate: date, sourceUrl, dedupeKey: fingerprint(kind, entries.map(entry => entry.identity)),
  };
}

export class MissingSourceConfigError extends Error {
  constructor(kind, configKey) {
    super(`${kind} source requires ${configKey}; no verified keyless upcoming-release alternative is configured`);
    this.name = 'MissingSourceConfigError';
    this.code = 'SOURCE_CONFIG_MISSING';
    this.kind = kind;
    this.configKey = configKey;
  }
}

async function requestJson(url, fetchImpl, timeoutMs) {
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
        method: 'GET', signal: controller.signal, redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'SnowLuma/qq-daily-news/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })()]);
  } finally { clearTimeout(timer); }
}

function epic(data, date) {
  if (!data || data.code !== 200 || !Array.isArray(data.data)) throw new Error('invalid Epic API envelope');
  // A requested snapshot date does not prove availability. Require both the actual
  // current instant and provider's zero-price flag; never advertise expired/future offers.
  const now = Date.now();
  const offers = data.data.filter(item => item && string(item.title) && httpUrl(item.link)
    && item.is_free_now === true && typeof item.free_start_at === 'number'
    && typeof item.free_end_at === 'number' && Number.isFinite(item.free_start_at)
    && Number.isFinite(item.free_end_at) && item.free_start_at <= now && now < item.free_end_at
    && shanghai.format(new Date(item.free_start_at)) <= date
    && shanghai.format(new Date(item.free_end_at)) >= date);
  const entries = new Map();
  for (const item of offers) {
    // ID/link + actual offer window, never snapshot date/title or payload ordering.
    const identity = JSON.stringify([string(item.id) || item.link, item.free_start_at, item.free_end_at]);
    entries.set(identity, {
      identity, text: `${string(item.title)}\n当前可领取 · 截止 ${wallTime.format(new Date(item.free_end_at))}（上海时间）\n${item.link}`,
    });
  }
  return result(`Epic 免费游戏（${date}）`, date, 'https://store.epicgames.com/free-games', [...entries.values()], 'epic');
}

function bangumi(data, date) {
  if (!Array.isArray(data)) throw new Error('invalid Bangumi calendar: expected array');
  // date was already converted to Shanghai, so UTC weekday of the calendar date is correct.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const day = data.find(item => item?.weekday?.id === weekday);
  if (!day || !Array.isArray(day.items)) throw new Error('missing Bangumi weekday items');
  const entries = new Map();
  for (const item of day.items) {
    if (!item || !Number.isSafeInteger(item.id) || item.id <= 0 || !string(item.name) || !httpUrl(item.url)) continue;
    // air_date is SERIES PREMIERE, not today's episode date. Do not relabel it.
    if (validDate(item.air_date) && item.air_date > date) continue;
    const identity = JSON.stringify([item.id, item.url, validDate(item.air_date) ? item.air_date : '']);
    entries.set(identity, { identity, text: `${string(item.name)}\n${item.url}` });
  }
  return result(`Bangumi 放送表（${date} · 星期${'一二三四五六日'[weekday - 1]}）`, date,
    'https://bgm.tv/calendar', [...entries.values()], 'bangumi',
    '按上海日期选取星期；当前周表，不代表逐集更新确认或历史日期存档。');
}

function bilibili(data, date) {
  if (!data || data.code !== 0 || !Array.isArray(data.result)) throw new Error('invalid Bilibili timeline envelope');
  const timestampDate = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    const instant = new Date(value * 1000);
    return Number.isFinite(instant.getTime()) ? shanghai.format(instant) : '';
  };
  // Never infer the year from the display field `date` (e.g. 10-28).
  const day = data.result.find(item => timestampDate(item?.date_ts) === date);
  if (!day || !Array.isArray(day.episodes)) throw new Error('missing Bilibili requested-date episodes');
  const entries = new Map();
  for (const item of day.episodes) {
    if (!item || !Number.isSafeInteger(item.episode_id) || item.episode_id <= 0
      || !string(item.title) || !string(item.pub_index) || timestampDate(item.pub_ts) !== date) continue;
    const link = `https://www.bilibili.com/bangumi/play/ep${item.episode_id}`;
    const status = item.delay ? '已延期，以平台后续公告为准'
      : item.published === 1 ? '平台标记已发布' : '计划更新，尚未确认已发布';
    const identity = JSON.stringify(['bilibili', item.episode_id, item.pub_ts, string(item.pub_index), Boolean(item.delay)]);
    entries.set(identity, { identity,
      text: `${string(item.title)}\n${string(item.pub_index)} · ${wallTime.format(new Date(item.pub_ts * 1000))}（上海时间）\n${status}\n${link}` });
  }
  return result(`B站番剧放送计划（${date}）`, date, 'https://www.bilibili.com/anime/timeline',
    [...entries.values()], 'bangumi', 'Bangumi 不可用，改用B站官方备源；仅覆盖B站番剧，不等同全部平台放送表。');
}

function games(data, date, endDate) {
  if (!data || !Array.isArray(data.results)) throw new Error('invalid RAWG results');
  const entries = new Map();
  const current = data.results.filter(item => item && Number.isSafeInteger(item.id) && item.id > 0
    && string(item.name) && /^[a-zA-Z0-9_-]+$/.test(string(item.slug))
    && item.tba !== true && validDate(item.released) && item.released >= date && item.released <= endDate)
    .sort((a, b) => a.released.localeCompare(b.released) || a.id - b.id);
  for (const item of current) {
    const link = `https://rawg.io/games/${item.slug}`;
    const identity = JSON.stringify([item.id, item.released, link]);
    entries.set(identity, { identity, text: `${string(item.name)}\n计划发售：${item.released}\n${link}` });
  }
  return result(`游戏近期发售（${date} 至 ${endDate} · RAWG）`, date, 'https://rawg.io/',
    [...entries.values()], 'games', 'RAWG 跨平台聚合条目，非全部平台完整清单；发售日期可能调整。');
}

function steamChina(data, date) {
  if (!data || data.success !== 1 || typeof data.results_html !== 'string') throw new Error('invalid Steam China search results');
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 6);
  const endDate = end.toISOString().slice(0, 10);
  // Decode text only; no HTML is executed, and links are confined to the official origin.
  const plainText = html => html.replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code) => {
    const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
  }).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  const entries = new Map();
  for (const match of data.results_html.matchAll(/<a\b([^>]*\bclass="[^"]*\bsearch_result_row\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1];
    const body = match[2];
    const id = attributes.match(/\bdata-ds-appid="(\d+)"/)?.[1];
    const href = attributes.match(/\bhref="([^"]+)"/)?.[1];
    const title = body.match(/<span\b[^>]*\bclass="title"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const release = plainText(body.match(/<div\b[^>]*\bclass="search_released[^\"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
    const parts = release.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/);
    if (!id || !href || !title || !parts || !httpUrl(href)) continue;
    const url = new URL(href);
    if (url.origin !== 'https://store.steamchina.com' || !url.pathname.startsWith(`/app/${id}/`)) continue;
    const releaseDate = `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
    if (!validDate(releaseDate) || releaseDate <= date || releaseDate > endDate) continue;
    const name = plainText(title);
    if (!name) continue;
    const identity = JSON.stringify(['steamchina', id, releaseDate]);
    entries.set(identity, { identity, releaseDate, text: `${name}\n计划发售：${releaseDate}\n${href}` });
  }
  const ordered = [...entries.values()].sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.identity.localeCompare(b.identity));
  return result(`即将发售游戏·蒸汽平台PC（中国区）（${date}）`, date,
    'https://store.steamchina.com/search/?filter=comingsoon', ordered, 'games',
    `免密官方备源，仅覆盖蒸汽平台中国区PC；列出至 ${endDate} 的明确日期，不等同Steam全球或全平台完整清单。`);
}

/** Original titles/links only. Date is the Shanghai snapshot date, not publication proof. */
export async function fetchInterestNews(kind, { date, fetchImpl = fetch, timeoutMs = 15000, apiKey } = {}) {
  if (!['epic', 'bangumi', 'games'].includes(kind)) throw new TypeError(`unsupported interest news kind: ${kind}`);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  const target = requestedDate(date);
  const endDate = new Date(Date.parse(`${target}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  const rawg = new URL(RAWG_URL);
  if (kind === 'games') {
    rawg.search = new URLSearchParams({ key: string(apiKey), dates: `${target},${endDate}`, ordering: 'released', page_size: '40' }).toString();
  }
  const urls = kind === 'epic' ? EPIC_BASES.map(base => `${base}/v2/epic`)
    : kind === 'bangumi' ? [BANGUMI_URL, BILIBILI_URL]
      : string(apiKey) ? [rawg.href, STEAMCHINA_URL] : [STEAMCHINA_URL];
  const deadline = Date.now() + timeoutMs;
  const failures = [];
  for (let i = 0; i < urls.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const data = await requestJson(urls[i], fetchImpl, Math.max(1, Math.floor(remaining / (urls.length - i))));
      if (kind === 'epic') return epic(data, target);
      if (kind === 'bangumi') return urls[i] === BANGUMI_URL ? bangumi(data, target) : bilibili(data, target);
      return urls[i] === STEAMCHINA_URL ? steamChina(data, target) : games(data, target, endDate);
    } catch (error) {
      // Injected fetch implementations and network errors may include the request URL/key.
      let message = error instanceof Error ? error.message : 'source request failed';
      if (kind === 'games') {
        const formEncodedKey = new URLSearchParams({ key: string(apiKey) }).toString().slice(4);
        for (const secret of [formEncodedKey, encodeURIComponent(string(apiKey)), string(apiKey)]) {
          if (secret) message = message.replaceAll(secret, '[redacted]');
        }
      }
      failures.push(`${new URL(urls[i]).origin}: ${message}`);
    }
  }
  const error = new Error(`${kind} news unavailable for ${target}: ${failures.join('; ') || 'timeout'}`);
  error.code = 'DAILY_NEWS_UNAVAILABLE';
  error.kind = kind;
  throw error;
}
