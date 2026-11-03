import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { registerLoginHttp } from '../login-http.js';

const root = '/dsh-qq/login';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const routes = new Map(), upgrades = new Map(), disposers = [], calls = [];
  let authenticated = true, disposed = false;
  const prepared = () => ({ wsPath: root + '/desktop/ws', protocols: ['binary', 'dsh-qq-session.synthetic-secret'], expiresAt: Date.now() + 120000, sessionExpiresAt: Date.now() + 600000 });
  const login = {
    status: async ({ signal }) => { calls.push(['status', signal]); return { ok: true, state: 'unavailable' }; },
    qr: async ({ signal }) => { calls.push(['qr', signal]); return { ok: true, image: 'data:image/png;base64,ZmFrZQ==' }; },
    refresh: async ({ signal }) => { calls.push(['refresh', signal]); return { ok: true }; },
    dispose: () => calls.push(['login.dispose']), ...options.login,
  };
  const desktop = {
    start: async () => { calls.push(['start']); return prepared(); },
    stop: () => calls.push(['stop']), dispose: () => calls.push(['desktop.dispose']),
    upgrade: async (req, socket) => { calls.push(['upgrade', req.url]); socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); return true; },
    ...options.desktop,
  };
  const ctx = {
    effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose); },
    connection: options.missingConnection ? undefined : { requestRejection(req) {
      calls.push(['auth', req.url]);
      if (options.throwAuth) throw new Error('auth unavailable');
      if (!authenticated || req.headers['x-auth'] !== 'yes') return 401;
      const host = req.headers.host;
      if (req.headers.origin && ![`http://${host}`, `https://${host}`].includes(req.headers.origin)) return 403;
    } },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
      registerUpgrade(route) { upgrades.set(route.path, route.handler); return () => upgrades.delete(route.path); },
    },
  };
  const api = registerLoginHttp({ ctx, login, desktop, readBody: () => { throw new Error('must not use unbounded shared reader'); }, assetPath: fileURLToPath(new URL('../desktop-client.js', import.meta.url)) });
  const server = http.createServer((req, res) => {
    // Emulate a mount proxy stripping /dsh before the carrier sees requests.
    req.url = req.url.replace(/^\/dsh(?=\/)/, '');
    const route = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    route(req, res).catch(error => { res.writeHead(500); res.end(error.message); });
  });
  server.on('upgrade', (req, socket, head) => {
    req.url = req.url.replace(/^\/dsh(?=\/)/, '');
    const handler = upgrades.get(new URL(req.url, 'http://localhost').pathname);
    if (handler) handler(req, socket, head); else socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const dispose = () => { if (!disposed) { disposed = true; api.dispose(); for (const fn of disposers.reverse()) fn(); } };
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path, { method = 'GET', headers = {}, body, auth = true, prefix = '' } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(origin + prefix + root + path, { method, headers: { ...(auth ? { 'x-auth': 'yes' } : {}), ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.end(data);
  });
  const upgrade = (path = '/desktop/ws', headers = {}) => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let result = '';
    socket.on('connect', () => socket.write(`GET ${root}${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${Object.entries({ 'x-auth': 'yes', origin, ...headers }).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`));
    socket.on('data', chunk => { result += chunk; if (result.includes('\r\n\r\n')) { socket.destroy(); resolve(result); } });
    socket.on('error', reject);
  });
  return { request, upgrade, calls, api, dispose, routes, upgrades, origin, port, prepared, setAuth: value => { authenticated = value; } };
}
const cookieOf = response => response.headers['set-cookie'][0].split(';')[0];
const post = (body = {}, headers = {}) => ({ method: 'POST', body, headers });

