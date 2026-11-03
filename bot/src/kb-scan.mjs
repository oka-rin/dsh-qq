/**
 * 每周一次的「全网找梗」扫描器。
 *
 * 做法：一组种子查询 → 各来源搜标题/摘要 → 交给模型抽取结构化条目 → 写进 MemeKB。
 * 只用公开接口；拿不到就跳过，不重试到死。
 */
import { searchWeb, searchBilibili, searchZhihu, searchTieba, toutiaoHot } from './sources.mjs';

/** 种子查询：热门 + 小众都覆盖 */
export const SEED_QUERIES = [
  // 大盘：最近在火什么
  '最近很火的梗 出处',
  '本周网络热梗 盘点',
  '梗百科 最新',
  '流行语 2026 新梗',
  '这个梗什么意思 出处',
  '全网爆火的梗 一览',
  // 平台生态
  '弹幕梗 出处 解释',
  '贴吧 造梗 热门',
  'B站 鬼畜 名场面 台词',
  '抖音 评论区 神回复 梗',
  '小红书 网络用语 黑话',
  '知乎 梗 科普',
  '微博 热梗 为什么火',
  '快手 土味梗 出处',
  // 圈层
  '游戏圈 梗 出处',
  '电竞 梗 名场面',
  '二次元 梗 出处',
  'V圈 黑话 解释',
  '饭圈 黑话 缩写 意思',
  '说唱 圈 梗',
  '动漫 台词 成梗',
  '特摄 圈 梗',
  '音乐圈 梗 解释',
  '体育圈 梗 出处',
  '编程 程序员 梗 黑话',
  'AI 圈 梗 黑话',
  '学术圈 梗',
  '职场 黑话 梗',
  '医学生 梗 黑话',
  // 语言机制（造梗的结构来源）
  '谐音梗 名字 出处',
  '缩写梗 拼音 解释',
  '抽象话 梗 解释',
  '反差 反转 网络段子 来历',
  '缝合 梗 出处',
  '拟人化 网络用语 出处',
  '老梗 复活 为什么突然火',
  '冷门梗 科普',
  '翻车 梗 出处',
  '阴阳怪气 话术 出处',
  '表情包 出处 什么梗',
];

const SYSTEM = `你是网络用语与梗的整理员。读到一批搜索结果（标题/摘要）后，挑出真正是「梗/网络用语/名场面台词」的东西，给出结构化条目。
只输出 JSON 数组，不要任何解释文字。每个元素：
{"name":"梗的名字（2~12 字）","meaning":"一句话含义（≤40字）","origin":"出处（作品/事件/人物，不确定写空）","usage":"什么场合用","example":"一句示例","heat":0-100,"tags":["游戏","动漫"之类]}
要求：
- 只要搜索结果里真的出现过的，不要凭印象编；
- 已经在库里见过的不用重复（我会告诉你已有的名字）；
- name 必须是 2~12 字的**短语**，不能是整句话、不能是新闻标题、不能是纯数字；
- 热搜里那种「某个新闻事件的描述句」不算梗，直接跳过；
- 不确定是不是梗、说不清意思的，不要写；
- 最多 12 条，宁缺毋滥。`;

/** 热榜（60s 聚合接口）：微博/知乎的热搜词本身就是最鲜活的梗来源 */
export async function fetchHotTitles({ limit = 25, timeoutMs = 12000 } = {}) {
  const out = [];
  for (const [name, url] of [
    ['微博热搜', 'https://60s.viki.moe/v2/weibo'],
    ['知乎热榜', 'https://60s.viki.moe/v2/zhihu'],
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const json = await res.json();
      const items = Array.isArray(json?.data) ? json.data : [];
      for (const it of items) {
        const title = String(it?.title || it?.name || '').trim();
        if (title) out.push({ title, desc: `${name}`, url: String(it?.url || it?.link || '') });
        if (out.length >= limit) return out;
      }
    } catch {
      /* 拿不到就跳过 */
    }
  }
  return out;
}

function parseJsonArray(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 把一条查询在各来源搜到的标题摘要压成一段文本 */
async function gather(query, { perSource = 4, log } = {}) {
  const tasks = [
    searchWeb(query, { limit: perSource }),
    searchBilibili(query, { limit: perSource }),
    searchZhihu(query, { limit: perSource }),
    searchTieba(query, { limit: perSource }),
  ];
  const settled = await Promise.allSettled(tasks);
  const items = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const it of r.value) {
      const title = String(it?.title || '').replace(/<[^>]+>/g, '').trim();
      if (!title) continue;
      items.push({ title, desc: String(it?.desc || '').slice(0, 120), url: it?.url || '' });
    }
  }
  if (!items.length) {
    try {
      const hot = await toutiaoHot({ limit: perSource });
      for (const h of hot) items.push({ title: String(h.title || '').trim(), desc: '热榜', url: h.url || '' });
    } catch {
      /* 热榜也拿不到就算了 */
    }
  }
  log?.debug?.(`${query}：${items.length} 条素材`);
  return items;
}

