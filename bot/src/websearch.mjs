/**
 * 被动回复时的「按需联网」。
 *
 * 用户的要求（m00041）：「根据情况，需要了解群友的梗或者问题才需要联网」——
 * 所以先过一道不花钱的门：这句话是不是在问事实 / 问现在 / 问一个不认识的梗；
 * 不是就一个字都不花、一秒都不加。是才让后台小模型判一次「值不值得查、查什么」，
 * 再用 sys/*.mjs 的 searchWeb（必应 RSS → 360 兜底）拿几条真链接塞进上下文。
 */
import { searchWeb, toutiaoHot, cleanUrl } from './sources.mjs';
import { truncate } from './util.mjs';

/** 在问（问句/疑问词） */
export const ASK_HINT = /[?？]|吗|呢|啥|什么|怎么|咋|为什么|为啥|哪|谁|多少|几点|几号|是不是|有没有|能不能|真的假的/;
/** 在问「现在/外面」的事（有时效性，模型自己的知识接不住） */
export const FRESH_HINT = /今天|今晚|昨天|最近|最新|现在|刚才|这会儿|新闻|热搜|头条|发布|发售|上市|开售|预售|价格|多少钱|降价|出了|出事|新版本|更新|比赛|比分|票房|汇率|天气/;
/** 在问一个梗 / 作品 / 人物的来历——这类「不懂就接不住」，最该查 */
export const UNKNOWN_HINT = /梗|出处|什么意思|啥意思|是谁|是啥|哪来的|什么来头|什么歌|什么番|什么游戏|什么电影|什么动画|原图|原型|哪个番|哪部|什么牌子|什么型号|叫什么名字|什么名字|叫啥名字/;

/**
 * 便宜门：明显不需要查的直接否掉，省掉一次模型调用。
 * 玩梗互怼、情绪、评价、问本人的事都不该触发联网。
 */
export function wantsLookup(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const bare = t.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
  if ([...bare].length < 4) return false;
  if (UNKNOWN_HINT.test(t)) return true;
  return ASK_HINT.test(t) && FRESH_HINT.test(t);
}

const ASK_NOISE = /(是什么梗|什么梗|是啥意思|啥意思|什么意思|是什么|什么|是啥|是谁|是哪|出处|哪来的|哪部|怎么样|怎么|为什么|为啥|有啥|有什么|多少|几点|几号|有没有|是不是|出了|吗|呢|吧|啊|的|了|梗|这个|那个|这是|那是|叫啥名字|叫什么名字|什么名字|什么番|哪部|哪个番)/g;

export function coreOf(query) {
  const raw = String(query || '').trim();
  // 先按空格/标点拆词，逐个洗掉问句成分，剩最长的那个才是主体
  const words = raw.split(/[\s,，。、?!！？]+/).map((w) => w.replace(ASK_NOISE, '')).filter(Boolean);
  const cleaned = raw.replace(ASK_NOISE, '').replace(/[\s,，。、?!！？]+/g, '');
  const pool = [...words, cleaned].filter((w) => [...w].length >= 2);
  const pick = pool.sort((a, b) => [...b].length - [...a].length)[0];
  // 实在抽不出主体词（「这个番叫啥名字」这种全靠上文的）就返回空，宁可这轮不搜
  return pick || '';
}

/** 字典/词典站：搜「这个」「哈」这类词时排前面的常客，对群聊没用 */
const JUNK_HOST = /(hanyuguoxue|zdic\.net|hanyu\.baidu|cidian|dict\.baidu|dict\.youdao|chazidian)/i;

/** 主体词命中：先看整词，再看二元组（「黑神话钟馗」也能认「黑神话：钟馗」） */
function matchesCore(hay, core) {
  if (!core) return true;
  if (hay.includes(core)) return true;
  const chars = [...core];
  if (chars.length < 2) return false;
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (hay.includes(chars[i] + chars[i + 1])) return true;
  }
  return false;
}

/** 问「今天有什么大事」这种没有主体词的问题：给热榜比乱搜准 */
const HOT_QUERY = /热搜|热榜|头条|今天有(什么|啥)|有什么(新闻|大事)|最近(有啥|有什么)/;

