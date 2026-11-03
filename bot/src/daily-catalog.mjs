import { fetchDailyNews } from './daily-sources.mjs';
import { fetchHotNews } from './daily-hot-sources.mjs';
import { fetchInterestNews } from './daily-interest-sources.mjs';

export const NEWS_SOURCE_TIMES = Object.freeze({
  '60s': '10:00', ai: '10:00', ithome: '10:00', 'ithome-rank': '10:00', gold: '10:00',
  epic: '18:00', bangumi: '18:00', games: '18:00',
  bili: '18:00', weibo: '18:00', douyin: '18:00', rednote: '18:00',
});
export const NEWS_SOURCES = Object.keys(NEWS_SOURCE_TIMES);

export async function fetchScheduledNews(kind, options = {}) {
  if (['60s', 'ai', 'ithome'].includes(kind)) return fetchDailyNews(kind, options);
  if (['ithome-rank', 'gold', 'bili', 'weibo', 'douyin', 'rednote'].includes(kind)) return fetchHotNews(kind, options);
  if (['epic', 'bangumi', 'games'].includes(kind)) return fetchInterestNews(kind, options);
  throw new TypeError(`unsupported scheduled news source: ${kind}`);
}