test('every HTTP route and upgrade authenticates; absent/failing Connection fails closed', async t => {
  const f = await fixture(t);
  for (const [path, method] of [['/status', 'GET'], ['/qr', 'POST'], ['/refresh', 'POST'], ['/desktop/session', 'POST'], ['/desktop/close', 'POST'], ['/desktop/view', 'GET'], ['/desktop/info', 'GET'], ['/desktop/viewer.js', 'GET']]) {
    const r = await f.request(path, { method, ...(method === 'POST' ? { body: {} } : {}), auth: false }); assert.equal(r.status, 401); assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.match(await f.upgrade(), /^HTTP\/1.1 403/);
  assert.ok(!f.calls.some(([name]) => ['start', 'qr', 'status', 'upgrade'].includes(name)));
  for (const options of [{ missingConnection: true }, { throwAuth: true }]) {
    const denied = await fixture(t, options); assert.equal((await denied.request('/status')).status, 403); assert.match(await denied.upgrade(), /^HTTP\/1.1 403/);
  }
});

test('POST JSON and same-origin CSRF enforced before operations; trusted TLS proxy supports Secure cookie', async t => {
  const f = await fixture(t);
  for (const options of [
    { method: 'GET' }, post({}, { origin: '' }), post({}, { origin: 'https://evil.example' }),
    post({}, { 'sec-fetch-site': 'cross-site' }), post({}, { 'content-type': 'text/plain' }),
    post('true'), post('[]'), post('1'), post('null'), post('{bad'), post({ command: 'sh' }),
  ]) assert.notEqual((await f.request('/desktop/session', options)).status, 200);
  assert.ok(!f.calls.some(([name]) => name === 'start'));
  assert.equal((await f.request('/refresh', post())).status, 400);
  assert.equal((await f.request('/refresh', post({ confirm: true }))).status, 200);
  const r = await f.request('/desktop/session', post({}, { origin: f.origin.replace('http:', 'https:') }));
  assert.equal(r.status, 200); assert.match(r.headers['set-cookie'][0], /; Secure/); assert.match(r.headers['set-cookie'][0], /; HttpOnly; SameSite=Strict/);
});

test('owner credential never appears in URL/JSON; another browser cannot open, read or close desktop', async t => {
  const f = await fixture(t); const r = await f.request('/desktop/session', post()); const cookie = cookieOf(r);
  assert.equal(r.status, 200); assert.equal(r.json.url, root + '/desktop/view');
  assert.ok(!r.text.includes(cookie.split('=')[1])); assert.ok(!r.text.includes('synthetic-secret'));
  assert.equal((await f.request('/desktop/session', post())).status, 400);
  for (const page of ['view', 'info', 'viewer.js']) assert.equal((await f.request('/desktop/' + page)).status, 400);
  assert.equal((await f.request('/desktop/close', post())).status, 200); assert.ok(!f.calls.some(([name]) => name === 'stop'));
  assert.equal((await f.request('/desktop/info', { headers: { cookie } })).status, 200);
  assert.equal((await f.request('/desktop/info', { headers: { cookie: `${cookie}; ${cookie}` } })).status, 400);
  await f.request('/desktop/close', post({}, { cookie })); assert.equal(f.calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal((await f.request('/desktop/info', { headers: { cookie } })).status, 400);
});

test('proxy /dsh mount cookie and relative same-origin viewer assets; no URL credential allowed', async t => {
  const f = await fixture(t); const r = await f.request('/desktop/session', { ...post(), prefix: '/dsh' }); const cookie = cookieOf(r);
  assert.match(r.headers['set-cookie'][0], /; Path=\/;/); assert.doesNotMatch(r.headers['set-cookie'][0], /; Secure/);
  const page = await f.request('/desktop/view', { prefix: '/dsh', headers: { cookie } });
  assert.equal(page.status, 200); assert.match(page.text, /src="\.\/viewer.js"/); assert.doesNotMatch(page.text, /https?:\/\//);
  assert.match(page.headers['content-security-policy'], /script-src 'self'; connect-src 'self'/);
  const asset = await f.request('/desktop/viewer.js', { prefix: '/dsh', headers: { cookie } }); assert.equal(asset.status, 200);
  assert.equal((await f.request('/desktop/info?token=secret', { headers: { cookie } })).status, 400);
  assert.match(await f.upgrade('/desktop/ws?token=secret', { cookie }), /^HTTP\/1.1 403/);
  assert.ok(!f.calls.some(([name]) => name === 'upgrade'));
});

test('stale capabilities and used viewers fail, while owner may explicitly close', async t => {
  let expiry = Date.now() - 1;
  const f = await fixture(t, { desktop: { start: async () => ({ wsPath: root + '/desktop/ws', protocols: ['binary', 'nonce'], expiresAt: expiry, sessionExpiresAt: Date.now() + 600000 }) } });
  let r = await f.request('/desktop/session', post()); let cookie = cookieOf(r);
  assert.equal((await f.request('/desktop/info', { headers: { cookie } })).status, 400);
  assert.match(await f.upgrade('/desktop/ws', { cookie }), /^HTTP\/1.1 403/);
  expiry = Date.now() + 120000; r = await f.request('/desktop/session', post({}, { cookie })); cookie = cookieOf(r);
  assert.match(await f.upgrade('/desktop/ws', { cookie }), /^HTTP\/1.1 101/);
  assert.equal((await f.request('/desktop/info', { headers: { cookie } })).status, 400);
  assert.match(await f.upgrade('/desktop/ws', { cookie }), /^HTTP\/1.1 403/);
  assert.equal((await f.request('/desktop/close', post({}, { cookie }))).status, 200);
});

test('bounded tiny JSON and limited parallel operations; status and QR receive cancellation signals', async t => {
  const pending = deferred(), entered = deferred(); const signals = [];
  const f = await fixture(t, { login: { status: async ({ signal }) => { signals.push(signal); if (signals.length === 8) entered.resolve(); await pending.promise; return { ok: true }; } } });
  assert.equal((await f.request('/desktop/session', post(' '.repeat(4097)))).status, 400);
  const requests = Array.from({ length: 8 }, () => f.request('/status')); await entered.promise;
  assert.equal((await f.request('/status')).status, 429);
  f.api.dispose(); await Promise.all(requests); assert.ok(signals.every(s => s.aborted)); pending.resolve();
});

test('async start disposal cancels backend promptly, invalidates captured routes, and cleans route registrations', async t => {
  const pending = deferred(), entered = deferred(); let stops = 0;
  const f = await fixture(t, { desktop: { start: async () => { entered.resolve(); await pending.promise; return { wsPath: root + '/desktop/ws', protocols: ['binary', 'secret'], expiresAt: Date.now() + 120000, sessionExpiresAt: Date.now() + 600000 }; }, stop: () => { stops++; } } });
  const oldRoute = f.routes.get(root + '/desktop/session');
  const request = f.request('/desktop/session', post()); await entered.promise;
  assert.equal((await f.request('/desktop/session', post())).status, 400);
  f.dispose(); assert.ok(stops >= 1); assert.equal(f.routes.size, 0); assert.equal(f.upgrades.size, 0);
  const response = await request; assert.equal(response.status, 400); assert.equal(response.headers['set-cookie'], undefined);
  pending.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.ok(stops >= 2);
  assert.ok(oldRoute); assert.equal(f.calls.filter(([name]) => name === 'desktop.dispose').length, 1);
  f.api.dispose(); assert.equal(f.calls.filter(([name]) => name === 'desktop.dispose').length, 1);
});

test('browser disconnect aborts QR and cancels pending desktop start before it resolves', async t => {
  const entered = deferred(), pending = deferred(), stopped = deferred(); let signal;
  const f = await fixture(t, { desktop: { start: async () => { entered.resolve(); await pending.promise; return f.prepared(); }, stop: () => stopped.resolve() } });
  const req = http.request(f.origin + root + '/desktop/session', { method: 'POST', headers: { 'x-auth': 'yes', origin: f.origin, 'content-type': 'application/json' } });
  req.on('error', () => {}); req.end('{}'); await entered.promise; req.destroy(); await stopped.promise;
  pending.resolve(); await new Promise(resolve => setImmediate(resolve));
  const qrEntered = deferred(), qrStopped = deferred();
  const q = await fixture(t, { login: { qr: async options => { signal = options.signal; signal.addEventListener('abort', () => qrStopped.resolve(), { once: true }); qrEntered.resolve(); return new Promise(() => {}); } } });
  const qr = http.request(q.origin + root + '/qr', { method: 'POST', headers: { 'x-auth': 'yes', origin: q.origin, 'content-type': 'application/json' } });
  qr.on('error', () => {}); qr.end('{}'); await qrEntered.promise; qr.destroy(); await qrStopped.promise; assert.equal(signal.aborted, true);
});

test('WS wrapper catches backend exceptions and blocks revoked authentication and post-disposal callbacks', async t => {
  let upgrades = 0;
  const f = await fixture(t, { desktop: { upgrade: async () => { upgrades++; throw new Error('private backend capability must not leak'); } } });
  const cookie = cookieOf(await f.request('/desktop/session', post()));
  const thrown = await f.upgrade('/desktop/ws', { cookie }); assert.match(thrown, /^HTTP\/1.1 403/); assert.doesNotMatch(thrown, /private/); assert.equal(upgrades, 1);
  f.setAuth(false); assert.match(await f.upgrade('/desktop/ws', { cookie }), /^HTTP\/1.1 403/); assert.equal(upgrades, 1);
  f.setAuth(true); f.api.dispose(); assert.match(await f.upgrade('/desktop/ws', { cookie }), /^HTTP\/1.1 403/); assert.equal(upgrades, 1);
  assert.equal((await f.request('/status')).status, 400);
});
