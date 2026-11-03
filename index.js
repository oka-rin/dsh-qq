// dsh-qq — 一个包管完 QQ 机器人
//
// 这个插件同时做四件事：
//   1. 管进程：按配置拉起/重启 snowluma-qq 本体（包内自带 bot/，也可指向已有目录）
//   2. 管数据：把控制台 API + 本地账本聚合成面板要的 JSON
//   3. 管工具：把 qq_* 整套操作注册成原生工具，模型直接可调（不再经 MCP 子进程）
//   4. 管界面：设置里的「QQ 机器人」面板（总览 / 对话 / 运维）
//
// 所有写操作都走 snowluma-qq 自己的控制台 API，这里不直接碰 OneBot。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createBotManager, command } from './runtime.js';
import { createSetup, nativeStatus, nativeServiceArgs } from './setup.js';
import { createLogin } from './login.js';
import { createDesktop } from './desktop.js';
import { registerLoginHttp } from './login-http.js';
import { createOriginalLogin, originalRedirect } from './original-login.js';
import { fileURLToPath } from 'node:url';

import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TOOLS, makeCallTool } from './bot/src/tools.mjs';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

const DEFAULTS = {
  dataDir: '',
  botDir: '',
  manageBot: true,
  controlUrl: '',
  autoRestart: true,
  restartDelayMs: 3000,
  logLines: 400,
  snowLumaComposeFile: '',
  snowLumaContainer: 'snowluma',
  snowLumaMode: 'native',
  snowLumaService: 'snowluma.target',
  snowLumaServiceScope: 'system',
  snowLumaDisplay: ':99',
  snowLumaXauthority: '/var/lib/snowluma/.Xauthority',
};

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function tailLines(file, n) {
  try {
    const text = /\.gz$/.test(file) ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function kindOf(row) {
  const k = String(row?.kind || 'none');
  if (k === 'speak' || k === 'share' || k === 'qzone' || k === 'skip') return k;
  return 'none';
}

function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 把 MCP 的 inputSchema 转成 defineTool 的 parameters 规格 */
function toParamSpec(inputSchema) {
  const props = inputSchema?.properties || {};
  const required = new Set(inputSchema?.required || []);
  const out = {};
  const conv = (def) => {
    if (!def || typeof def !== 'object') return { type: 'string' };
    const node = { ...def };
    if (node.type === 'object' || node.properties) node.additionalProperties = def.additionalProperties ?? true;
    if (Array.isArray(node.oneOf)) node.oneOf = node.oneOf.map(conv);
    if (node.items) node.items = conv(node.items);
    if (node.properties) {
      const req = new Set(node.required || []);
      node.properties = Object.fromEntries(
        Object.entries(node.properties).map(([k, v]) => [k, { ...conv(v), ...(req.has(k) ? { required: true } : {}) }]),
      );
      delete node.required;
      if (!node.type) node.type = 'object';
    }
    if (!node.type && !node.oneOf) node.type = 'string';
    return node;
  };
  for (const [key, def] of Object.entries(props)) {
    out[key] = { ...conv(def), ...(required.has(key) ? { required: true } : {}) };
  }
  return out;
}

export const Config = Schema.object({
  dataDir: Schema.string().default('').description('机器人配置和持久数据根目录；升级插件不覆盖此处'),
  botDir: Schema.string().default('').description('留空使用插件内置机器人代码；可选外部代码目录'),
  manageBot: Schema.boolean().default(true).description('托管机器人进程；检测到外部实例时只连接'),
  controlUrl: Schema.string().default('').description('留空从机器人配置读取控制台地址'),
  autoRestart: Schema.boolean().default(true).description('托管进程意外退出时自动拉起'),
  restartDelayMs: Schema.number().min(500).default(3000).description('自动重启间隔（毫秒）'),
  logLines: Schema.number().min(20).max(5000).default(400).description('内存日志保留行数'),
  snowLumaMode: Schema.union(['native', 'docker', 'external']).default('native').description('默认接入宿主机原版；Docker 仅兼容已有部署，external 只连接不启停'),
  snowLumaService: Schema.string().default('snowluma.target').description('已由操作者安装的原生 systemd 服务或 target；不会自动创建服务'),
  snowLumaServiceScope: Schema.union(['system', 'user']).default('system').description('原生 systemd 服务范围'),
  snowLumaComposeFile: Schema.string().default('').description('兼容模式：SnowLuma compose 文件绝对路径；不会自动启动网关'),
  snowLumaContainer: Schema.string().default('snowluma').description('用于查看状态及启停的 Docker 容器名称'),
  snowLumaDisplay: Schema.string().default(':99').description('原生 QQ 本机 X11 显示编号；网页登录仅连接核实归属的 QQ 窗口'),
  snowLumaXauthority: Schema.string().default('/var/lib/snowluma/.Xauthority').description('原生 QQ Xauthority 绝对路径；文件缺失时拒绝访问，仅无认证的旧专用显示可显式留空'),
});

export const name = 'dsh-qq';
export const inject = ['webServer', 'tools', 'connection'];

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const dataDir = path.resolve(cfg.dataDir || path.join(defaultDshHome(), 'storage', 'dsh-qq'));
  const botDir = path.resolve(cfg.botDir || path.join(PKG_DIR, 'bot'));
  const configPath = path.join(dataDir, 'config.json');
  const storageDir = () => path.resolve(dataDir, readBotConfig().storage?.dataDir || 'data');
  const historyDir = () => path.join(storageDir(), 'history');
  const memoryDir = () => path.join(storageDir(), 'memory');

  const readBotConfig = () => readJson(configPath, {}) || {};

  const controlBase = () => {
    if (cfg.controlUrl) return String(cfg.controlUrl).replace(/\/+$/, '');
    const c = readBotConfig().control || {};
    return `http://${c.host || '127.0.0.1'}:${c.port || 8787}`;
  };
  const controlToken = () => String(readBotConfig()?.control?.token || '');

  // ── 机器人进程 ──────────────────────────────────────────────

  const logs = [];
  let manager;
  const streams = new Set();

  const pushLog = (line) => {
    for (const raw of String(line).split('\n')) {
      if (!raw.trim()) continue;
      logs.push(`${new Date().toISOString().slice(11, 19)} ${raw}`);
    }
    while (logs.length > Number(cfg.logLines || 400)) logs.shift();
  };

  const ensureDataDir = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(configPath)) return false;
    const example = path.join(botDir, 'config.example.json');
    const seed = readJson(example, null);
    if (!seed) return false;
    seed.storage = { ...(seed.storage || {}), dataDir: 'data' };
    fs.writeFileSync(configPath, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return true;
  };

  const probeControl = async () => {
    try { const r = await api('/api/status'); return r?.ok === true && Boolean(r.status || r.self || r.account || r.running !== undefined || r.model || r.uptimeMs !== undefined); }
    catch { return false; }
  };
  // Manager is initialized after api exists; no async probe can outlive disposal.
  const spawnBot = () => manager.start();
  const stopBot = () => manager.dispose();
  const restartBot = () => manager.restart();

  // ── 控制台 API ─────────────────────────────────────────────

  async function control(base, pathName, init) {
    const token = controlToken();
    const url = base.replace(/\/$/, '') + pathName + (token ? `${pathName.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : '');
    const request = { ...init };
    if (request.body && typeof request.body === 'object') {
      request.body = JSON.stringify(request.body);
      request.headers = { ...request.headers, 'content-type': 'application/json' };
    }
    let res;
    try { res = await fetch(url, { ...request, signal: AbortSignal.timeout(request.method === 'POST' ? 240_000 : 8000) }); }
    catch (err) {
      if (request.method === 'POST') throw new Error(`请求未能确认结果，后台可能仍在执行；先查看最近动作，不要立即重试。${err.message}`);
      throw err;
    }
    const text = await res.text();
    let out;
    try { out = JSON.parse(text); } catch { throw new Error(`控制台返回的不是 JSON（${res.status}）`); }
    if (!res.ok || out?.ok === false) throw new Error(out?.error || `控制台 HTTP ${res.status}`);
    return out;
  }

  const api = (pathName, init) => control(controlBase(), pathName, init);
  const rawAction = async (action, params = {}) => {
    const r = await api('/api/raw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, params }) });
    return r?.data ?? r;
  };

  manager = createBotManager({ enabled: cfg.manageBot, entry: path.join(botDir, 'src', 'index.mjs'), cwd: dataDir,
    env: { ...process.env, QQ_CONFIG: configPath }, probe: probeControl, initialize: ensureDataDir, log: pushLog,
    autoRestart: cfg.autoRestart, restartDelayMs: cfg.restartDelayMs });
  const botState = manager.state;

  // 群列表缓存：面板刷新别每次都打 QQ
  let groupsCache = { at: 0, data: null };
  async function freshGroups() {
    if (groupsCache.data && Date.now() - groupsCache.at < 60_000) return groupsCache.data;
    const r = await api('/api/groups?refresh=1').catch(() => null);
    if (r?.ok) {
      groupsCache = { at: Date.now(), data: r };
      return r;
    }
    return groupsCache.data || { ok: false, groups: [] };
  }

  const readAgentLog = (limit = 200) =>
    tailLines(path.join(historyDir(), 'agent-log.jsonl'), limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  const summarize = () => {
    const rows = readAgentLog(2000);
    const since = startOfToday();
    const today = { speak: 0, share: 0, qzone: 0, skip: 0, none: 0 };
    const last24 = { speak: 0, share: 0, qzone: 0, skip: 0, none: 0 };
    for (const r of rows) {
      if (r.dry || r.ok === false) continue;
      const t = Number(r.at) || 0;
      if (t >= since) today[kindOf(r)] += 1;
      if (t >= Date.now() - 24 * 3600_000) last24[kindOf(r)] += 1;
    }
    return { today, last24, total: rows.length };
  };

  const readMemory = () =>
    listDir(memoryDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const m = readJson(path.join(memoryDir(), f), null);
        if (!m) return null;
        return {
          scope: m.scope || f.replace(/\.json$/, ''),
          summary: m.summary || '',
          facts: Array.isArray(m.facts) ? m.facts.length : 0,
          updatedAt: m.updatedAt || null,
        };
      })
      .filter(Boolean);

  const readArchive = () => {
    const out = new Map();
    for (const f of listDir(historyDir())) {
      if (!/\.jsonl(\.gz)?$/.test(f) || f === 'agent-log.jsonl') continue;
      const scope = f.replace(/\.jsonl(\.gz)?$/, '').replace(/\.\d{8}-\d{6}(-\d+)?$/, '');
      const abs = path.join(historyDir(), f);
      let lines = 0;
      let bytes = 0;
      try {
        bytes = fs.statSync(abs).size;
        lines = tailLines(abs, 1_000_000).length;
      } catch {
        /* 读不到就当 0 */
      }
      const cur = out.get(scope) || { scope, lines: 0, bytes: 0, segments: 0 };
      cur.lines += lines;
      cur.bytes += bytes;
      cur.segments += 1;
      out.set(scope, cur);
    }
    return [...out.values()].sort((a, b) => b.lines - a.lines);
  };

  const readMessages = (scope, limit = 30) => {
    const base = path.join(historyDir(), String(scope).replace(/[:\\/]/g, '_'));
    const rows = [];
    for (const line of tailLines(`${base}.jsonl`, limit)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* 跳过坏行 */
      }
    }
    if (rows.length < limit) {
      const archives = listDir(historyDir())
        .filter((f) => f.startsWith(path.basename(base) + '.') && f.endsWith('.jsonl.gz'))
        .sort()
        .reverse();
      for (const f of archives) {
        for (const line of tailLines(path.join(historyDir(), f), limit - rows.length)) {
          try {
            rows.push(JSON.parse(line));
          } catch {
            /* 跳过坏行 */
          }
        }
        if (rows.length >= limit) break;
      }
    }
    return rows.sort((a, b) => Number(a.ts || a.at) - Number(b.ts || b.at)).slice(-limit).map((r) => ({
      at: r.ts || r.at || null,
      role: r.role || 'user',
      name: r.name || '',
      text: String(r.text ?? r.content ?? ''),
    }));
  };

  // ── 面板数据 ───────────────────────────────────────────────

  const overview = async (url) => {
    const botCfg = readBotConfig();
    const scope = url.searchParams.get('scope') || '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 200);

    const [status, groups, friends, scopes, editable, people, decisions, dailyNews] = await Promise.all([
      api('/api/status').catch((e) => ({ ok: false, error: String(e?.message || e) })),
      freshGroups().catch(() => ({ ok: false, groups: [] })),
      api('/api/friends').catch(() => ({ ok: false, friends: [] })),
      api('/api/scopes').catch(() => ({ ok: false, scopes: [] })),
      api('/api/config').catch(() => ({ ok: false, editable: null })),
      api('/api/people').catch(() => ({ ok: false, people: [] })),
      api('/api/decisions?limit=25').catch(() => ({ ok: false, recent: [], today: null })),
      api('/api/daily-news').catch((e) => ({ ok: false, error: String(e?.message || e) })),
    ]);

    return {
      ok: true,
      now: Date.now(),
      control: { base: controlBase(), reachable: status?.ok !== false, managed: Boolean(cfg.manageBot) },
      bot: {
        managed: Boolean(cfg.manageBot),
        childPid: botState.child?.pid || null,
        startedAt: botState.startedAt || null,
        restarts: botState.restarts,
        lastExit: botState.lastExit,
        logs: logs.slice(-120),
      },
      status,
      groups: groups?.groups || groups?.data || [],
      friends: friends?.friends || [],
      scopes: scopes?.scopes || [],
      agent: botCfg.agent || {},
      share: botCfg.share || {},
      chat: { enabled: botCfg.chat?.enabled, vision: botCfg.chat?.vision || {} },
      llm: { model: botCfg.llm?.model, models: botCfg.llm?.models || {}, mode: botCfg.llm?.mode },
      counts: summarize(),
      recent: readAgentLog(limit).reverse(),
      memory: readMemory(),
      archive: readArchive(),
      editable: editable?.editable || null,
      configSchema: editable?.schema || null,
      people: people?.people || [],
      decisions: { recent: decisions?.recent || [], today: decisions?.today || null },
      dailyNews: dailyNews?.ok === true ? dailyNews.dailyNews : null,
      dailyNewsError: dailyNews?.ok === true ? null : dailyNews?.error || '读不到资讯订阅状态',
      messages: scope ? readMessages(scope, limit) : [],
      scope,
    };
  };

  const readBody = async (req) => {
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('请求体超过 1MB'); }
    try {
      return JSON.parse(body || '{}');
    } catch {
      throw new Error('请求体必须是有效 JSON');
    }
  };

  const json = (res, o) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(o));
  };

  const route = (pathName, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: pathName,
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          try {
            await handler(req, res, url);
          } catch (error) {
            json(res, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    );

  route('/dsh-qq/overview', async (req, res, url) => json(res, await overview(url)));

  route('/dsh-qq/act', async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' });
    const body = await readBody(req);
    const kind = String(body.kind || '');
    const map = {
      share: { path: '/api/share', payload: { groupId: body.groupId } },
      qzone: { path: '/api/agent', payload: { mode: 'qzone' } },
      speak: { path: '/api/agent', payload: { mode: 'speak' } },
      agent: { path: '/api/agent', payload: {} },
    };
    const hit = map[kind];
    if (!hit) return json(res, { ok: false, error: `不认识的按钮：${kind}` });
    const out = await api(hit.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hit.payload),
    });
    json(res, { ok: out?.ok !== false, kind, result: out });
  });

  route('/dsh-qq/config', async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' });
    const body = await readBody(req);
    const out = await api('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.updates ? { updates: body.updates } : { patch: body.patch || {} }),
    });
    json(res, { ok: out?.ok !== false, result: out });
  });

  route('/dsh-qq/models', async (req, res) => {
    try {
      const botCfg = readBotConfig();
      const baseUrl = String(botCfg?.llm?.baseUrl || '').replace(/\/$/, '');
      const envName = botCfg?.llm?.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
      let key = botCfg?.llm?.apiKey || process.env[envName] || '';
      if (!key) {
        try {
          const env = fs.readFileSync(path.join(dataDir, '.env'), 'utf8');
          const line = env.split('\n').find((l) => l.trim().startsWith(envName + '='));
          if (line) key = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
        } catch {
          /* 没 .env 就算了 */
        }
      }
      if (!baseUrl) return json(res, { ok: false, error: '配置里没有 baseUrl' });
      const r = await fetch(baseUrl + '/models', {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`模型列表 HTTP ${r.status}`);
      const data = await r.json();
      const ids = (data?.data || []).map((m) => m.id).filter(Boolean).sort();
      json(res, { ok: true, models: ids, current: botCfg?.llm?.model || null });
    } catch (error) {
      json(res, { ok: false, error: String((error && error.message) || error) });
    }
  });

  route('/dsh-qq/learn', async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' });
    const body = await readBody(req);
    if (!body.uin) return json(res, { ok: false, error: '缺 uin' });
    const out = await api('/api/people/learn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uin: String(body.uin), force: true }),
    });
    json(res, { ok: out?.ok !== false, result: out });
  });

  route('/dsh-qq/messages', async (req, res, url) => {
    const scope = url.searchParams.get('scope');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 200);
    if (!scope) return json(res, { ok: false, error: '要带 scope' });
    json(res, { ok: true, scope, messages: readMessages(scope, limit) });
  });

  // 发消息（面板「对话」页用）
  route('/dsh-qq/send', async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' });
    const body = await readBody(req);
    if (!body.scope || !body.text) return json(res, { ok: false, error: '要带 scope 和 text' });
    const out = await api('/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: String(body.scope), text: String(body.text), quote: body.quote || undefined }),
    });
    json(res, { ok: out?.ok !== false, result: out });
  });

  // 开关某个会话的自动聊天
  route('/dsh-qq/autochat', async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' });
    const body = await readBody(req);
    if (!body.scope) return json(res, { ok: false, error: '要带 scope' });
    const out = await api('/api/autochat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: String(body.scope), enabled: Boolean(body.enabled) }),
    });
    json(res, { ok: out?.ok !== false, result: out });
  });

  // 机器人进程：状态 / 重启 / 日志
  route('/dsh-qq/bot', async (req, res) => {
    json(res, {
      ok: true,
      managed: Boolean(cfg.manageBot),
      attached: botState.attached,
      botDir,
      dataDir,
      controlBase: controlBase(),
      pid: botState.child?.pid || null,
      startedAt: botState.startedAt || null,
      restarts: botState.restarts,
      lastExit: botState.lastExit,
      logs: logs.slice(-200),
    });
  });

  route('/dsh-qq/bot/restart', async (req, res) => {
    if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' });
    if (!cfg.manageBot) return json(res, { ok: false, error: '当前是「接外部机器人」模式，请用 systemctl/自己的进程管理器重启' });
    json(res, await restartBot());
  });

  // 实时动态：把控制台的 SSE 直接转给面板
  route('/dsh-qq/events', async (req, res) => {
    const token = controlToken();
    const url = `${controlBase()}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const ctrl = new AbortController();
    streams.add(ctrl);
    res.on('close', () => ctrl.abort());
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
      if (!r.ok || !r.body) throw new Error(`控制台事件流 HTTP ${r.status}`);
      for await (const chunk of r.body) res.write(Buffer.from(chunk));
    } catch (err) {
      if (!ctrl.signal.aborted) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: String(err?.message || err) })}\n\n`);
      }
    } finally {
      streams.delete(ctrl);
      res.end();
    }
  });

  const setup = createSetup({ configPath, nativeService: cfg.snowLumaService, nativeScope: cfg.snowLumaServiceScope });
  const windowOptions = { mode: cfg.snowLumaMode, container: cfg.snowLumaContainer,
    display: cfg.snowLumaMode === 'docker' ? ':1' : cfg.snowLumaDisplay,
    xauthority: cfg.snowLumaMode === 'docker' ? '' : cfg.snowLumaXauthority };
  const login = createLogin({ ...windowOptions, check: () => setup.check() });
  const desktop = createDesktop({ ...windowOptions, discoverWindow: () => login.window() });
  const original = createOriginalLogin({ mode: cfg.snowLumaMode, container: cfg.snowLumaContainer });
  const loginHttp = registerLoginHttp({ ctx, login, desktop, readBody,
    originalLogin: cfg.snowLumaMode === 'docker' ? { target: (options) => original.target(options), password: (options) => original.password(options), redirect: originalRedirect, dispose: () => original.dispose() } : null,
    assetPath: path.join(PKG_DIR, 'assets/desktop-viewer.js') });
  const setupAction = async (action, input = {}) => {
    ensureDataDir();
    if (action === 'status') return setup.status();
    if (action === 'check') return setup.check(input);
    if (action === 'connect') return setup.connect(input);
    throw new Error('不支持的接入操作');
  };
  route('/dsh-qq/setup', async (req, res) => {
    if (req.method !== 'GET') throw new Error('只接受 GET');
    json(res, await setupAction('status'));
  });
  for (const action of ['check', 'connect']) route(`/dsh-qq/setup/${action}`, async (req, res) => {
    if (req.method !== 'POST') throw new Error('只接受 POST');
    json(res, await setupAction(action, await readBody(req)));
  });

  const gatewayStatus = async () => {
    if (cfg.snowLumaMode === 'native') return nativeStatus(cfg.snowLumaService, cfg.snowLumaServiceScope);
    if (cfg.snowLumaMode === 'external') {
      try { const checked = await setupAction('check'); return { mode: 'external', running: true, status: 'connected', account: checked.account }; }
      catch { return { mode: 'external', running: false, status: 'unreachable' }; }
    }
    if (cfg.snowLumaMode !== 'docker') throw new Error('不支持的网关模式');
    let output;
    try { output = await command('docker', ['inspect', '--format', '{{json .}}', cfg.snowLumaContainer]); }
    catch (error) {
      if (/No such (object|container)/i.test(error.message)) return { mode: 'docker', name: cfg.snowLumaContainer, running: false, status: 'not-created', composeFile: cfg.snowLumaComposeFile || null };
      throw error;
    }
    const d = JSON.parse(output);
    return { mode: 'docker', name: d.Name?.replace(/^\//, ''), image: d.Config?.Image, running: d.State?.Running === true, status: d.State?.Status,
      startedAt: d.State?.StartedAt, composeFile: cfg.snowLumaComposeFile || null };
  };
  route('/dsh-qq/snowluma', async (_req, res) => json(res, { ok: true, status: await gatewayStatus() }));
  const gatewayAction = async ({ op, confirm }) => {
    if (!['start', 'stop', 'restart'].includes(op)) throw new Error('不支持的网关操作');
    if (confirm !== true) throw new Error('网关操作需要明确确认（confirm:true）');
    let output;
    if (cfg.snowLumaMode === 'external') throw new Error('外部模式只连接，不启停网关');
    if (cfg.snowLumaMode === 'native') {
      output = await command('systemctl', nativeServiceArgs(cfg.snowLumaService, cfg.snowLumaServiceScope, op), { timeoutMs: 60000 });
    } else if (cfg.snowLumaMode === 'docker') {
      // Compatibility management only: never create containers, pull images or deploy upstream.
      output = await command('docker', [op, cfg.snowLumaContainer], { timeoutMs: 60000 });
    } else throw new Error('不支持的网关模式');
    return { ok: true, output, status: await gatewayStatus() };
  };
  route('/dsh-qq/snowluma/action', async (req, res) => {
    if (req.method !== 'POST') throw new Error('只接受 POST');
    json(res, await gatewayAction(await readBody(req)));
  });

  // ── 原生工具（原来是 MCP stdio，现在直接注册） ─────────────

  const callTool = makeCallTool({
    api,
    raw: rawAction,
    dataDir: () => {
      const c = readBotConfig();
      return path.resolve(dataDir, c?.storage?.dataDir || 'data');
    },
  });

  const toolDisposers = [];
  const managementTools = [
    defineTool({ name: 'qq_setup', description: '检查本机原版 QQ 网关依赖、测试 OneBot 登录或保存接入配置（保存后需重启机器人）。不安装 SnowLuma、不代同意上游协议。',
      parameters: { action: { type: 'string', enum: ['status', 'check', 'connect'], required: true },
        httpUrl: { type: 'string', description: '本机 OneBot HTTP 根地址' }, wsUrl: { type: 'string', description: '本机 WebSocket 地址，可带 /event' },
        token: { type: 'string', description: '省略则同地址复用旧 token；空字符串表示不使用 token' },
        llm: { type: 'object', additionalProperties: false, description: 'connect 时可选保存模型设置；不会测试或调用模型', properties: { baseUrl: { type: 'string' }, model: { type: 'string' }, apiKey: { type: 'string' } } } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: async ({ action, ...input }) => JSON.stringify(await setupAction(action, input)) }),
    defineTool({ name: 'qq_gateway', description: '查看或启停已安装的 QQ 网关（原生 systemd / Docker 兼容）；不会安装网关，停止和重启会断开 QQ。',
      parameters: { op: { type: 'string', enum: ['status', 'start', 'stop', 'restart'], required: true }, confirm: { type: 'boolean', description: '启停操作须按用户明确请求设 true' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: async input => JSON.stringify(input.op === 'status' ? await gatewayStatus() : await gatewayAction(input)) }),
  ];
  for (const definition of managementTools) ctx.effect(() => {
    const dispose = ctx.tools.register(definition); toolDisposers.push(dispose); return dispose;
  });
  for (const spec of TOOLS) {
    ctx.effect(() => {
      const dispose = ctx.tools.register(defineTool({
        name: spec.name, description: spec.description, parameters: toParamSpec(spec.inputSchema),
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        timeoutMs: 240000,
        async execute(args) {
          const r = await callTool(spec.name, args || {});
          const text = r?.content?.[0]?.text ?? '';
          if (r?.isError) throw new Error(text);
          return text;
        },
      }));
      toolDisposers.push(dispose);
      return dispose;
    });
  }

  ctx.effect(() => () => {
    loginHttp.dispose();
    for (const stream of streams) stream.abort();
    stopBot();
  });

  // ── 启动 ───────────────────────────────────────────────────

  const startup = spawnBot().catch((e) => pushLog(`启动失败：${e?.message || e}`));
  ctx.logger?.info?.(`[dsh-qq] 已挂载：面板 /dsh-qq/*，工具 ${toolDisposers.length} 个，控制台 ${controlBase()}，数据 ${dataDir}`);

  return { overview, restartBot, ready: startup, state: botState };
}

export const version = PKG.version;
