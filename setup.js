import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { command } from './runtime.js';

export const UPSTREAM = Object.freeze({
  release: 'https://github.com/SnowLuma/SnowLuma/releases',
  manual: 'https://snowluma.github.io/zh/docs/guide/deploy/linux-manual',
  eula: 'https://github.com/SnowLuma/SnowLuma/blob/v2.3.4/EULA.md',
  qq: 'https://im.qq.com/linuxqq/download.html',
});
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
export function localUrl(raw, protocols = ['http:', 'https:']) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('请输入完整的本机地址'); }
  if (!protocols.includes(u.protocol) || !LOCAL.has(u.hostname) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '' && !(protocols.includes('ws:') && u.pathname === '/event'))) {
    throw new Error('向导只接受 localhost / 127.0.0.1 / [::1] 的服务根地址，不接受密码、路径或查询参数');
  }
  return u.origin + (u.pathname === '/event' ? '/event' : '');
}
export function nativeServiceArgs(service, scope = 'system', op = 'show') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.(?:service|target)$/.test(service || '') || String(service).length > 160) throw new Error('原生服务名必须是有效的 .service 或 .target 名称');
  if (!['system', 'user'].includes(scope)) throw new Error('服务范围必须是 system 或 user');
  if (!['show', 'start', 'stop', 'restart'].includes(op)) throw new Error('不支持的服务操作');
  return [...(scope === 'user' ? ['--user'] : []), op, service, ...(op === 'show' ? ['--property=LoadState,ActiveState,SubState,MainPID', '--no-pager'] : [])];
}
export async function nativeStatus(service, scope, run = command) {
  if (process.platform !== 'linux') return { mode: 'native', running: false, status: 'unsupported-platform', service, scope };
  const args = nativeServiceArgs(service, scope);
  let text;
  try { text = await run('systemctl', args, { timeoutMs: 5000 }); }
  catch (error) { if (/not[- ]found|could not be found/i.test(error.message)) return { mode: 'native', name: service, service, scope, running: false, status: 'not-installed' }; throw error; }
  const fields = Object.fromEntries(text.trim().split('\n').map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  return { mode: 'native', name: service, service, scope, running: fields.ActiveState === 'active', status: fields.LoadState === 'not-found' ? 'not-installed' : fields.ActiveState || 'unknown', subState: fields.SubState, pid: Number(fields.MainPID) || null };
}

/** Read-only preparation and explicit connection of an operator-installed original gateway. */
export function createSetup({ configPath, gatewayBackend = 'snowluma', gatewayMode = 'native', nativeService = gatewayBackend === 'napcat' ? 'napcat.service' : 'snowluma.target', nativeScope = 'system', run = command, fetcher = fetch, Socket = WebSocket }) {
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  async function check(input = {}) {
    const current = read().onebot || {};
    const httpUrl = localUrl(input.httpUrl || current.httpUrl || 'http://127.0.0.1:3000');
    const wsUrl = localUrl(input.wsUrl || current.wsUrl || (new URL(httpUrl).protocol === 'https:' ? 'wss://' : 'ws://') + new URL(httpUrl).hostname + ':3001/event', ['ws:', 'wss:']);
    if (new URL(wsUrl).hostname !== new URL(httpUrl).hostname) throw new Error('HTTP 和 WebSocket 必须指向同一本机主机');
    let token = input.token;
    if (token === undefined) {
      if ((httpUrl !== String(current.httpUrl || '').replace(/\/$/, '') || wsUrl !== String(current.wsUrl || '').replace(/\/$/, '')) && (current.accessToken || current.wsAccessToken)) throw new Error('更换网关地址时请重新输入 access token（无 token 时留空）');
      token = current.accessToken || '';
    }
    if (typeof token !== 'string' || token.length > 4096) throw new Error('access token 格式不正确');
    let response;
    try { response = await fetcher(httpUrl + '/get_login_info', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{}', signal: AbortSignal.timeout(8000) }); }
    catch { throw new Error('无法连接本机 OneBot：检查原版网关是否运行、端口和 token 是否正确'); }
    if (!response.ok) throw new Error(`OneBot HTTP ${response.status}；检查端口和 token`);
    const text = await response.text();
    if (text.length > 65536) throw new Error('OneBot 响应过大');
    let result; try { result = JSON.parse(text); } catch { throw new Error('此端口不是有效的 OneBot JSON 服务'); }
    if (result.status !== 'ok' || Number(result.retcode || 0) !== 0 || !/^\d+$/.test(String(result.data?.user_id || ''))) throw new Error('网关尚未登录或 get_login_info 失败；先完成 QQ 扫码');
    const wsToken = input.token === undefined ? current.wsAccessToken ?? token : token;
    await new Promise((resolve, reject) => {
      const target = new URL(wsUrl);
      if (wsToken) target.searchParams.set('access_token', wsToken);
      let socket, settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (socket?.readyState === 1) socket.close();
        else if (socket?.readyState === 0) socket.addEventListener('open', () => socket.close(), { once: true });
        error ? reject(new Error('OneBot HTTP 已登录，但事件 WebSocket 无法连接；检查 WS 端口、/event 路径及 token')) : resolve();
      };
      const timer = setTimeout(() => finish(true), 5000);
      try { socket = new Socket(target); socket.addEventListener('open', () => finish(false), { once: true }); socket.addEventListener('error', () => finish(true), { once: true }); socket.addEventListener('close', () => finish(true), { once: true }); }
      catch { finish(true); }
    });
    return { ok: true, httpUrl, wsUrl, websocket: 'open', account: { user_id: result.data.user_id, nickname: String(result.data.nickname || '') } };
  }
  async function connect(input = {}) {
    const original = fs.readFileSync(configPath, 'utf8');
    const verified = await check(input);
    const c = JSON.parse(original);
    c.onebot = { ...c.onebot, httpUrl: verified.httpUrl, wsUrl: verified.wsUrl };
    if (input.token !== undefined) { c.onebot.accessToken = input.token; delete c.onebot.wsAccessToken; }
    if (input.llm) {
      const l = input.llm;
      if (l.baseUrl !== undefined) {
        const u = new URL(l.baseUrl);
        if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) || u.username || u.password || u.search || u.hash) throw new Error('模型接口需 HTTPS（本机可 HTTP），不可在 URL 中携带密钥');
        const baseUrl = u.href.replace(/\/$/, '');
        const previous = String(c.llm?.baseUrl || 'https://api.deepseek.com/v1').replace(/\/$/, '');
        if (baseUrl !== previous) {
          if (typeof l.apiKey !== 'string') throw new Error('更换模型接口地址时须明确填写新 API Key；不能沿用旧接口或环境变量中的密钥');
          // Even explicit no-key must not fall back to an old provider's environment key.
          c.llm = { ...c.llm, apiKey: '', apiKeyEnv: '' };
        }
        c.llm = { ...c.llm, baseUrl };
      }
      if (l.model !== undefined) { if (typeof l.model !== 'string' || !l.model.trim() || l.model.length > 200) throw new Error('模型名称无效'); c.llm = { ...c.llm, model: l.model.trim(), models: { ...c.llm?.models, chat: l.model.trim() } }; }
      if (l.apiKey !== undefined) { if (typeof l.apiKey !== 'string' || l.apiKey.length > 4096) throw new Error('模型密钥无效'); c.llm = { ...c.llm, apiKey: l.apiKey }; }
    }
    if (fs.readFileSync(configPath, 'utf8') !== original) throw new Error('配置在检测期间已变化，请刷新后重试');
    const suffix = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const backup = configPath + '.before-setup-' + suffix;
    const temp = configPath + '.setup-' + suffix;
    fs.writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
    try { fs.writeFileSync(temp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, configPath); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return { ...verified, restartRequired: true, backupCreated: true };
  }
  async function status() {
    const c = read();
    const exists = bin => (process.env.PATH || '').split(path.delimiter).some(dir => { try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; } });
    const ffmpeg = exists('ffmpeg'), xvfb = exists('Xvfb');
    const envName = c.llm?.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
    let envKey = false;
    try { envKey = fs.readFileSync(path.join(path.dirname(configPath), '.env'), 'utf8').split('\n').some(line => { const match = line.trim().match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/); return match?.[1] === envName && Boolean(match[2].replace(/^['\"]|['\"]$/g, '').trim()); }); } catch {}
    const qqPath = (gatewayBackend === 'napcat' ? ['/opt/QQ/qq'] : ['/opt/QQ/qq', '/opt/snowluma/qq/qq']).find(file => fs.existsSync(file));
    const qq = Boolean(qqPath);
    const docker = gatewayBackend === 'snowluma' && gatewayMode === 'docker';
    return { ok: true, backend: gatewayBackend, preferredMode: docker ? 'docker' : 'native', host: { platform: process.platform, arch: process.arch, node: process.version },
      current: { httpUrl: c.onebot?.httpUrl || '', wsUrl: c.onebot?.wsUrl || '', hasToken: Boolean(c.onebot?.accessToken || c.onebot?.wsAccessToken), model: c.llm?.models?.chat || c.llm?.model || '', baseUrl: c.llm?.baseUrl || '', hasApiKey: Boolean(c.llm?.apiKey || process.env[envName] || envKey) },
      checks: [ { id: 'platform', label: docker ? 'Docker 宿主运行环境' : 'Linux 原生运行环境', ok: process.platform === 'linux', detail: `${os.type()} ${process.arch}` },
        ...(docker ? [{ id: 'docker', label: 'Docker 管理命令', ok: exists('docker'), detail: 'QQ 和扫码桌面运行于所选已有容器内；请在运维核查容器状态，不要求宿主安装 QQ 或 Xvfb' }] : [{ id: 'qq', label: '原版 Linux QQ', ok: qq, detail: qq ? `${qqPath} 已存在；仍需验证能启动和登录` : gatewayBackend === 'napcat' ? '未检测到 /opt/QQ/qq；请由管理员确认 NapCat 配套 Linux QQ 安装路径' : '未检测到 /opt/QQ/qq 或 /opt/snowluma/qq/qq；可按原生安装指南准备' },
        ...(gatewayBackend === 'napcat' ? [] : [{ id: 'display', label: '桌面 / 无头扫码环境', ok: Boolean(process.env.DISPLAY) || xvfb, detail: process.env.DISPLAY ? '有 DISPLAY；仍需人工确认能显示 QQ' : xvfb ? 'Xvfb 命令存在；仍需配置并启动桌面和扫码' : '未检测到桌面；服务器需 Xvfb + 窗口管理器 + 受保护的远程桌面' }])]),
        { id: 'ffmpeg', label: '动图 / 视频抽帧', ok: ffmpeg, detail: ffmpeg ? 'ffmpeg 可用' : '缺少 ffmpeg；静态识图不受影响' } ],
      links: gatewayBackend === 'napcat' ? { release: 'https://github.com/NapNeko/NapCatQQ/releases', manual: 'https://napneko.github.io/', qq: UPSTREAM.qq } : UPSTREAM, ...(docker ? {} : { native: { service: nativeService, scope: nativeScope } }),
      automaticInstall: gatewayBackend === 'napcat' ? { available: false, scriptAvailable: false, reason: '由宿主管理员安装 NapCat 和 Linux QQ；本页面仅连接已安装的服务，扫码使用 NapCat 官方 WebUI。' } : docker ? { available: false, scriptAvailable: true, guide: 'https://github.com/oka-rin/dsh-qq/blob/main/docs/docker.md', script: 'https://github.com/oka-rin/dsh-qq/blob/main/scripts/install-snowluma-docker.mjs', planCommand: 'node scripts/install-snowluma-docker.mjs --plan', reason: '仅连接和管理管理员指定的已有 SnowLuma Docker 容器；网页不会隐式创建容器、拉取镜像、执行部署或接受上游协议。需要部署时，先预览可审查脚本的计划并按 Docker 指南明确确认。' } : { available: false, scriptAvailable: true, guide: 'https://github.com/oka-rin/dsh-qq/blob/main/docs/native.md', script: 'https://github.com/oka-rin/dsh-qq/blob/main/scripts/install-native.sh', planCommand: 'bash scripts/install-native.sh --plan', reason: '提供宿主机管理员主动执行的可审查原生安装脚本；网页不会代运行 sudo、接受上游协议、扫码或停用 Docker。先预览计划并阅读上游条款，再按指南明确确认安装。' } };
  }
  return { status, check, connect };
}
