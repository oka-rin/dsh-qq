import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, scopeKey } from './util.mjs';
import { DAILY_NEWS_DEFAULTS } from './daily-news.mjs';
import { NEWS_SOURCES } from './daily-catalog.mjs';
import { CONFIG_SCHEMA, FIELD_BY_PATH, getByPath, setByPath } from './schema.mjs';
import { validateReasoningConfig } from './reasoning.mjs';

const DAILY_NEWS_FIELDS = [...Object.keys(DAILY_NEWS_DEFAULTS), 'notBeforeDate'];
const NEWS_SOURCE_IDS = new Set(NEWS_SOURCES);
const NEWS_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isNewsTime = (value) => typeof value === 'string' && value.length === 5 && NEWS_TIME.test(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate the entire panel patch before constructing or writing a new config. */
function dailyNewsPatch(value) {
  if (!isObject(value)) throw new Error('dailyNews 必须是对象');
  const clean = {};
  for (const [key, field] of Object.entries(value)) {
    if (!DAILY_NEWS_FIELDS.includes(key)) throw new Error(`dailyNews 不支持字段 ${key}`);
    if (['enabled', 'deduplicate', 'dryRun'].includes(key)) {
      if (typeof field !== 'boolean') throw new Error(`dailyNews.${key} 必须是布尔值`);
    } else if (key === 'time') {
      if (!isNewsTime(field)) throw new Error('dailyNews.time 必须是 HH:mm');
    } else if (key === 'timeZone') {
      if (field !== 'Asia/Shanghai') throw new Error('dailyNews.timeZone 只支持 Asia/Shanghai');
    } else if (key === 'sources') {
      if (!Array.isArray(field) || field.some((id) => typeof id !== 'string' || !NEWS_SOURCE_IDS.has(id))) {
        throw new Error('dailyNews.sources 必须是已知资讯源 ID 数组');
      }
    } else if (key === 'sourceTimes') {
      if (!isObject(field) || Object.entries(field).some(([id, time]) => !NEWS_SOURCE_IDS.has(id) || !isNewsTime(time))) {
        throw new Error('dailyNews.sourceTimes 必须是已知资讯源 ID 到 HH:mm 的映射');
      }
    } else if (key === 'notBeforeDate') {
      if (typeof field !== 'string' || (field !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(field)
        || !Number.isFinite(Date.parse(field)) || new Date(field).toISOString().slice(0, 10) !== field))) {
        throw new Error('dailyNews.notBeforeDate 必须是有效 YYYY-MM-DD 日期或空字符串');
      }
    } else {
      const [min, max] = { retryMinutes: [1, 60], catchUpMinutes: [1, 180], sourceGapMs: [0, 10000] }[key];
      if (!Number.isInteger(field) || field < min || field > max) throw new Error(`dailyNews.${key} 必须是 ${min}..${max} 的整数`);
    }
    // Arrays/maps replace exactly: [] cancels all sources; {} removes time overrides.
    clean[key] = Array.isArray(field) ? [...field] : isObject(field) ? { ...field } : field;
  }
  return clean;
}

