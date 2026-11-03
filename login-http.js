import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { assertLoginRequest } from './login.js';

const ROOT = '/dsh-qq/login';
const COOKIE = 'dsh_qq_desktop';
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const VIEW = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ 登录窗口</title></head><body style="margin:0;height:100vh;display:flex;flex-direction:column;background:#171717;color:#eee;font:14px system-ui"><header style="padding:8px;flex:none"><button id="close" type="button">关闭登录窗口并返回 QQ 设置</button><p id="transport-warning" role="note" style="color:#ffd580;margin:8px 0">HTTP 连接未加密：QQ 窗口画面、键盘输入及登录信息可能被网络中的其他人读取或篡改。仅在可信网络继续；密码只在原版 QQ 窗口输入，不要发送到聊天。</p><p id="status" style="margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere" role="status">连接 QQ 登录窗口…</p><p style="margin:8px 0">连接仅可使用一次，最长 10 分钟；刷新或断线后，请返回 QQ 设置重新打开。</p></header><div id="screen" style="flex:1;min-height:0;overflow:hidden"></div><script src="./viewer.js" defer></script></body></html>`;
const cancelled = () => new Error('登录请求已取消');

function until(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    if (signal.aborted) { reject(cancelled()); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// These browser operations accept tiny JSON objects only. Do not depend on the
// general panel's larger, unbounded-in-time body reader for credential routes.
function body(req, signal) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false; const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', abort);
      signal.removeEventListener('abort', abort);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const fail = () => finish(new Error('无法读取登录请求'));
    const abort = () => finish(cancelled());
    const data = chunk => {
      size += chunk.length;
      if (size > 4096) finish(new Error('登录请求体过大')); else chunks.push(chunk);
    };
    const end = () => {
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { finish(new Error('请求体必须是有效 JSON')); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) finish(new Error('登录请求必须是 JSON 对象'));
      else finish(null, value);
    };
    const timer = setTimeout(() => finish(new Error('读取登录请求超时')), 10_000);
    timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Browser-only credential surfaces; never register these operations as model tools. */
export function registerLoginHttp({ ctx, login, desktop, assetPath, originalLogin = null }) {
  let session = null, busy = false, disposed = false;
  const requests = new Set();
  const send = (res, status, value, extra = {}) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(value));
  };
  function rejection(req) {
    // Fail closed when Connection is unavailable or throws, including upgrades.
    try { return ctx.connection ? ctx.connection.requestRejection(req) : 403; }
    catch { return 403; }
  }
  function mutation(req) {
    // Only after Connection has authenticated and validated this Host/Origin.
    // Connection remains authoritative for both ordinary HTTP and TLS proxies.
    assertLoginRequest(req, { trustedOrigin: req.headers.origin });
  }
  function owner(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1 || !session || Date.now() >= session.expiresAt) return false;
    const actual = Buffer.from(cookies[0].slice(COOKIE.length + 1)), expected = Buffer.from(session.id);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  const clear = () => { session = null; desktop.stop(); };
  function exact(path, handler) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROOT + path, handler: async (req, res) => {
      const denied = rejection(req);
      if (denied) { send(res, denied, { ok: false, error: '需要已认证的 DSH 浏览器会话' }); return; }
      if (disposed || (req.url || '').includes('?')) { send(res, 400, { ok: false, error: '登录入口不可用或请求路径无效' }); return; }
      if (requests.size >= 8) { send(res, 429, { ok: false, error: '登录请求过多，请稍后重试' }); return; }
      const ctrl = new AbortController(); requests.add(ctrl);
      const abort = () => { if (!res.writableEnded) ctrl.abort(); };
      const timer = setTimeout(() => ctrl.abort(), 60_000); timer.unref?.();
      res.once('close', abort);
      try {
        await until(Promise.resolve().then(() => handler(req, res, ctrl.signal)), ctrl.signal);
      } catch (error) {
        if (!res.headersSent) send(res, 400, { ok: false, error: error.message || '登录请求失败' });
        else res.end();
      } finally { clearTimeout(timer); res.off('close', abort); requests.delete(ctrl); }
    } }));
  }
  exact('/status', async (req, res, signal) => {
    if (req.method !== 'GET') throw new Error('只接受 GET');
    const value = await until(login.status({ signal }), signal);
    send(res, 200, value);
  });

  // Docker deployments already provide the original SnowLuma noVNC desktop.
  // Only advertise this fixed authenticated hop; never accept a redirect URL
  // from the browser, and never read or forward the original VNC password.
  exact('/original', async (req, res, signal) => {
    if (req.method !== 'GET' || !originalLogin) throw new Error('原版 SnowLuma 网页桌面未配置');
    const target = await until(originalLogin.target({ signal }), signal);
    const location = originalLogin.redirect(req, target);
    res.writeHead(302, { ...HEADERS, location }); res.end();
  });

  exact('/desktop/session', async (req, res, signal) => {
    mutation(req);
    const input = await body(req, signal);
    if (Object.keys(input).length) throw new Error('桌面请求不接受参数');
    if (signal.aborted) throw cancelled();
    if (originalLogin) {
      await until(originalLogin.target({ signal }), signal); // Verify the original service, without starting a substitute.
      send(res, 200, { ok: true, url: ROOT + '/original', expiresAt: Date.now() + 120000, provider: 'snowluma-original' });
      return;
    }
    const origin = new URL(req.headers.origin);
    if (busy || (session && Date.now() < session.expiresAt && !owner(req))) throw new Error('已有另一个 QQ 登录窗口，请先关闭或等待过期');
    busy = true;
    session = null; // start replaces the backend session; never retain stale credentials on failure.
    const cancel = () => clear();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const prepared = await desktop.start();
      if (disposed || signal.aborted || res.destroyed) { clear(); return; }
      session = { id: randomBytes(32).toString('base64url'), wsPath: prepared.wsPath,
        protocols: prepared.protocols, capabilityExpiresAt: prepared.expiresAt, expiresAt: prepared.sessionExpiresAt, used: false };
      // Root path is intentional: a reverse proxy can mount this carrier at /dsh/
      // while stripping that prefix before dispatch. The cookie is HTTP-only and
      // never a backend WS capability, and is never sent outside this host.
      const maxAge = Math.max(0, Math.min(600, Math.floor((session.expiresAt - Date.now()) / 1000)));
      const cookie = `${COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.protocol === 'https:' ? '; Secure' : ''}`;
      send(res, 200, { ok: true, url: ROOT + '/desktop/view', expiresAt: session.expiresAt }, { 'set-cookie': cookie });
    } finally { signal.removeEventListener('abort', cancel); busy = false; }
  });
  exact('/desktop/close', async (req, res, signal) => {
    mutation(req);
    const input = await body(req, signal);
    if (Object.keys(input).length) throw new Error('关闭请求不接受参数');
    if (signal.aborted) throw cancelled();
    if (owner(req)) clear();
    send(res, 200, { ok: true });
  });
  for (const page of ['view', 'info', 'viewer.js']) exact(`/desktop/${page}`, async (req, res) => {
    if (req.method !== 'GET' || !owner(req) || session.used || Date.now() >= session.capabilityExpiresAt) throw new Error('QQ 登录窗口已过期，请重新打开');
    if (page === 'info') { send(res, 200, { ok: true, wsPath: session.wsPath, protocols: session.protocols }); return; }
    const value = page === 'view' ? VIEW : await fs.promises.readFile(assetPath);
    if (disposed || res.destroyed) return;
    res.writeHead(200, { ...HEADERS, 'content-type': page === 'view' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      'permissions-policy': 'clipboard-read=(), clipboard-write=(), camera=(), microphone=(), display-capture=()', 'x-frame-options': 'SAMEORIGIN' });
    res.end(value);
  });
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: ROOT + '/desktop/ws', handler: async (req, socket, head) => {
    const deny = () => { if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n'); };
    try {
      if (rejection(req) || disposed || req.method !== 'GET' || req.url !== ROOT + '/desktop/ws' || !owner(req) || session.used || Date.now() >= session.capabilityExpiresAt) { deny(); return; }
      const current = session;
      // Backend validates exact Origin, handshake and its single-use capability.
      if (await desktop.upgrade(req, socket, head)) { current.used = true; current.protocols = null; }
    } catch { deny(); }
  } }));
  return { dispose() {
    if (disposed) return;
    disposed = true;
    for (const ctrl of requests) ctrl.abort();
    clear(); desktop.dispose(); login.dispose(); originalLogin?.dispose?.();
  } };
}
