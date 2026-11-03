// Public read-only sources; no QQ transport, LLM, credentials, or paid API.
// Reference: https://github.com/vikiboss/60s (src/modules/{60s,ai-news,it-news}.module.ts).
// AI's default API date is YESTERDAY; always request and validate an explicit date.
const BASES = ['https://60s.viki.moe', 'https://60s.b23.run'];
const MAX_TEXT = 3500;
const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function requestedDate(value) {
  const result = value === undefined ? shanghai.format(new Date())
    : value instanceof Date ? shanghai.format(value) : value;
  if (!validDate(result)) throw new TypeError('date must be a valid YYYY-MM-DD date');
  return result;
}

function string(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function httpUrl(value) {
  if (typeof value !== 'string' || /[\r\n\s]/u.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : '';
  } catch { return ''; }
}

function itemDate(item) {
  // created_at is milliseconds since epoch; created is a Shanghai wall-clock string.
  if (typeof item.created_at === 'number' && Number.isFinite(item.created_at)) {
    const timestamp = new Date(item.created_at);
    return Number.isFinite(timestamp.getTime()) ? shanghai.format(timestamp) : '';
  }
  const date = string(item.created).slice(0, 10).replaceAll('/', '-');
  return validDate(date) ? date : '';
}

function formatResult(title, sourceDate, sourceUrl, blocks, total = blocks.length) {
  if (!blocks.length) throw new Error('no valid items for requested source date');
  const footer = `\n\n来源：${sourceUrl}`;
  const selected = [];
  for (const block of blocks) {
    // Leave room for an accurate omitted-items marker, never cut a title or link in half.
    const omitted = `\n（仅列出前 ${selected.length + 1} 条，完整内容见来源）`;
    if (`${title}\n\n${[...selected, block].join('\n\n')}${omitted}${footer}`.length > MAX_TEXT) break;
    selected.push(block);
  }
  if (!selected.length) throw new Error('source headline/link exceeds message length limit');
  const omitted = selected.length < total
    ? `\n（仅列出前 ${selected.length} 条，完整内容见来源）` : '';
  return { title, text: `${title}\n\n${selected.join('\n\n')}${omitted}${footer}`, sourceDate, sourceUrl };
}

function parseNews(kind, data, date, apiUrl) {
  if (kind === 'ithome') {
    if (!Array.isArray(data)) throw new Error('invalid IT news data: expected array');
    const current = data.filter(item => item && itemDate(item) === date
      && string(item.title) && httpUrl(item.link));
    const blocks = current.slice(0, 8).map((item, i) => `${i + 1}. ${string(item.title)}\n${item.link}`);
    return formatResult(`IT之家资讯（${date}）`, date, 'https://www.ithome.com/', blocks, current.length);
  }
  if (!data || data.date !== date) {
    throw new Error(`stale or missing source date: expected ${date}, got ${string(data?.date) || 'none'}`);
  }
  if (!Array.isArray(data.news)) throw new Error('invalid news data: expected news array');
  if (kind === 'ai') {
    // Check item dates too: a caller-supplied date can be echoed by the upstream API.
    const current = data.news.filter(item => item && item.date === date
      && string(item.title) && httpUrl(item.link));
    const blocks = current.slice(0, 8).map((item, i) => `${i + 1}. ${string(item.title)}\n${item.link}`);
    return formatResult(`AI日报（${date} · AI工具集）`, date, 'https://ai-bot.cn/daily-ai-news/', blocks, current.length);
  }
  const blocks = data.news.map((item, i) => {
    if (typeof item === 'string' && string(item)) return `${i + 1}. ${string(item)}`;
    if (item && string(item.title) && httpUrl(item.link)) return `${i + 1}. ${string(item.title)}\n${item.link}`;
    throw new Error('invalid 60s news item');
  });
  return formatResult(`60秒认识世界（${date}）`, date, httpUrl(data.link) || apiUrl, blocks);
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
        method: 'GET', signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'QQ-Daily-News/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (!json || json.code !== 200 || json.data === undefined || json.data === null) {
        throw new Error(`invalid API envelope (code ${json?.code ?? 'none'})`);
      }
      return json.data;
    })()]);
  } finally { clearTimeout(timer); }
}

/** Fetch original headlines and links for a Shanghai calendar date. Never silently substitutes yesterday. */
export async function fetchDailyNews(kind, { date, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!['ithome', 'ai', '60s'].includes(kind)) throw new TypeError(`unsupported daily news kind: ${kind}`);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  const target = requestedDate(date);
  const path = kind === 'ithome' ? '/v2/it-news?limit=50'
    : `/v2/${kind === 'ai' ? 'ai-news' : '60s'}?date=${target}`;
  const failures = [];
  // The supplied timeout is an overall wall-clock budget; reserve half for a public backup.
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; i < BASES.length; i++) {
    const url = `${BASES[i]}${path}`;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const data = await requestJson(url, fetchImpl, Math.max(1, Math.floor(remaining / (BASES.length - i))));
      return parseNews(kind, data, target, url);
    } catch (error) { failures.push(`${BASES[i]}: ${error.message}`); }
  }
  const error = new Error(`${kind} news unavailable for ${target}: ${failures.join('; ') || 'timeout'}`);
  error.code = 'DAILY_NEWS_UNAVAILABLE';
  throw error;
}