/** Read at most 256 KiB, never the entire growing event log; ignore a partial first line. */
function recentDailyNewsEvents(file) {
  if (!file) return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const events = [];
    for (let i = lines.length - 1; i >= 0 && events.length < 50; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (isObject(event)) events.push(event);
      } catch { /* An interrupted JSONL write must not break the status endpoint. */ }
    }
    return events.reverse();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const DASHBOARD = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SnowLuma QQ 控制台</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --card:#171a21; --line:#262b36; --fg:#e6e8ee; --muted:#8b93a7; --accent:#5b8cff; --ok:#3ecf8e; --warn:#ffb020; --err:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.6 -apple-system,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); }
  header h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.3px; }
  .pill { font-size:12px; padding:2px 9px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .pill.ok { color:var(--ok); border-color:#1f5f45; }
  .pill.bad { color:var(--err); border-color:#5f2323; }
  main { display:grid; grid-template-columns: 300px 1fr; gap:14px; padding:14px; max-width:1280px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; }
  .card h2 { font-size:12px; text-transform:uppercase; letter-spacing:.8px; color:var(--muted); margin:0 0 10px; }
  .row { display:flex; gap:8px; }
  input, textarea, button { font:inherit; color:inherit; }
  input, textarea { width:100%; background:#0d1016; border:1px solid var(--line); border-radius:8px; padding:8px 10px; outline:none; }
  input:focus, textarea:focus { border-color:var(--accent); }
  button { background:var(--accent); border:0; border-radius:8px; padding:8px 14px; color:#fff; cursor:pointer; }
  button.ghost { background:#1e2430; border:1px solid var(--line); }
  textarea { min-height:76px; resize:vertical; }
  #log { height:420px; overflow:auto; font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; }
  #log .t { color:var(--muted); }
  #log .m { color:#9ad0ff; }
  #log .s { color:var(--ok); }
  #log .e { color:var(--err); }
  .list { max-height:420px; overflow:auto; display:flex; flex-direction:column; gap:6px; }
  .item { padding:8px 10px; border:1px solid var(--line); border-radius:8px; cursor:pointer; }
  .item:hover { border-color:var(--accent); }
  .item small { color:var(--muted); display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .k { color:var(--muted); }
  @media (max-width: 900px) { main { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>SnowLuma · QQ 控制台</h1>
  <span class="pill" id="self">未连接</span>
  <span class="pill" id="ws">ws ?</span>
  <span class="pill" id="llm">llm ?</span>
</header>
<main>
  <section class="card">
    <h2>会话</h2>
    <div class="row" style="margin-bottom:10px">
      <input id="scope" placeholder="group:123456 或 private:789" />
      <button class="ghost" onclick="useScope()">选用</button>
    </div>
    <div class="list" id="scopes"></div>
  </section>
  <section style="display:flex;flex-direction:column;gap:14px">
    <div class="card">
      <h2>发消息</h2>
      <div class="row" style="margin-bottom:8px">
        <input id="quote" placeholder="要引用的 message_id（可空）" />
      </div>
      <textarea id="text" placeholder="要说的话…"></textarea>
      <div class="row" style="margin-top:8px">
        <button onclick="send()">发送</button>
        <button class="ghost" onclick="toggleAuto(true)">开启自动聊天</button>
        <button class="ghost" onclick="toggleAuto(false)">关闭自动聊天</button>
      </div>
    </div>
    <div class="card">
      <h2>实时动态</h2>
      <div id="log"></div>
    </div>
  </section>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const api = (p, opt) => fetch(p + (token ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : ''), opt)
    .then(r => r.json());
  const $ = (s) => document.querySelector(s);
  const log = (cls, ...parts) => {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = '<span class="t">' + new Date().toLocaleTimeString('zh-CN', {hour12:false}) + '</span> ' + parts.join(' ');
    $('#log').appendChild(el);
    $('#log').scrollTop = 1e9;
  };
  function useScope(){ const s = $('#scope').value.trim(); if (s) loadMessages(s); }
  async function loadMessages(scope){
    const rows = await api('/api/messages?scope=' + encodeURIComponent(scope) + '&limit=15');
    if (!Array.isArray(rows)) return;
    log('m', '<b>' + scope + '</b>');
    for (const r of rows) log('', '<span class="t">' + (r.role === 'bot' ? '我' : (r.name || '?')) + '</span> ' + String(r.text ?? '').replace(/</g,'&lt;'));
  }
  async function send(){
    const scope = $('#scope').value.trim();
    const text = $('#text').value;
    const quote = $('#quote').value.trim();
    const res = await api('/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ scope, text, quote: quote || undefined }) });
    log(res.ok ? 's' : 'e', '发送' + (res.ok ? '成功' : '失败：' + (res.error || '')));
    if (res.ok) $('#text').value = '';
  }
  async function toggleAuto(enabled){
    const scope = $('#scope').value.trim();
    const res = await api('/api/autochat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ scope, enabled }) });
    log(res.ok ? 's' : 'e', '自动聊天 → ' + (enabled ? '开' : '关'));
  }
  async function refresh(){
    try {
      const s = await api('/api/status');
      $('#self').textContent = (s.nickname || '?') + ' · ' + (s.selfId || '?');
      $('#self').className = 'pill ' + (s.selfId ? 'ok' : 'bad');
      $('#ws').textContent = 'ws ' + (s.transport?.ws || '?');
      $('#ws').className = 'pill ' + (s.transport?.ws === 'open' ? 'ok' : 'bad');
      $('#llm').textContent = 'llm ' + s.llmMode + ' · ' + s.model;
      const scopes = (s.scopes || []).map(x => x.scope);
      $('#scopes').innerHTML = scopes.map(sc => '<div class="item" onclick="document.querySelector(\'#scope\').value=\\'' + sc + '\\';loadMessages(\\'' + sc + '\\')"><b>' + sc + '</b></div>').join('') || '<small style="color:#8b93a7">还没有会话记录</small>';
    } catch (e) { log('e', '状态请求失败'); }
  }
  const es = new EventSource('/api/events' + (token ? '?token=' + encodeURIComponent(token) : ''));
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'message') log('m', '<b>' + d.from + '</b>：' + String(d.text).replace(/</g,'&lt;'));
    else if (d.type === 'sent') log('s', '发出：' + String(d.text).replace(/</g,'&lt;'));
    else if (d.type === 'thinking') log('', '<span class="t">思考中</span> ' + (d.scope || ''));
    else if (d.type === 'error') log('e', '错误：' + d.error);
    else if (d.type === 'skip') log('', '<span class="t">跳过 ' + (d.reason || '') + '</span>');
  };
  refresh(); setInterval(refresh, 10000);
</script>
</body>
</html>`;

/**
 * 本机控制台 HTTP API：给 CLI、MCP、浏览器面板共用。
 * 默认只监听 127.0.0.1；如果配了 token，则所有 /api 请求都要带 token。
 */
export class ControlServer {
  constructor({ config, configPath = null, bot, share = null, interject = null, agent = null, people = null, decisions = null, dailyNews = null, kb = null, kbScan = null, learn = null, learner = null, qzone = null, social = null, personaEvolve = null, log = createLogger('control'), emitter }) {
    this.cfg = config;
    this.configPath = configPath;
    this.bot = bot;
    this.share = share;
    this.interject = interject;
    this.agent = agent;
    this.people = people;
    this.dailyNews = dailyNews;
    this.kb = kb;
    this.kbScan = kbScan;
    this.learn = learn; // 自主学习笔记（LearnBook）
    this.learner = learner; // 学习器（Learner）
    this.qzone = qzone; // QQ 空间社交（QzoneSocial）
    this.social = social; // 视频社交（SocialHub）
    this.personaEvolve = personaEvolve; // 人格自微调（PersonaEvolver）
    this.decisions = decisions; // 决策账本：为什么没说话
    this.log = log;
    this.emitter = emitter;
    this.server = null;
    this.sseClients = new Set();
  }

  /** 配置面板用：每组的每个字段带上当前值（密钥只报「有没有」，不回显） */
  /** 「学习 · 蒸馏与检索」组顶部说清此刻到底谁在干活（面板一眼看得出，免得对着两个模型名猜） */
  #distillNote() {
    const llm = this.cfg.llm || {};
    const bg = llm.background || {};
    const emb = this.cfg.chat?.learn?.embedding || {};
    const embKey = emb.apiKey || process.env[emb.keyEnv || 'DASHSCOPE_API_KEY'] || '';
    const host = String(bg.baseUrl || '').replace(/^https?:\/\//, '').split('/')[0];
    const distill = bg.baseUrl
      ? `独立接口 ${host || '(没填)'} 的 ${bg.model || llm.model || '(未配)'}`
      : `主接口的 ${bg.model || llm.model || '(未配)'}`;
    const recall = emb.enabled !== false && embKey ? `${emb.model || '(未填)'}（${emb.dims || 1024} 维）` : '没开，只用字面检索';
    return `【现在实际】蒸馏 → ${distill}；检索 → ${recall}。`;
  }

  // Persisted live persona has the same precedence as Brain/Bot at startup.
  // Both settings views and both save routes must use this baseline.
  #effectiveConfig() {
    return { ...this.cfg, persona: this.bot.store?.persona?.() || this.cfg.persona };
  }

  #schemaView() {
    const effective = this.#effectiveConfig();
    const secretSet = (path) => {
      if (getByPath(this.cfg, path)) return true;
      const envName = getByPath(this.cfg, path.replace(/\.apiKey$/, '.keyEnv'));
      return Boolean(envName && process.env[envName]);
    };
    return CONFIG_SCHEMA.map((group) => ({
      id: group.id,
      title: group.title,
      note: group.id === 'distill' ? `${this.#distillNote()} ${group.note || ''}` : group.note || '',
      fields: group.fields.map((f) => {
        const raw = getByPath(effective, f.path);
        if (f.type === 'secret') {
          return { ...f, value: '', secret: true, set: secretSet(f.path) };
        }
        return { ...f, value: raw === undefined ? null : raw };
      }),
    }));
  }

  /** 面板可改的那些项（白名单，别的字段一律不许从网页改） */
  #editableConfig() {
    const c = this.#effectiveConfig();
    return {
      agent: {
        enabled: c.agent?.enabled,
        everyMinutes: c.agent?.everyMinutes,
        jitterMinutes: c.agent?.jitterMinutes,
        maxPerDay: c.agent?.maxPerDay,
        minPerDay: c.agent?.minPerDay,
        minGapMs: c.agent?.minGapMs,
        quietHours: c.agent?.quietHours,
        groups: c.agent?.groups,
        targets: c.agent?.targets,
        private: c.agent?.private,
        group: c.agent?.group,
        maxSteps: c.agent?.maxSteps,
        maxActionsPerRound: c.agent?.maxActionsPerRound,
        maxReplyChars: c.agent?.maxReplyChars,
        shareEveryHours: c.agent?.shareEveryHours,
        selfHoldMs: c.agent?.selfHoldMs,
        repeatThreshold: c.agent?.repeatThreshold,
        interests: c.agent?.interests,
        interestGroups: c.agent?.interestGroups,
        repeatJudge: c.agent?.repeatJudge,
        qzoneEveryHours: c.agent?.qzoneEveryHours,
        dryRun: c.agent?.dryRun,
        allowDestructive: c.agent?.allowDestructive,
      },
      chat: {
        enabled: c.chat?.enabled,
        replyOnMention: c.chat?.replyOnMention,
        replyOnReplyToMe: c.chat?.replyOnReplyToMe,
        replyPrivate: c.chat?.replyPrivate,
        aiDecide: c.chat?.aiDecide,
        aiDecideMandatory: c.chat?.aiDecideMandatory,
        followUpWindowMs: c.chat?.followUpWindowMs,
        followUpWithoutAt: c.chat?.followUpWithoutAt,
        randomInterject: c.chat?.randomInterject,
        maxReplyChars: c.chat?.maxReplyChars,
        historyChars: c.chat?.historyChars,
        recentSelfEcho: c.chat?.recentSelfEcho,
        dedupeThreshold: c.chat?.dedupeThreshold,
        quietHours: c.chat?.quietHours,
        replyInQuietHours: c.chat?.replyInQuietHours,
      },
      llm: {
        model: c.llm?.model,
        models: c.llm?.models,
        reasoningEffort: c.llm?.reasoningEffort ?? '',
        reasoningEfforts: c.llm?.reasoningEfforts ?? { chat: '', agent: '', background: '' },
        maxTokens: c.llm?.maxTokens,
        temperature: c.llm?.temperature,
      },
      share: { enabled: c.share?.enabled, interests: c.share?.interests, sources: c.share?.sources },
      dailyNews: Object.fromEntries(DAILY_NEWS_FIELDS
        .filter((key) => key in (c.dailyNews || {}) || key in DAILY_NEWS_DEFAULTS)
        .map((key) => [key, c.dailyNews?.[key] ?? DAILY_NEWS_DEFAULTS[key]])),
      persona: {
        name: c.persona?.name,
        identity: c.persona?.identity,
        style: c.persona?.style,
        likes: c.persona?.likes,
        rules: c.persona?.rules,
        source: c.persona?.source,
        systemPrompt: c.persona?.systemPrompt,
      },
    };
  }

  /**
   * 面板「全部配置」那条路：updates 是 { 'chat.vision.enabled': true, ... }。
   * 只认 schema 里的 path，按类型清洗后再深写，写完整份 config.json 重启生效。
   */
  #saveUpdates(updates) {
    if (!isObject(updates)) throw new Error('updates 必须是对象');
    const entries = Object.entries(updates);
    if (!entries.length) throw new Error('没有可改的字段');
    const 脏的 = entries.filter(([p]) => !FIELD_BY_PATH.has(p)).map(([p]) => p);
    if (脏的.length) throw new Error(`不认识的配置项：${脏的.slice(0, 5).join('、')}`);

    let next = this.#effectiveConfig();
    let changed = 0;
    for (const [path, raw] of entries) {
      const field = FIELD_BY_PATH.get(path);
      // 密钥留空 = 保持原值（面板不回显，避免一保存就把已有 key 抹掉）
      if (field.type === 'secret' && String(raw ?? '') === '') continue;
      next = setByPath(next, path, this.#coerce(field, raw));
      changed += 1;
    }
    if (!changed) throw new Error('没有实际改动');
    // 新旧两块面板共享每日资讯校验，不能从 updates 绕过时间/来源检查。
    if (entries.some(([p]) => p.startsWith('dailyNews.'))) dailyNewsPatch(next.dailyNews);
    if (entries.some(([p]) => p.startsWith('llm.'))) validateReasoningConfig(next.llm);
    this.#persistConfig(next, entries.some(([p]) => p.startsWith('persona.')));
    return { saved: entries.map(([p]) => p), changed, configPath: this.configPath, restarting: true };
  }

  /** 面板传上来的值一律当不可信输入：按字段类型转成配置里该有的形状 */
  #coerce(field, raw) {
    switch (field.type) {
      case 'bool':
        return raw === true || raw === 'true' || raw === 1 || raw === '1';
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${field.label || field.path} 需要一个数字`);
        if (field.min !== undefined && n < field.min) throw new Error(`${field.label || field.path} 不能小于 ${field.min}`);
        if (field.max !== undefined && n > field.max) throw new Error(`${field.label || field.path} 不能大于 ${field.max}`);
        return n;
      }
      case 'csv': {
        const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/);
        return list.map((x) => String(x).trim()).filter(Boolean);
      }
      case 'json': {
        if (typeof raw === 'string') {
          const text = raw.trim();
          if (!text) return [];
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(`${field.label || field.path} 不是合法的 JSON：${err.message}`);
          }
        }
        return raw ?? null;
      }
      case 'select': {
        const value = String(raw ?? '');
        const options = (field.options || []).map((o) => typeof o === 'object' ? o.value : o);
        if (!options.includes(value)) throw new Error(`${field.label || field.path} 不是可选值`);
        return value;
      }
      case 'secret': {
        const text = String(raw ?? '');
        // 空 = 别动它（面板不回显密钥，清空保存不该把已有 key 抹掉）
        return text;
      }
      default:
        return String(raw ?? '');
    }
  }

  /** 只允许改白名单里的路径，深合并后写回 config.json */
  #saveConfig(patch) {
    if (!isObject(patch)) throw new Error('配置 patch 必须是对象');
    const allowed = new Set(['agent', 'chat', 'llm', 'share', 'persona', 'dailyNews']);
    const clean = {};
    const effective = this.#effectiveConfig();
    for (const [k, v] of Object.entries(patch || {})) {
      if (!allowed.has(k)) continue;
      if (k === 'dailyNews') {
        clean.dailyNews = { ...DAILY_NEWS_DEFAULTS, ...(this.cfg.dailyNews || {}), ...dailyNewsPatch(v) };
        continue;
      }
      if (k === 'persona') {
        const src = v && typeof v === 'object' ? v : {};
        clean.persona = { ...(effective.persona || {}) };
        if ('name' in src) clean.persona.name = String(src.name || '').slice(0, 40);
        if ('identity' in src) clean.persona.identity = String(src.identity || '').slice(0, 400);
        if ('style' in src) clean.persona.style = String(src.style || '').slice(0, 400);
        if ('source' in src) clean.persona.source = String(src.source || '').slice(0, 120);
        if ('systemPrompt' in src) clean.persona.systemPrompt = String(src.systemPrompt || '');
        if (Array.isArray(src.likes)) clean.persona.likes = src.likes.map((x) => String(x).slice(0, 40)).slice(0, 30);
        if (Array.isArray(src.rules)) clean.persona.rules = src.rules.map((x) => String(x).slice(0, 200)).slice(0, 40);
        continue;
      }
      if (k === 'llm' && isObject(v)) {
        validateReasoningConfig(v);
        clean.llm = { ...(this.cfg.llm || {}), ...v };
        if (Object.hasOwn(v, 'reasoningEfforts')) clean.llm.reasoningEfforts = { ...(this.cfg.llm?.reasoningEfforts || {}), ...v.reasoningEfforts };
        continue;
      }
      clean[k] = { ...(this.cfg[k] || {}), ...(v && typeof v === 'object' ? v : {}) };
    }
    if (!Object.keys(clean).length) throw new Error('没有可改的字段');

    const next = { ...effective, ...clean };
    // 数组字段要原样保留，别被合并成对象
    for (const k of Object.keys(clean)) {
      if (!Array.isArray(clean[k]) && typeof clean[k] === 'object') next[k] = { ...(effective[k] || {}), ...clean[k] };
    }
    this.#persistConfig(next, Object.hasOwn(clean, 'persona'));
    return { saved: Object.keys(clean), configPath: this.configPath, restarting: true };
  }

  #persistConfig(next, syncPersona = false, personaOnly = false) {
    if (!this.configPath) throw new Error('不知道配置文件路径，不能保存');
    const previous = fs.readFileSync(this.configPath);
    const disk = personaOnly
      ? { ...JSON.parse(previous), persona: next.persona }
      : Object.fromEntries(Object.entries(next).filter(([k]) => !k.startsWith('__')));
    // Same-directory rename preserves complete JSON and the existing private file mode.
    const tmp = `${this.configPath}.${process.pid}.pending`;
    const mode = fs.statSync(this.configPath).mode & 0o777;
    try {
      fs.writeFileSync(tmp, JSON.stringify(disk, null, 2) + '\n', { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, this.configPath);
      try {
        if (syncPersona) this.bot.store?.setPersona(next.persona);
      } catch (error) {
        fs.writeFileSync(tmp, previous, { mode });
        fs.renameSync(tmp, this.configPath);
        throw error;
      }
      this.cfg = next;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  #authorized(req, url) {
    const token = this.cfg.control.token;
    if (!token) return true;
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    return url.searchParams.get('token') === token || bearer === token;
  }

  #json(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(body);
  }

  async #readBody(req) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) throw new Error('请求体过大');
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  }

  #handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const client = { res };
    this.sseClients.add(client);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(ping);
      this.sseClients.delete(client);
    });
  }

  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.res.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  async listen() {
    const { host, port } = this.cfg.control;
    this.server = http.createServer((req, res) => {
      this.#route(req, res).catch((err) => {
        this.log.error('控制台请求异常：', err?.stack || err);
        if (!res.headersSent) this.#json(res, 500, { ok: false, error: err.message });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolve);
    });
    this.log.info(`控制台已启动：http://${host}:${port}${this.cfg.control.token ? '?token=***' : ''}`);
    return this;
  }

  async close() {
    for (const c of this.sseClients) {
      try {
        c.res.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }

  async #route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathName = url.pathname;

    if (req.method === 'OPTIONS') return this.#json(res, 204, {});
    if (pathName === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(DASHBOARD);
    }
    if (!pathName.startsWith('/api/')) {
      return this.#json(res, 404, { ok: false, error: 'not found' });
    }
    if (!this.#authorized(req, url)) return this.#json(res, 401, { ok: false, error: 'token 不正确' });

    if (pathName === '/api/status' && req.method === 'GET') {
      const status = this.bot.refreshStatus ? await this.bot.refreshStatus() : this.bot.status();
      return this.#json(res, 200, { ok: true, ...status });
    }

    if (pathName === '/api/daily-news' && req.method === 'GET') {
      const status = this.dailyNews?.status() ?? null;
      const logFile = this.cfg.storage?.dataDir ? path.join(this.cfg.storage.dataDir, 'daily-news-log.jsonl') : null;
      return this.#json(res, 200, { ok: true, dailyNews: status && { ...status, recentEvents: recentDailyNewsEvents(logFile) } });
    }

    if (pathName === '/api/groups' && req.method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1';
      const groups = refresh ? await this.bot.refreshGroups() : [...this.bot.groups.values()];
      return this.#json(res, 200, { ok: true, groups, freshness: this.bot.freshness?.groups || null });
    }

    if (pathName === '/api/friends' && req.method === 'GET') {
      try {
        const list = await this.bot.onebot.call('get_friend_list', {});
        const arr = Array.isArray(list) ? list : [];
        return this.#json(res, 200, {
          ok: true,
          friends: arr.map((f) => ({
            user_id: f.user_id ?? f.uin,
            nickname: f.nickname || f.remark || String(f.user_id ?? ''),
            remark: f.remark || '',
          })),
        });
      } catch (err) {
        return this.#json(res, 200, { ok: false, friends: [], error: err.message });
      }
    }

    if (pathName === '/api/scopes' && req.method === 'GET') {
      // 只认真正的会话名（group:/private:），history 目录里的 agent-log、decisions 不是会话
      const scopes = this.bot.store.listScopes().filter((s) => /^(group|private):/.test(String(s?.scope || s)));
      return this.#json(res, 200, { ok: true, scopes });
    }

    if (pathName === '/api/messages' && req.method === 'GET') {
      const scope = url.searchParams.get('scope');
      const limit = Number(url.searchParams.get('limit') || 20);
      if (!scope) return this.#json(res, 400, { ok: false, error: '缺少 scope' });
      try {
        const rows = this.bot.recent(scope, Math.min(limit, 200));
        return this.#json(res, 200, rows);
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/interject' && req.method === 'POST') {
      const body = await this.#readBody(req);
      const useAgent = Boolean(this.cfg.agent?.enabled);
      if (useAgent && !this.agent) return this.#json(res, 400, { ok: false, error: '自主决策模块没启动' });
      if (!useAgent && !this.interject) return this.#json(res, 400, { ok: false, error: '定时插嘴模块没启动' });
      try {
        const scope = body.scope || (body.groupId ? `group:${body.groupId}` : null);
        // 自主模式必须走同一个执行器，继承 agent 的演练与记账护栏。
        const result = useAgent
          ? scope
            ? await this.agent.act(String(scope), { force: true, mode: 'speak' })
            : await this.agent.tick({ force: true, mode: 'speak' })
          : scope
            ? await this.interject.say(String(scope), { force: true })
            : await this.interject.tick({ force: true });
        return this.#json(res, 200, result);
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/share' && req.method === 'POST') {
      const body = await this.#readBody(req);
      const useAgent = Boolean(this.cfg.agent?.enabled);
      if (useAgent && !this.agent) return this.#json(res, 400, { ok: false, error: '自主决策模块没启动' });
      if (!useAgent && !this.share) return this.#json(res, 400, { ok: false, error: '主动分享模块没启动' });
      try {
        const scope = body.scope || (body.groupId ? `group:${body.groupId}` : null);
        const result = useAgent
          ? scope
            ? await this.agent.act(String(scope), { force: true, mode: 'share' })
            : await this.agent.tick({ force: true, mode: 'share' })
          : scope
            ? await this.share.share(String(scope), { force: true })
            : await this.share.tick({ force: true });
        return this.#json(res, 200, { ok: true, ...result });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/agent' && req.method === 'POST') {
      const body = await this.#readBody(req);
      if (!this.agent) return this.#json(res, 400, { ok: false, error: '自主决策模块没启动' });
      try {
        const scope = body.scope || (body.groupId ? `group:${body.groupId}` : null);
        const mode = body.mode ? String(body.mode) : null;
        const dry = body.dry === true;
        const saved = this.agent.cfg.dryRun;
        if (dry) this.agent.cfg.dryRun = true; // 演练：生成/决策都跑，但不真发
        let result;
        try {
          result = scope ? await this.agent.act(String(scope), { force: true, mode }) : await this.agent.tick({ force: true, mode });
        } finally {
          this.agent.cfg.dryRun = saved;
        }
        return this.#json(res, 200, result);
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/send' && req.method === 'POST') {
      const body = await this.#readBody(req);
      if (!body.scope) return this.#json(res, 400, { ok: false, error: '缺少 scope' });
      try {
        const messageId = await this.bot.send(body.scope, body.text ?? body.message ?? '', { quote: body.quote });
        return this.#json(res, 200, { ok: true, messageId });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/draw' && req.method === 'POST') {
      const body = await this.#readBody(req);
      const scope = String(body.scope || '');
      const prompt = String(body.prompt || '').trim();
      if (!scope) return this.#json(res, 400, { ok: false, error: '缺少 scope' });
      if (!prompt) return this.#json(res, 400, { ok: false, error: '缺少 prompt（要画什么）' });
      if (this.cfg.image?.enabled === false) return this.#json(res, 400, { ok: false, error: '生图没开（image.enabled=false）' });
      // 生成要一两分钟，别让调用方干等：先回执，画完自己发出去
      const dataDir = this.cfg.storage?.dataDir || 'data';
      this.log.info(`开始画图（${scope}）：${prompt.slice(0, 40)}`);
      void (async () => {
        let file = null;
        try {
          const { generateImage } = await import('./imagegen.mjs');
          const { refinePrompt } = await import('./promptbrain.mjs');
          const refined = await refinePrompt(this.bot?.brain, prompt, { cfg: this.cfg, log: this.log });
          if (refined.refined && refined.prompt !== prompt) this.log.info(`副脑改写了画图描述：${prompt.slice(0, 40)} → ${refined.prompt.slice(0, 60)}`);
          else if (!refined.refined) this.log.warn(`副脑这次没用上，照原句画：${prompt.slice(0, 40)}`);
          const img = await generateImage(refined.prompt || prompt, { cfg: this.cfg, dataDir, log: this.log });
          file = img.file;
          const id = await this.bot.sendImage(scope, file, { caption: String(body.text || '').trim() });
          this.log.info(id != null ? `画完发出去了（${scope}，${Math.round(img.ms / 1000)}s）` : '画好了但没发出去');
        } catch (err) {
          this.log.warn(`画图失败：${err.message}`);
        } finally {
          if (file) fs.rmSync(file, { force: true });
        }
      })();
      return this.#json(res, 202, { ok: true, accepted: true, note: '画着呢，一两分钟后会把图发到那个会话里' });
    }

    if (pathName === '/api/mention' && req.method === 'POST') {
      // 发一条「@某人 + 文本」，方便在群里点名
      const body = await this.#readBody(req);
      if (!body.scope || !body.qq) return this.#json(res, 400, { ok: false, error: '需要 scope 和 qq' });
      try {
        const seg = [this.bot.mentionSegment(body.qq, body.name), { type: 'text', data: { text: ` ${body.text || ''}` } }];
        const messageId = await this.bot.sendAt(body.scope, seg);
        return this.#json(res, 200, { ok: true, messageId });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/raw' && req.method === 'POST') {
      // 逃生舱：直接调用任意 OneBot 动作，用来做本程序没封装的操作
      const body = await this.#readBody(req);
      if (!body.action) return this.#json(res, 400, { ok: false, error: '缺少 action' });
      try {
        const data = await this.bot.onebot.call(String(body.action), body.params || {});
        return this.#json(res, 200, { ok: true, data });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message, retcode: err.retcode });
      }
    }

    if (pathName === '/api/autochat' && req.method === 'GET') {
      const scope = url.searchParams.get('scope');
      if (!scope) return this.#json(res, 400, { ok: false, error: '缺少 scope' });
      try {
        return this.#json(res, 200, { ok: true, ...this.bot.getAutochat(scope) });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/autochat' && req.method === 'POST') {
      const body = await this.#readBody(req);
      if (!body.scope) return this.#json(res, 400, { ok: false, error: '缺少 scope' });
      try {
        const state = this.bot.setAutochat(body.scope, body.enabled !== false);
        const status = this.bot.getAutochat(body.scope);
        this.broadcast({ type: 'admin', scope: body.scope, action: body.enabled ? 'unmute' : 'mute', at: Date.now() });
        return this.#json(res, 200, { ok: true, ...state, ...status });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/persona/evolve' && req.method === 'GET') {
      return this.#json(res, 200, { ok: true, ...(this.personaEvolve?.status?.() || { enabled: false, count: 0, history: [] }) });
    }

    if (pathName === '/api/persona/evolve' && req.method === 'POST') {
      if (!this.personaEvolve) return this.#json(res, 400, { ok: false, error: '人格微调没启动' });
      const body = await this.#readBody(req);
      try {
        if (String(body.op || '') === 'undo') {
          const r = this.personaEvolve.undo(String(body.id || ''));
          return this.#json(res, r.ok === false ? 400 : 200, { ...r, status: this.personaEvolve.status() });
        }
        const r = await this.personaEvolve.maybeEvolve({ notes: this.learn?.top?.(10) || [], force: true });
        return this.#json(res, 200, { ...r, status: this.personaEvolve.status() });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/persona' && req.method === 'GET') {
      return this.#json(res, 200, { ok: true, persona: this.bot.store.persona() || this.cfg.persona });
    }

    if (pathName === '/api/persona' && req.method === 'POST') {
      const body = await this.#readBody(req);
      const patch = Object.hasOwn(body, 'persona') ? body.persona : body;
      if (!isObject(patch) || (!patch.name && !patch.style)) {
        return this.#json(res, 400, { ok: false, error: '人设至少要有 name 或 style' });
      }
      // Tool edits are partial: retain the imported full prompt, examples and flags.
      const persona = { ...(this.#effectiveConfig().persona || {}), ...patch };
      this.#persistConfig({ ...this.cfg, persona }, true, true);
      this.log.info('人设已更新');
      return this.#json(res, 200, { ok: true, persona });
    }

    if (pathName === '/api/kb' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const q = url.searchParams.get('q') || url.searchParams.get('search') || '';
      const limit = Number(url.searchParams.get('limit') || 20);
      if (!this.kb) return this.#json(res, 200, { ok: false, error: '梗库没接上' });
      return this.#json(res, 200, {
        ok: true,
        stats: this.kb.stats(),
        items: q ? this.kb.search(q, { limit }) : this.kb.all().slice(0, limit),
      });
    }

    if (pathName === '/api/kb/scan' && req.method === 'POST') {
      if (!this.kbScan) return this.#json(res, 400, { ok: false, error: '梗库扫描没接上' });
      const out = await this.kbScan.run({ force: true, reason: 'api' });
      return this.#json(res, 200, { ok: !out?.skipped, ...out });
    }

    if (pathName === '/api/decisions' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const limit = Number(url.searchParams.get('limit') || 40);
      const scope = url.searchParams.get('scope') || '';
      return this.#json(res, 200, {
        ok: true,
        today: this.decisions?.summary({ scope }) || { reasons: [], acted: 0, silent: 0 },
        recent: this.decisions?.recent({ limit, scope }) || [],
      });
    }

    if (pathName === '/api/memes') {
      if (req.method === 'GET') {
        const lib = this.bot?.memes;
        if (!lib) {
          this.#json(res, 400, { ok: false, error: '图库没接上' });
          return;
        }
        const q = String(url.searchParams.get('q') || '');
        const tag = String(url.searchParams.get('tag') || '');
        const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20);
        const rows = lib.list({ q, tag, limit });
        this.#json(res, 200, { ok: true, packs: lib.packsList().map((p) => p.id), total: rows.length, memes: rows });
        return;
      }
      if (req.method === 'POST') {
        const body = await this.#readBody(req);
        const scope = String(body.scope || '');
        const keyword = String(body.keyword || '').trim();
        if (!scope || !keyword) {
          this.#json(res, 400, { ok: false, error: 'scope 和 keyword 都要给' });
          return;
        }
        const picked = this.bot?.memes?.pick(keyword, { tag: String(body.tag || '') });
        if (!picked) {
          this.#json(res, 404, { ok: false, error: `图库里没有和「${keyword}」对得上的` });
          return;
        }
        const id = await this.bot.sendImage(scope, picked.file, { caption: picked.caption });
        this.#json(res, 200, { ok: id != null, messageId: id, caption: picked.caption, tag: picked.tag });
        return;
      }
    }

    if (pathName === '/api/people' && req.method === 'GET') {
      const rows = (this.people?.list?.() || []).map((p) => ({
        uin: p.uin,
        name: p.names?.[0] || p.uin,
        names: p.names || [],
        msgs: p.msgs || 0,
        lastSeen: p.lastSeen || 0,
        learnings: p.learnings || 0,
        summary: p.summary || '',
        style: p.style || '',
        facts: p.facts || [],
        pending: (p.pending || []).length,
      }));
      return this.#json(res, 200, { ok: true, people: rows });
    }

    if (pathName === '/api/people/learn' && req.method === 'POST') {
      const body = await this.#readBody(req);
      const uin = body.uin || body.qq || body.userId;
      if (!uin) return this.#json(res, 400, { ok: false, error: '缺 uin' });
      const r = await this.people?.learn?.(String(uin), { force: body.force !== false });
      return this.#json(res, 200, r || { ok: false, error: 'people 没接上' });
    }

    if (pathName === '/api/qzone' && req.method === 'GET') {
      if (!this.qzone) return this.#json(res, 400, { ok: false, error: '空间社交没启动' });
      const quota = this.qzone.quota();
      const replies = await this.qzone.pendingReplies({ posts: 4 });
      const feeds = await this.qzone.friendFeeds({ count: 20 });
      return this.#json(res, 200, { ok: true, quota, replies, feeds });
    }

    if (pathName === '/api/qzone' && req.method === 'POST') {
      if (!this.qzone) return this.#json(res, 400, { ok: false, error: '空间社交没启动' });
      const body = await this.#readBody(req);
      const op = String(body.op || '');
      try {
        if (op === 'reply') {
          const r = await this.qzone.replyToComment({
            tid: String(body.tid || ''),
            commentId: String(body.comment_id || ''),
            commentUin: Number(body.comment_uin) || 0,
            replyUin: body.reply_uin ? Number(body.reply_uin) : null,
            replyName: body.reply_name ? String(body.reply_name) : null,
            content: String(body.content || ''),
          });
          return this.#json(res, 200, { ok: true, ...r });
        }
        if (op === 'comment') {
          const r = await this.qzone.commentPost({
            tid: String(body.tid || ''),
            targetUin: Number(body.target_uin) || 0,
            content: String(body.content || ''),
          });
          return this.#json(res, 200, { ok: true, ...r });
        }
        return this.#json(res, 400, { ok: false, error: 'op 只能是 reply / comment' });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/social' && req.method === 'GET') {
      if (!this.social) return this.#json(res, 400, { ok: false, error: '视频社交没启动' });
      const status = await this.social.status();
      const acted = Object.entries(this.social.state?.acted || {})
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, 12);
      return this.#json(res, 200, { ok: true, ...status, acted });
    }

    if (pathName === '/api/social' && req.method === 'POST') {
      if (!this.social) return this.#json(res, 400, { ok: false, error: '视频社交没启动' });
      const body = await this.#readBody(req);
      const op = String(body.op || '');
      try {
        if (op === 'tick') {
          const r = await this.social.tick({ force: body.force === true });
          return this.#json(res, 200, { ok: r.ok !== false, ...r });
        }
        if (op === 'login') {
          const qr = await this.social.loginStart();
          return this.#json(res, 200, { ok: true, ...qr });
        }
        if (op === 'logout') {
          this.social.bili.setCookie('');
          return this.#json(res, 200, { ok: true });
        }
        if (op === 'check') {
          const r = await this.social.checkReplies({ max: 12 });
          return this.#json(res, 200, { ok: true, ...r, replies: this.social.recentReplies({ limit: 5 }) });
        }
        if (op === 'quota') {
          const updates = {};
          if (body.commentPerDay !== undefined) {
            const n = Number(body.commentPerDay);
            if (!Number.isFinite(n)) throw new Error('commentPerDay 需要数字');
            updates['social.commentPerDay'] = Math.max(0, Math.min(50, Math.trunc(n)));
          }
          if (body.likePerDay !== undefined) {
            const n = Number(body.likePerDay);
            if (!Number.isFinite(n)) throw new Error('likePerDay 需要数字');
            updates['social.likePerDay'] = Math.max(0, Math.min(100, Math.trunc(n)));
          }
          if (!Object.keys(updates).length) throw new Error('没有要改的额度');
          const saved = this.#saveUpdates(updates);
          // 面板保存的是整份配置，SocialHub 手里的旧 cfg 也要跟着换，额度立即生效
          this.social.cfg = this.cfg.social || this.social.cfg;
          return this.#json(res, 200, { ok: true, ...saved, quota: this.social.quota() });
        }
        if (op === 'learn') {
          const r = await this.social.learnFromFeed({ force: true });
          return this.#json(res, 200, { ok: r.ok !== false, ...r });
        }
        if (op === 'act') {
          const r = await this.social.act({
            action: String(body.action || ''),
            aid: String(body.aid || ''),
            text: String(body.text || ''),
            replyTo: body.reply_to ? String(body.reply_to) : '',
          });
          return this.#json(res, 200, { ok: true, ...r });
        }
        return this.#json(res, 400, { ok: false, error: 'op 只能是 tick / check / login / logout / act / quota / learn' });
      } catch (err) {
        return this.#json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathName === '/api/learn' && req.method === 'GET') {
      return this.#json(res, 200, {
        ok: true,
        stats: this.learn?.stats?.() || null,
        notes: this.learn?.top?.(Number(url.searchParams.get('limit')) || 30) || [],
      });
    }

    if (pathName === '/api/learn/search' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      const scope = String(url.searchParams.get('scope') || '').trim();
      const k = Math.min(20, Math.max(1, Number(url.searchParams.get('k')) || 6));
      if (!q) return this.#json(res, 400, { ok: false, error: 'q 不能为空' });
      const [notes, messages] = await Promise.all([
        this.learn?.searchSmart ? this.learn.searchSmart(q, { scope, k }) : this.learn?.search?.(q, { scope, k }) || [],
        this.learn?.searchMessagesSmart
          ? this.learn.searchMessagesSmart(q, { scope, k })
          : this.learn?.searchMessages?.(q, { scope, k }) || [],
      ]);
      return this.#json(res, 200, { ok: true, semantic: Boolean(this.learn?.semanticReady), notes, messages });
    }

    if (pathName === '/api/learn' && req.method === 'POST') {
      if (!this.learner) return this.#json(res, 400, { ok: false, error: '学习模块没启动' });
      const body = await this.#readBody(req);
      const topic = String(body.topic || '').trim();
      if (topic) {
        const r = await this.learner.learnTopic(topic);
        return this.#json(res, 200, { ok: r.ok !== false, ...r });
      }
      if (body.embed) {
        const r = await this.learn?.embedPending?.({ limit: Number(body.limit) || 400 });
        return this.#json(res, 200, { ok: true, ...r, stats: this.learn?.stats?.() });
      }
      if (body.backfill) {
        const r = await this.learner.backfill({ distill: body.distill !== false });
        return this.#json(res, 200, { ok: true, ...r, stats: this.learn?.stats?.() });
      }
      const r = await this.learner.run({ force: true });
      return this.#json(res, 200, { ok: r.ok !== false, ...r, stats: this.learn?.stats?.() });
    }

    if (pathName === '/api/config' && req.method === 'GET') {
      return this.#json(res, 200, {
        ok: true,
        editable: this.#editableConfig(),
        schema: this.#schemaView(),
        configPath: this.configPath,
      });
    }

    if (pathName === '/api/config' && req.method === 'POST') {
      try {
        const body = await this.#readBody(req);
        if (!isObject(body)) throw new Error('配置请求必须是对象');
        const result = Object.hasOwn(body, 'updates')
          ? this.#saveUpdates(body.updates)
          : this.#saveConfig(Object.hasOwn(body, 'patch') ? body.patch : body);
        this.#json(res, 200, { ok: true, ...result });
        // 配置是启动时读的，改完必须重启进程才生效（systemd 会立刻拉起来）
        setTimeout(() => process.exit(0), 400);
      } catch (err) {
        this.#json(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (pathName === '/api/events' && req.method === 'GET') {
      return this.#handleSse(req, res);
    }

    return this.#json(res, 404, { ok: false, error: `未知接口 ${pathName}` });
  }
}

export { DASHBOARD };
