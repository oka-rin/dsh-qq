#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { OneBot } from './onebot.mjs';
import { Store } from './store.mjs';
import { Brain } from './brain.mjs';
import { Bot } from './bot.mjs';
import { MemeLibrary } from './memes.mjs';
import { ControlServer } from './control.mjs';
import { ShareScheduler } from './share.mjs';
import { InterjectScheduler } from './interject.mjs';
import { AgentLoop } from './agent.mjs';
import { searchHistory, archiveStats, listArchives } from './archive.mjs';
import { ScopeMemory } from './memory.mjs';
import { PeopleBook } from './people.mjs';
import { MemeKB } from './kb.mjs';
import { WeeklyScan } from './kb-scan.mjs';
import { DecisionLog } from './decisions.mjs';
import { LearnBook, Learner } from './learn.mjs';
import { QzoneSocial } from './qzone.mjs';
import { embedderOf } from './embed.mjs';
import { DailyNewsScheduler } from './daily-news.mjs';
import { createLogger, Emitter, sleep } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Existing process environment wins; external config's .env wins over package fallback.
const configFlag = process.argv.indexOf('--config');
const explicitConfig = configFlag >= 0 ? process.argv[configFlag + 1] : process.env.QQ_CONFIG;
const envRoots = [...new Set([explicitConfig ? path.dirname(path.resolve(explicitConfig)) : process.cwd(), ROOT])];
for (const dir of envRoots) {
  try {
    for (const line of fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* Optional .env. */ }
}

function usage() {
  console.log(`SnowLuma QQ 桥接

用法：
  node src/index.mjs init [--config config.json] [--force]
  node src/index.mjs start [--config config.json]       启动常驻机器人（QQ 自动聊天 + 控制台）
  node src/index.mjs mcp [--config config.json]         MCP stdio server（给 DSH/AI 客户端用）
  node src/index.mjs status                             查看运行状态
  node src/index.mjs groups [--refresh]                 列出机器人所在群
  node src/index.mjs history <scope> [--limit 20]       读最近聊天记录
  node src/index.mjs search --q 关键词 [--scope group:群号] [--days 7] [--limit 20]
                                                        按需在归档里捞历史（默认查全部会话）
  node src/index.mjs send <scope> <文本...> [--quote <message_id>]
  node src/index.mjs mention <scope> <qq> <文本...>      群里 @ 某人
  node src/index.mjs autochat <scope> <on|off>           开关某会话自动聊天
  node src/index.mjs share [--group 群号] [--dry]        手动触发一次主动分享（不带 --group 走定时逻辑）
  node src/index.mjs interject [--group 群号]            手动让机器人主动说一句
  node src/index.mjs agent [--group 群号] [--dry]        让模型自己对某个群做一轮决策（默认演练）
  node src/index.mjs raw <action> [json参数]             直接调用 OneBot 动作
  node src/index.mjs mock-onebot [--port 3000] [--ws 3001] [--token xxx]
  node src/index.mjs mock-llm [--port 9100]

scope 写法：group:群号  或  private:QQ号
控制台默认 http://127.0.0.1:8787 （config.control）
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/* -------------------------------------------------------------- 控制台客户端 */

function controlClient(cfg) {
  const base = `http://${cfg.control.host}:${cfg.control.port}`;
  const call = async (pathName, { method = 'GET', body } = {}) => {
    const url = `${base}${pathName}${pathName.includes('?') ? '&' : '?'}token=${encodeURIComponent(cfg.control.token || '')}`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  };
  return { call, base };
}

/* ------------------------------------------------------------------- 命令 */

async function cmdInit(flags) {
  const target = path.resolve(flags.config || 'config.json');
  if (fs.existsSync(target) && !flags.force) {
    console.log(`已存在 ${target}，跳过（要覆盖加 --force）`);
    return;
  }
  const example = path.join(ROOT, 'config.example.json');
  fs.copyFileSync(example, target);
  console.log(`已生成 ${target}`);
  console.log('接下来：');
  console.log('  1) 填 llm.apiKey 或 export DEEPSEEK_API_KEY=...');
  console.log('  2) 改 onebot.httpUrl / wsUrl 指向你的 SnowLuma');
  console.log('  3) node src/index.mjs start');
}

async function cmdStart(flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const log = createLogger('main', process.env.QQ_LOG_LEVEL || 'info');
  const emitter = new Emitter();

  log.info(`配置：${cfg.__configPath || '(内置默认值)'}`);
  log.info(`OneBot HTTP ${cfg.onebot.httpUrl} ｜ WS ${cfg.onebot.wsUrl}`);
  log.info(`模型 ${cfg.llm.model}（模式 ${cfg.llm.mode}）｜人设 ${cfg.persona.name}`);
  const bg = cfg.llm.background || {};
  log.info(`蒸馏任务走 ${bg.baseUrl || '主接口'} 的 ${bg.model || cfg.llm.model}`);

  const store = new Store(cfg.storage.dataDir);
  const onebot = new OneBot(cfg.onebot, {
    log: log.child('onebot'),
    onStatus: (state) => {
      emitter.emit({ type: 'transport', ...state, at: Date.now() });
    },
  });
  const brain = new Brain({ ...cfg, persona: store.persona() || cfg.persona }, { log: log.child('brain') });
  const scopeMemory = new ScopeMemory({
    dataDir: cfg.storage.dataDir,
    brain,
    log: log.child('memory'),
    everyHours: cfg.memory?.everyHours ?? 12,
    minNewLines: cfg.memory?.minNewLines ?? 30,
  });

  const decisions = new DecisionLog({ dataDir: cfg.storage.dataDir, log: log.child('why') });

  const people = new PeopleBook({
    dataDir: cfg.storage.dataDir,
    brain,
    log: log.child('people'),
    everyMessages: cfg.people?.everyMessages ?? 10,
    minGapMs: cfg.people?.minGapMs ?? 3 * 3600_000,
  });

  const memes = new MemeLibrary({ dirs: cfg.memes?.dirs, log: log.child('memes') });

  // 自主学习：群聊 + 网上资讯 → 长期笔记，回话/分享/说说时带几条
  const embedder = embedderOf(cfg, { log: log.child('embed') });
  const learnBook = new LearnBook({
    dataDir: cfg.storage.dataDir,
    log: log.child('learn'),
    maxNotes: cfg.chat?.learn?.maxNotes,
    embedder,
  });
  if (embedder) log.info('语义检索已启用：embedding ' + cfg.chat.learn.embedding.model);
  else log.info('语义检索未启用（没有 embedding key），只用字面检索');
  const learner = new Learner({
    dataDir: cfg.storage.dataDir,
    brain,
    log: log.child('learn'),
    book: learnBook,
    scopes: () => {
      try {
        return fs
          .readdirSync(path.join(cfg.storage.dataDir, 'history'))
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => f.replace(/\.jsonl$/, '').replace(/^([a-z]+)_/, '$1:'))
          .filter((s) => /^(group|private):/.test(s));
      } catch {
        return [];
      }
    },
    enabled: cfg.chat?.learn?.enabled !== false,
    everyHours: cfg.chat?.learn?.everyHours ?? 6,
    minLines: cfg.chat?.learn?.minLines ?? 20,
    maxNotes: cfg.chat?.learn?.maxNotes ?? 600,
  });

  const bot = new Bot({
    config: { ...cfg, persona: store.persona() || cfg.persona },
    onebot,
    store,
    brain,
    scopeMemory,
    people,
    decisions,
    memes,
    learn: learnBook,
    log: log.child('bot'),
    emitter,
  });

  bot.learner = learner; // agent 的 study 工具要用

  // 人设改动后同步给 brain
  const origSetPersona = store.setPersona.bind(store);
  store.setPersona = (p) => {
    const saved = origSetPersona(p);
    brain.cfg.persona = saved || cfg.persona;
    if (saved) bot.cfg.persona = saved;
    return saved;
  };

  const share = new ShareScheduler({
    config: { ...cfg, share: cfg.share },
    bot,
    log: log.child('share'),
    emitter,
  });

  const interject = new InterjectScheduler({
    config: { ...cfg, chat: cfg.chat },
    bot,
    log: log.child('interject'),
    emitter,
  });

  const kb = new MemeKB({ dataDir: cfg.storage.dataDir, log: log.child('kb') });

  // QQ 空间社交：回评自己说说下的评论、评论好友说说（护栏都在 qzone.mjs 里）
  const qzone = new QzoneSocial({
    config: cfg,
    bot,
    dataDir: cfg.storage.dataDir,
    log: log.child('qzone'),
  });
  bot.qzone = qzone;

  const agent = new AgentLoop({
    config: { ...cfg, agent: cfg.agent },
    bot,
    brain,
    memory: scopeMemory,
    people,
    decisions,
    kb,
    learn: learnBook,
    learner,
    qzone,
    log: log.child('agent'),
    emitter,
  });

  const dailyNews = new DailyNewsScheduler({
    config: cfg,
    // 面板保存会重启桥接；发送前也重读落盘配置，立即尊重取消勾选。
    getConfig: () => loadConfig({ configPath: cfg.__configPath || undefined }),
    bot, log: log.child('daily-news'), emitter,
  });

  const weeklyKb = new WeeklyScan({
    brain,
    kb,
    log: log.child('kb'),
    enabled: cfg.kb?.enabled !== false,
    everyMs: Number(cfg.kb?.everyDays || 7) * 24 * 3600 * 1000,
    scanOptions: { maxCalls: Number(cfg.kb?.maxCalls || 8) },
  });
  weeklyKb.start();

  const control = new ControlServer({ config: cfg, configPath: cfg.__configPath || null, bot, share, interject, agent, people, decisions, dailyNews, kb, kbScan: weeklyKb, learn: learnBook, learner, qzone, log: log.child('control'), emitter });
  emitter.on((event) => control.broadcast(event));

  await bot.start();
  await control.listen();
  if (cfg.dailyNews?.enabled) dailyNews.start();
  // agent.enabled 时由模型自己决定要不要说话，旧的「掷骰子」调度就不再跑
  if (cfg.agent?.enabled) {
    agent.start();
    log.info('自主决策模式：由模型自己决定说什么、做什么（旧的定时插嘴/分享已让位）');
  } else {
    share.start();
    interject.start();
  }

  // 自主学习：起来 2 分钟后先跑一轮（有旧数据时），之后每 15 分钟看一眼到没到点
  if (cfg.chat?.learn?.enabled !== false) {
    const kick = setTimeout(() => learner.maybeRun().catch((err) => log.warn(`自动学习失败：${err.message}`)), 120_000);
    const loop = setInterval(() => learner.maybeRun().catch((err) => log.warn(`自动学习失败：${err.message}`)), 15 * 60_000);
    kick.unref?.();
    loop.unref?.();
    log.info(`自主学习已启用：每 ${cfg.chat?.learn?.everyHours ?? 6} 小时学一轮（群聊 + 网上资讯）`);
  }

  // 指向我的评论「必回」：每 N 分钟看一眼，有新评论就自己生成一句回过去（不受额度和间隔限制）
  if (cfg.chat?.qzone?.enabled && Number(cfg.chat?.qzone?.replyEveryMinutes ?? 5) > 0) {
    const every = Math.max(1, Number(cfg.chat.qzone.replyEveryMinutes) || 5) * 60_000;
    const task = () => agent.replyQzonePending().catch((err) => log.warn(`空间必回失败：${err.message}`));
    const kick = setTimeout(task, 30_000);
    const loop = setInterval(task, every);
    kick.unref?.();
    loop.unref?.();
    log.info(`空间评论必回已启用：每 ${every / 60_000} 分钟看一次（指向它的评论不设额度）`);
  }

  const url = `http://${cfg.control.host}:${cfg.control.port}`;
  log.info(`控制台：${url}${cfg.control.token ? `/?token=${cfg.control.token}` : ''}`);
  if (!bot.selfId) log.warn('还没有拿到机器人账号信息：确认 SnowLuma 已登录、HTTP 端口开着');
  if (bot.brain.mode === 'api' && !process.env[cfg.llm.apiKeyEnv] && !cfg.llm.apiKey) {
    log.warn(`未检测到 ${cfg.llm.apiKeyEnv}，模型调用会失败。先 export ${cfg.llm.apiKeyEnv}=你的key`);
  }

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    log.info(`收到 ${sig}，正在退出…`);
    share.stop();
    interject.stop();
    agent.stop();
    dailyNews.stop();
    weeklyKb.stop();
    await bot.stop();
    await control.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 保持进程存活
  await new Promise(() => {});
}

async function cmdAgent(positional, flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const body = {};
  if (flags.group) body.groupId = String(flags.group);
  if (flags.scope) body.scope = String(flags.scope);
  if (flags.dry) body.dry = true; // 演练：只看模型打算做什么，不真发
  const out = await call('/api/agent', { method: 'POST', body });
  console.log(JSON.stringify(out, null, 2));
  return out?.ok ? 0 : 1;
}

async function cmdStatus(flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const s = await call('/api/status');
  console.log(`账号      ${s.nickname || '?'} (${s.selfId || '未登录'})`);
  console.log(`事件流    ${s.transport?.ws}${s.transport?.lastError ? `（${s.transport.lastError}）` : ''}`);
  console.log(`HTTP      ${s.transport?.http}`);
  console.log(`模型      ${s.llmMode} / ${s.model}`);
  console.log(`人设      ${s.persona}`);
  console.log(`群数量    ${s.groups}`);
  console.log(`已回复    ${s.stats?.replies ?? 0} 条（累计事件 ${s.stats?.events ?? 0}）`);
  const scopes = (s.scopes || []).slice(0, 10);
  if (scopes.length) {
    console.log('最近会话：');
    for (const sc of scopes) console.log(`  ${sc.scope}  ${sc.lastText ? `「${String(sc.lastText).slice(0, 30)}」` : ''}`);
  }
}

async function cmdGroups(flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const r = await call(`/api/groups${flags.refresh ? '?refresh=1' : ''}`);
  if (!r.groups?.length) {
    console.log('没有群（或还没连上 SnowLuma）');
    return;
  }
  for (const g of r.groups) console.log(`${g.group_id}\t${g.group_name}\t${g.member_count ?? '?'} 人`);
}

async function cmdHistory(positional, flags) {
  const scope = positional[0];
  if (!scope) throw new Error('用法：history <scope> [--limit 20]');
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const rows = await call(`/api/messages?scope=${encodeURIComponent(scope)}&limit=${Number(flags.limit || 20)}`);
  for (const r of rows) {
    const who = r.role === 'bot' ? `我(${r.name})` : r.name;
    const t = new Date(r.ts || Date.now()).toLocaleString('zh-CN', { hour12: false });
    console.log(`[${t}] ${who}: ${r.text}${r.messageId ? `  (id=${r.messageId})` : ''}`);
  }
}

async function cmdSearch(positional, flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const dataDir = cfg.storage.dataDir;
  const scope = flags.scope || (flags.group ? `group:${flags.group}` : undefined);
  const out = await searchHistory(dataDir, {
    scope,
    query: flags.q || flags.query,
    days: flags.days ? Number(flags.days) : undefined,
    name: flags.name,
    onlyMe: !!flags.me,
    limit: Number(flags.limit || 30),
    context: Number(flags.context || 0),
  });
  if (!out.total) {
    console.log('没搜到。归档里有：');
    for (const a of listArchives(dataDir)) console.log(`  ${a.scope}  ${a.lines} 条  ${(a.bytes / 1024).toFixed(1)}K`);
    return;
  }
  console.log(`命中 ${out.total} 条，显示最近 ${out.returned} 条：`);
  for (const h of out.hits) {
    const t = new Date(h.ts).toLocaleString('zh-CN', { hour12: false });
    console.log(`[${t}] ${h.scope} ${h.who}: ${h.text}`);
  }
}

async function cmdKb(positional, flags) {
  const loaded = loadConfig({ configPath: flags.config });
  const kb = new MemeKB({ dataDir: loaded.storage.dataDir, log: createLogger('kb') });
  kb.load();
  if (flags.scan || flags.force) {
    const { scanMemes } = await import('./kb-scan.mjs');
    if (!process.env[loaded.llm.apiKeyEnv] && !loaded.llm.apiKey) {
      console.error(`扫描需要模型 key：export ${loaded.llm.apiKeyEnv}=...`);
      return 1;
    }
    const brain = new Brain(loaded, { log: createLogger('brain') });
    const out = await scanMemes({ brain, kb, log: createLogger('kb'), maxCalls: Number(flags.limit || loaded.kb?.maxCalls || 8) });
    console.log(`新增 ${out.added}，更新 ${out.updated}，库里共 ${out.total} 条`);
    return 0;
  }
  const q = flags.search || positional[0];
  if (q) {
    const hits = kb.search(q, { limit: Number(flags.limit || 8) });
    if (!hits.length) {
      console.log(`库里没有「${q}」`);
      return 0;
    }
    for (const m of hits) {
      console.log(`【${m.name}】热度 ${m.heat || 0}`);
      if (m.meaning) console.log(`  意思：${m.meaning}`);
      if (m.origin) console.log(`  出处：${m.origin}`);
      if (m.usage) console.log(`  用法：${m.usage}`);
      if (m.example) console.log(`  例句：${m.example}`);
    }
    return 0;
  }
  const st = kb.stats();
  const last = st.lastScanAt ? new Date(st.lastScanAt).toLocaleString('zh-CN') : '从未';
  console.log(`梗库：${st.total} 条，上次扫描 ${last}`);
  if (st.top.length) console.log(`最热：${st.top.join('、')}`);
  if (st.tags.length) console.log(`标签：${st.tags.join(' ')}`);
  return 0;
}

async function cmdWhy(positional, flags) {
  const cfg = loadConfig(flags.config || './config.json');
  const log = createLogger(flags.quiet ? 'error' : cfg.log?.level || 'info');
  const book = new DecisionLog({ dataDir: cfg.storage.dataDir, log });
  const scope = flags.scope || (positional[0] && /^(group|private):/.test(positional[0]) ? positional[0] : '');
  const limit = Number(flags.limit || 20);
  const today = book.summary({ scope });
  console.log(`\n今天：说了 ${today.acted} 次，没说话 ${today.silent} 次\n`);
  if (today.reasons.length) {
    console.log('按原因汇总（次数多的在前）：');
    for (const r of today.reasons) {
      const label = { passive: '被动回消息', agent: '主动决策', share: '主动分享', qzone: '发说说', interject: '插嘴' }[r.kind] || r.kind;
      console.log(`  ${String(r.n).padStart(3)} 次 · ${label} · ${r.reason}`);
    }
  }
  const rows = book.recent({ limit, scope });
  if (rows.length) {
    console.log(`\n最近 ${rows.length} 条（新→旧）：`);
    for (const r of rows) {
      const when = new Date(r.at).toLocaleString('zh-CN', { hour12: false });
      const mark = r.acted ? '说' : '默';
      console.log(`  [${mark}] ${when} ${r.scope} ${r.reason}${r.n > 1 ? ` ×${r.n}` : ''}${r.detail ? `（${r.detail}）` : ''}`);
    }
  }
  console.log('');
  return 0;
}

async function cmdArchive(positional, flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const st = archiveStats(cfg.storage.dataDir);
  console.log(`归档：${st.scopes} 个会话，共 ${st.lines} 条，${(st.bytes / 1024).toFixed(1)}K`);
  for (const [scope, v] of Object.entries(st.byScope)) {
    console.log(`  ${scope}  ${v.lines} 条  ${(v.bytes / 1024).toFixed(1)}K  最后更新 ${new Date(v.modifiedAt).toLocaleString('zh-CN', { hour12: false })}`);
  }
}

/**
 * 人物画像：列出 / 查看 / 让它学一次
 *   people                    列出认识的所有人
 *   people --uin 10000001    看这个人的档案
 *   people --uin 10000001 --learn   让模型现在读一遍他的话重新总结
 *   people --learn            把攒够的人都学一遍（最多 3 个）
 */
async function cmdPeople(positional, flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const brain = new Brain(cfg, { log: createLogger('brain') });
  const book = new PeopleBook({
    dataDir: cfg.storage.dataDir,
    brain,
    log: createLogger('people'),
    everyMessages: cfg.people?.everyMessages ?? 10,
    minGapMs: cfg.people?.minGapMs ?? 3 * 3600_000,
  });

  if (flags.uin) {
    const uin = String(flags.uin);
    if (flags.learn) {
      const r = await book.learn(uin, { force: true });
      console.log(r.ok ? `✔ 学会了：${r.summary}` : `✘ 没学成：${r.reason}`);
      if (r.ok) for (const f of r.facts) console.log(`  · ${f}`);
      return r.ok ? 0 : 1;
    }
    const p = book.read(uin);
    console.log(`QQ ${p.uin}  ${p.names?.join(' / ') || '（还不知道叫什么）'}`);
    console.log(`说过 ${p.msgs} 条 · 学过 ${p.learnings || 0} 次 · 待学 ${(p.pending || []).length} 条`);
    console.log(`总述：${p.summary || '（还没学）'}`);
    if (p.style) console.log(`风格：${p.style}`);
    for (const f of p.facts || []) console.log(`  · ${f}`);
    return 0;
  }

  if (flags.backfill) {
    const r = await book.backfill(cfg.storage.dataDir);
    console.log(`✔ 从历史里灌了 ${r.rows} 条发言，共 ${r.people} 个人`);
  }

  if (flags.learn) {
    const n = await book.sweep(3);
    console.log(n ? `✔ 学了 ${n} 个人` : '没有攒够新消息的人，先让他们多说几句');
    return 0;
  }

  const rows = book.list();
  if (!rows.length) {
    console.log('还不认识任何人（等他们在群里说几句话，或者跑 people --learn）');
    return 0;
  }
  console.log(`认识 ${rows.length} 个人：`);
  for (const p of rows) {
    const when = p.lastSeen ? new Date(p.lastSeen).toLocaleString('zh-CN', { hour12: false }) : '—';
    console.log(`  ${p.names?.[0] || p.uin}（${p.uin}）说了 ${p.msgs} 条 · 最后 ${when}`);
    if (p.summary) console.log(`    ${p.summary}`);
    for (const f of (p.facts || []).slice(0, 3)) console.log(`    · ${f}`);
  }
  return 0;
}

async function cmdSummarize(positional, flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const brain = new Brain(cfg, { log: createLogger('brain') });
  const mem = new ScopeMemory({
    dataDir: cfg.storage.dataDir,
    brain,
    log: createLogger('memory'),
    everyHours: cfg.memory?.everyHours ?? 12,
    minNewLines: cfg.memory?.minNewLines ?? 30,
  });
  const scopes = flags.scope
    ? [String(flags.scope)]
    : [...(cfg.agent?.groups || []).map((g) => `group:${g}`), ...listArchives(cfg.storage.dataDir).map((a) => a.scope)];
  const uniq = [...new Set(scopes)];
  for (const scope of uniq) {
    const r = await mem.refresh(scope, { force: !!flags.force });
    if (r.ok) {
      console.log(`✔ ${scope}：新增 ${r.facts.length} 条事实`);
      console.log(`  总述：${r.summary}`);
      for (const f of r.facts) console.log(`  - ${f}`);
    } else {
      console.log(`· ${scope}：跳过（${r.reason}）`);
    }
  }
}

async function cmdSend(positional, flags) {
  const [scope, ...rest] = positional;
  const text = rest.join(' ');
  if (!scope || !text) throw new Error('用法：send <scope> <文本...> [--quote <message_id>]');
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const r = await call('/api/send', { method: 'POST', body: { scope, text, quote: flags.quote } });
  console.log(`已发送（message_id=${r.messageId ?? 'null'}）`);
}

async function cmdMention(positional, flags) {
  const [scope, qq, ...rest] = positional;
  if (!scope || !qq) throw new Error('用法：mention <scope> <qq> <文本...>');
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const r = await call('/api/mention', { method: 'POST', body: { scope, qq, text: rest.join(' ') } });
  console.log(`已发送（message_id=${r.messageId ?? 'null'}）`);
}

async function cmdAutochat(positional, flags) {
  const [scope, state] = positional;
  if (!scope || !state) throw new Error('用法：autochat <scope> <on|off>');
  const on = /^(on|1|true|开|开启)$/i.test(state);
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const r = await call('/api/autochat', { method: 'POST', body: { scope, enabled: on } });
  console.log(`${scope} 自动聊天：${r.autochat ? '开' : '关'}`);
}

async function cmdShare(positional, flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const body = {};
  if (flags.group) body.groupId = String(flags.group);
  if (flags.scope) body.scope = String(flags.scope);
  const out = await call('/api/share', { method: 'POST', body });
  console.log(JSON.stringify(out, null, 2));
  return out?.ok ? 0 : 1;
}

async function cmdInterject(positional, flags) {
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const body = {};
  if (flags.group) body.groupId = String(flags.group);
  const out = await call('/api/interject', { method: 'POST', body });
  console.log(JSON.stringify(out, null, 2));
  return out?.ok ? 0 : 1;
}

async function cmdRaw(positional, flags) {
  const [action, json] = positional;
  if (!action) throw new Error('用法：raw <action> [json参数]');
  const params = json ? JSON.parse(json) : {};
  const cfg = loadConfig({ configPath: flags.config });
  const { call } = controlClient(cfg);
  const r = await call('/api/raw', { method: 'POST', body: { action, params } });
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdMockOnebot(flags) {
  const { startMockOneBot } = await import('./mock.mjs');
  const port = Number(flags.port || 3000);
  const wsPort = Number(flags.ws || 3001);
  const mock = await startMockOneBot({ port, wsPort, token: String(flags.token || ''), selfId: 10001 });
  console.log(`假 SnowLuma 已启动：HTTP http://127.0.0.1:${mock.httpPort}  WS ws://127.0.0.1:${mock.wsPort}/event`);
  console.log('按 Ctrl+C 退出；可以配合 npm start 手动观察（config.json 指向这两个端口）');
  console.log('调试接口：POST /__inject 注入事件；POST /__auto 定时说话');
  let i = 0;
  const timer = flags['no-auto']
    ? null
    : setInterval(() => {
        i += 1;
        mock.groupMessage({ message: i % 3 === 0 ? '@小雪花 你在吗' : `群友闲聊第 ${i} 句`, userId: 20002, name: '阿强' });
      }, 15000);
  timer?.unref?.();
  process.on('SIGINT', async () => {
    if (timer) clearInterval(timer);
    await mock.close();
    process.exit(0);
  });
  await new Promise(() => {});
}

async function cmdMockLlm(flags) {
  const { startMockLlm } = await import('./mock.mjs');
  const mock = await startMockLlm({ port: Number(flags.port || 9100) });
  console.log(`假模型已启动：http://127.0.0.1:${mock.port}/v1/chat/completions`);
  await new Promise(() => {});
}

/* -------------------------------------------------------------------- 入口 */

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  try {
    switch (command) {
      case 'init':
        return await cmdInit(flags);
      case 'start':
        return await cmdStart(flags);
      case 'mcp':
        await import('./mcp.mjs');
        return await new Promise(() => {});
      case 'status':
        return await cmdStatus(flags);
      case 'groups':
        return await cmdGroups(flags);
      case 'summarize':
        return await cmdSummarize(positional, flags);
      case 'people':
        return await cmdPeople(positional, flags);
      case 'search':
        return await cmdSearch(positional, flags);
      case 'kb':
        return await cmdKb(positional, flags);
      case 'why':
        return await cmdWhy(positional, flags);
      case 'archive':
        return await cmdArchive(positional, flags);
      case 'history':
        return await cmdHistory(positional, flags);
      case 'send':
        return await cmdSend(positional, flags);
      case 'mention':
        return await cmdMention(positional, flags);
      case 'autochat':
        return await cmdAutochat(positional, flags);
      case 'agent': {
        if ((await cmdAgent(positional, flags)) === 0) return;
        process.exitCode = 1;
        return;
      }
      case 'interject':
        return await cmdInterject(positional, flags);
      case 'share':
        if ((await cmdShare(positional, flags)) === 0) return;
        process.exitCode = 1;
        return;
      case 'raw':
        return await cmdRaw(positional, flags);
      case 'mock-onebot':
        return await cmdMockOnebot(flags);
      case 'mock-llm':
        return await cmdMockLlm(flags);
      default:
        usage();
        if (command) process.exitCode = 1;
    }
  } catch (err) {
    console.error(`失败：${err.message}`);
    if (process.env.QQ_LOG_LEVEL === 'debug') console.error(err.stack);
    process.exitCode = 1;
  }
}

void main();