/** 头条热榜链接带一长串跟踪参数，正文里只留正文需要的部分 */
function shortUrl(raw) {
  const url = cleanUrl(raw);
  const hot = url.match(/^https?:\/\/www\.toutiao\.com\/trending\/(\d+)/);
  if (hot) return `https://www.toutiao.com/trending/${hot[1]}/`;
  return url;
}

async function hotList(limit = 4) {
  try {
    const list = await toutiaoHot({ limit });
    if (!list?.length) return '';
    return list.map((x) => `· ${truncate(x.title, 50)} —— ${shortUrl(x.url)}`).join('\n');
  } catch {
    return '';
  }
}

/**
 * 真去搜。必应 RSS 有个坑：「哈基米 梗」会被拆成「哈」+「梗」，返回「哈」的字典页；
 * 反过来「哈基米」或「哈基米 是什么梗」就正常。所以这里换几种说法搜、按主体词过滤、
 * 再把结果并起来——宁可少给两条，也不要给模型一堆「哈是什么意思」的垃圾。
 */
export async function lookup(query, { maxResults = 4, log = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return '';
  const core = coreOf(q);
  // 「今天有什么大事」这种没有主体词的问题，直接给热榜比乱搜准
  if (HOT_QUERY.test(q) && [...core].length <= 8) {
    const hot = await hotList(maxResults);
    if (hot) return hot;
  }
  const chars = [...core];
  const variants = [...new Set([
    q,
    core,
    core && `${core} 是什么梗`,
    // 中文长句没有空格，必应会把整句当短语：多试几个前缀（「塞尔达新作发售」→「塞尔达」）
    chars.length > 4 ? chars.slice(0, 4).join('') : '',
    chars.length > 3 ? chars.slice(0, 3).join('') : '',
  ].filter(Boolean))];
  const out = [];
  const seen = new Set();
  const push = (items) => {
    for (const it of items) {
      if (out.length >= maxResults) return;
      if (seen.has(it.url)) continue;
      // 字典/词典站对群聊没用，过滤阶段直接毙掉
      if (JUNK_HOST.test(String(it.url || ''))) continue;
      const hay = `${it.title || ''} ${it.desc || ''}`;
      // 主体词对不上就是跑到别的词上去了（「哈基米」被拆成「哈」），宁可不收
      if (!matchesCore(hay, core)) continue;
      seen.add(it.url);
      out.push(it);
    }
  };
  for (const v of variants) {
    if (out.length >= maxResults) break;
    try {
      push(await searchWeb(v, { limit: maxResults * 2 }));
    } catch (err) {
      log?.warn?.(`联网查「${v}」失败：${err.message}`);
    }
  }
  return out
    .map((x) => {
      const desc = String(x.desc || '').replace(/\s+/g, ' ').trim();
      return `· ${truncate(x.title, 60)}${desc ? `：${truncate(desc, 40)}` : ''} —— ${shortUrl(x.url)}`;
    })
    .join('\n');
}

/**
 * 一条龙：免费门判断要不要查 → 抽主体词 → 搜 → 返回给上下文用的一小段。
 * 返回 null 表示这轮不查（绝大多数消息都走这里）。
 *
 * 注意：不再让模型先判一次「该不该搜」——实测这条中转上哪怕小模型也要 4~8 秒，
 * 一次判断就能把被动回复拖成龟速。门（wantsLookup）本身足够严，直接搜只要 0.3~1.3 秒。
 */
export async function lookupIfNeeded(text, { cfg = {}, log = null } = {}) {
  if (cfg.enabled === false) return null;
  if (!wantsLookup(text)) return null;
  const query = coreOf(text);
  if (!query) return null;
  const budget = Math.max(1000, Number(cfg.timeoutMs) || 3000);
  const block = await Promise.race([
    lookup(query, { maxResults: cfg.maxResults ?? 4, log }),
    new Promise((resolve) => setTimeout(() => resolve(''), budget)),
  ]);
  if (!block) return null;
  return { query, block };
}