/**
 * 跑一轮扫描。
 * @returns {{queries:number, added:number, updated:number, total:number}}
 */
export async function scanMemes({ brain, kb, log, queries = SEED_QUERIES, perSource = 4, maxCalls = 8, hot = true } = {}) {
  if (!brain?.complete) throw new Error('扫描需要 brain.complete');
  if (!kb) throw new Error('扫描需要 kb');
  const known = new Set(kb.all().map((r) => r.name));
  let added = 0;
  let updated = 0;

  // 第一轮：热榜里挑梗（最鲜活，命中率最高）
  if (hot !== false) {
    const titles = await fetchHotTitles({ limit: 30 }).catch(() => []);
    if (titles.length) {
      const material = titles.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
      const prompt = `下面是今天各平台的热搜词。挑出其中真正是「梗 / 网络用语 / 圈内黑话 / 名场面台词」的，给我解释。不是梗的（新闻事件、人名、比赛）直接跳过。\n\n已有梗（不要重复）：${[...known].slice(0, 60).join('、') || '（空）'}\n\n热榜：\n${material}`;
      try {
        const text = await brain.complete({ system: SYSTEM, prompt, maxChars: 1600 });
        const rows = parseJsonArray(text);
        if (rows.length) {
          const res = kb.addMany(rows.map((r) => ({ ...r, source: '热榜' })));
          added += res.added;
          updated += res.updated;
          for (const r of rows) if (r?.name) known.add(String(r.name));
        }
      } catch (err) {
        log?.warn?.(`热榜抽取失败：${err.message}`);
      }
    }
  }

  for (const query of queries.slice(0, maxCalls)) {
    let items;
    try {
      items = await gather(query, { perSource, log });
    } catch (err) {
      log?.warn?.(`搜「${query}」失败：${err.message}`);
      continue;
    }
    if (!items.length) continue;
    const material = items
      .slice(0, 14)
      .map((it, i) => `${i + 1}. ${it.title}${it.desc ? ` —— ${it.desc}` : ''}`)
      .join('\n');
    const prompt = `查询：${query}\n\n已有梗（不要重复）：${[...known].slice(0, 60).join('、') || '（空）'}\n\n搜索结果：\n${material}`;
    let text;
    try {
      text = await brain.complete({ system: SYSTEM, prompt, maxChars: 1600 });
    } catch (err) {
      log?.warn?.(`抽取出错：${err.message}`);
      continue;
    }
    const rows = parseJsonArray(text);
    if (!rows.length) {
      log?.debug?.(`「${query}」没抽出条目`);
      continue;
    }
    const stamped = rows.map((r) => ({ ...r, source: query }));
    const res = kb.addMany(stamped);
    added += res.added;
    updated += res.updated;
    for (const r of rows) if (r?.name) known.add(String(r.name));
  }

  kb.writeState({ lastScanAt: Date.now(), lastCount: kb.stats().total });
  log?.info?.(`本次扫描完成：新增 ${added}，更新 ${updated}，库里 ${kb.stats().total} 条`);
  return { queries: Math.min(queries.length, maxCalls), added, updated, total: kb.stats().total };
}

/** 每周一次的调度：每小时醒一下，看够不够 7 天 */
export class WeeklyScan {
  constructor({ brain, kb, log, everyMs = 7 * 24 * 3600 * 1000, tickMs = 3600 * 1000, enabled = true, scanOptions = {} }) {
    this.brain = brain;
    this.kb = kb;
    this.log = log;
    this.everyMs = everyMs;
    this.tickMs = tickMs;
    this.enabled = enabled;
    this.scanOptions = scanOptions;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!this.enabled || !this.kb || !this.brain) return;
    const st = this.kb.readState();
    const due = !st.lastScanAt || Date.now() - st.lastScanAt >= this.everyMs;
    this.log?.info?.(`梗库：每周扫描已排程（上次 ${st.lastScanAt ? new Date(st.lastScanAt).toLocaleString('zh-CN') : '从未'}）`);
    if (due) setTimeout(() => this.run({ reason: 'first' }).catch(() => {}), 90_000); // 启动后别抢启动资源
    this.timer = setInterval(() => this.run({ reason: 'tick' }).catch(() => {}), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  shouldRun(now = Date.now()) {
    const st = this.kb?.readState?.() || {};
    return !st.lastScanAt || now - st.lastScanAt >= this.everyMs;
  }

  async run({ force = false, reason = 'tick' } = {}) {
    if (this.running) return { skipped: 'running' };
    if (!force && !this.shouldRun()) return { skipped: 'not-due' };
    this.running = true;
    try {
      this.log?.info?.(`梗库：开始扫描（${reason}）`);
      const out = await scanMemes({ brain: this.brain, kb: this.kb, log: this.log, ...this.scanOptions });
      return out;
    } finally {
      this.running = false;
    }
  }
}
