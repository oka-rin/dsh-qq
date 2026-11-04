import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { registerLoginHttp } from '../login-http.js';
import { createOriginalLogin, originalRedirect } from '../original-login.js';

const root = '/dsh-qq/login';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const routes = new Map(), upgrades = new Map(), disposers = [], calls = [];
  let authenticated = true, disposed = false;
  const prepared = () => ({ wsPath: root + '/desktop/ws', protocols: ['binary', 'dsh-qq-session.synthetic-secret'], expiresAt: Date.now() + 120000, sessionExpiresAt: Date.now() + 600000 });
  const login = {
    status: async ({ signal }) => { calls.push(['status', signal]); return { ok: true, state: 'unavailable' }; },
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
      if (host !== authority) return 403;
      if (req.headers.origin && ![`http://${host}`, `https://${host}`].includes(req.headers.origin)) return 403;
    } },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
      registerUpgrade(route) { upgrades.set(route.path, route.handler); return () => upgrades.delete(route.path); },
    },
  };
  const api = registerLoginHttp({ ctx, login, desktop, originalLogin: options.originalLogin, napcatLogin: options.napcatLogin, readBody: () => { throw new Error('must not use unbounded shared reader'); }, assetPath: fileURLToPath(new URL('../desktop-client.js', import.meta.url)) });
  const server = http.createServer((req, res) => {
    // Emulate a TLS carrier and a mount proxy stripping /dsh before routing.
    if (options.encrypted) req.socket.encrypted = true;
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
  const port = server.address().port, authority = options.publicHost || `127.0.0.1:${port}`, origin = `http://${authority}`;
  const transport = `http://127.0.0.1:${port}`;
  const dispose = () => { if (!disposed) { disposed = true; api.dispose(); for (const fn of disposers.reverse()) fn(); } };
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path, { method = 'GET', headers = {}, body, auth = true, prefix = '' } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(transport + prefix + root + path, { method, headers: { host: authority, ...(auth ? { 'x-auth': 'yes' } : {}), ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.end(data);
  });
  const upgrade = (path = '/desktop/ws', headers = {}, prefix = '') => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let result = '';
    socket.on('connect', () => socket.write(`GET ${prefix}${root}${path} HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${Object.entries({ host: authority, 'x-auth': 'yes', origin, ...headers }).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`));
    socket.on('data', chunk => { result += chunk; if (result.includes('\r\n\r\n')) { socket.destroy(); resolve(result); } });
    socket.on('error', reject);
  });
  return { request, upgrade, calls, api, dispose, routes, upgrades, origin, port, prepared, setAuth: value => { authenticated = value; } };
}
const cookieOf = response => response.headers['set-cookie'][0].split(';')[0];
const post = (body = {}, headers = {}) => ({ method: 'POST', body, headers });

test('every HTTP route and upgrade authenticates; absent/failing Connection fails closed', async t => {
  const f = await fixture(t);
  for (const [path, method] of [['/status', 'GET'], ['/original', 'GET'], ['/original/password', 'POST'], ['/desktop/session', 'POST'], ['/desktop/close', 'POST'], ['/desktop/view', 'GET'], ['/desktop/info', 'GET'], ['/desktop/viewer.js', 'GET']]) {
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
  const r = await f.request('/desktop/session', post({}, { origin: f.origin.replace('http:', 'https:') }));
  assert.equal(r.status, 200); assert.match(r.headers['set-cookie'][0], /; Secure/); assert.match(r.headers['set-cookie'][0], /; HttpOnly; SameSite=Strict/);
});

test('QR and refresh routes are absent; backend login status remains available', async t => {
  const f = await fixture(t);
  for (const action of ['qr', 'refresh']) {
    assert.equal(f.routes.has(root + '/' + action), false);
    for (const method of ['GET', 'POST']) assert.equal((await f.request('/' + action, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).status, 404);
  }
  const status = await f.request('/status');
  assert.equal(status.status, 200); assert.equal(status.json.state, 'unavailable');
  assert.ok(f.calls.some(([name]) => name === 'status'));
});

for (const prefix of ['', '/dsh']) test(`ordinary public HTTP Host supports authenticated desktop lifecycle at ${prefix || '/'}`, async t => {
  const f = await fixture(t, { publicHost: 'qq-login.example.test:3080' });
  const request = (path, options = {}) => f.request(path, { ...options, prefix });
  const upgrade = headers => f.upgrade('/desktop/ws', headers, prefix);
  assert.equal((await request('/desktop/session', { ...post(), auth: false })).status, 401);
  assert.equal((await request('/desktop/session', post({}, { origin: 'http://attacker.example' }))).status, 403);
  assert.equal((await request('/desktop/session', post({}, { origin: '' }))).status, 400);
  assert.equal((await request('/desktop/session', post({}, { 'sec-fetch-site': 'cross-site' }))).status, 400);
  assert.equal((await request('/desktop/session', post({}, { host: 'wrong.example', origin: 'http://wrong.example' }))).status, 403);
  assert.ok(!f.calls.some(([name]) => name === 'start'));
  const r = await request('/desktop/session', post());
  assert.equal(r.status, 200); const cookie = cookieOf(r);
  assert.match(r.headers['set-cookie'][0], /; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(r.headers['set-cookie'][0], /; Secure/);
  for (const page of ['view', 'info', 'viewer.js']) {
    assert.equal((await request('/desktop/' + page, { auth: false, headers: { cookie } })).status, 401);
    assert.equal((await request('/desktop/' + page)).status, 400);
    const response = await request('/desktop/' + page, { headers: { cookie } });
    assert.equal(response.status, 200);
    if (page === 'view') {
      assert.match(response.text, /HTTP 连接未加密/); assert.match(response.text, /id="close"/);
      assert.match(response.text, /不要发送到聊天/); assert.match(response.text, /刷新或断线后/);
    }
    if (page === 'info') assert.equal(response.json.wsPath, root + '/desktop/ws');
  }
  assert.match(await upgrade({ cookie, 'x-auth': 'no' }), /^HTTP\/1.1 403/);
  assert.match(await upgrade({ cookie, origin: 'http://attacker.example' }), /^HTTP\/1.1 403/);
  assert.match(await upgrade({ cookie, host: 'wrong.example', origin: 'http://wrong.example' }), /^HTTP\/1.1 403/);
  assert.match(await upgrade({}), /^HTTP\/1.1 403/);
  assert.ok(!f.calls.some(([name]) => name === 'upgrade'));
  assert.match(await upgrade({ cookie }), /^HTTP\/1.1 101/);
  assert.match(await upgrade({ cookie }), /^HTTP\/1.1 403/);
  for (const page of ['view', 'info', 'viewer.js']) assert.equal((await request('/desktop/' + page, { headers: { cookie } })).status, 400);
  assert.equal((await request('/desktop/close', post({}, { cookie, origin: 'http://attacker.example' }))).status, 403);
  assert.equal((await request('/desktop/close', post({}, { cookie }))).status, 200);
  assert.equal(f.calls.filter(([name]) => name === 'upgrade').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'stop').length, 1);
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

test('bounded tiny JSON and limited parallel operations; status receives cancellation signals', async t => {
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

test('browser disconnect aborts status and cancels pending desktop start before it resolves', async t => {
  const entered = deferred(), pending = deferred(), stopped = deferred(); let signal;
  const f = await fixture(t, { desktop: { start: async () => { entered.resolve(); await pending.promise; return f.prepared(); }, stop: () => stopped.resolve() } });
  const req = http.request(f.origin + root + '/desktop/session', { method: 'POST', headers: { 'x-auth': 'yes', origin: f.origin, 'content-type': 'application/json' } });
  req.on('error', () => {}); req.end('{}'); await entered.promise; req.destroy(); await stopped.promise;
  pending.resolve(); await new Promise(resolve => setImmediate(resolve));
  const statusEntered = deferred(), statusStopped = deferred();
  const q = await fixture(t, { login: { status: async options => { signal = options.signal; signal.addEventListener('abort', () => statusStopped.resolve(), { once: true }); statusEntered.resolve(); return new Promise(() => {}); } } });
  const status = http.request(q.origin + root + '/status', { headers: { 'x-auth': 'yes' } });
  status.on('error', () => {}); status.end(); await statusEntered.promise; status.destroy(); await statusStopped.promise; assert.equal(signal.aborted, true);
});

test('Docker original entry keeps DSH auth, never starts substitute desktop or exposes passwords', async t => {
  let targets = 0, disposed = 0;
  const f = await fixture(t, { originalLogin: {
    target: async ({ signal }) => { assert.equal(signal.aborted, false); targets++; return { port: 6081, path: '/vnc.html?autoconnect=1&resize=scale' }; },
    redirect: (_req, target) => `http://qq.example.test:${target.port}${target.path}`,
    dispose: () => { disposed++; },
  } });
  assert.equal((await f.request('/original', { auth: false })).status, 401); assert.equal(targets, 0);
  assert.equal((await f.request('/desktop/session', post({}, { origin: 'http://evil.test' }))).status, 403);
  const ready = await f.request('/desktop/session', { ...post(), prefix: '/dsh' });
  assert.equal(ready.status, 200); assert.equal(ready.json.url, '/dsh-qq/login/original');
  assert.equal(ready.json.provider, 'snowluma-original'); assert.equal(ready.headers['set-cookie'], undefined);
  assert.ok(!f.calls.some(([name]) => name === 'start'));
  const hop = await f.request('/original', { prefix: '/dsh' });
  assert.equal(hop.status, 302); assert.equal(hop.headers.location, 'http://qq.example.test:6081/vnc.html?autoconnect=1&resize=scale');
  assert.equal(hop.headers['cache-control'], 'no-store'); assert.doesNotMatch(hop.headers.location, /password|token/);
  assert.equal((await f.request('/original?url=http://evil.test')).status, 400);
  f.dispose(); assert.equal(disposed, 1);
});

test('mounted TLS GUI opens and copies from the same selected Docker container at its mapped HTTP port', async t => {
  const commands = [], probes = [];
  const container = 'Selected_QQ.test-2';
  const original = createOriginalLogin({
    mode: 'docker', container,
    run: async (bin, args) => {
      commands.push([bin, args]);
      if (args[0] === 'port') return '[::]:16081\n127.0.0.1:26081\n';
      if (args[0] === 'inspect') return JSON.stringify(['VNC_PASSWD=testpass', 'OTHER=synthetic-private']);
      if (args[0] === 'exec') return Buffer.from('87803c720bbb91d5', 'hex');
      throw new Error('unexpected lifecycle operation');
    },
    fetcher: async (url, options) => {
      probes.push([url, options]);
      return new Response('<html><title>noVNC</title></html>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const f = await fixture(t, { encrypted: true, publicHost: 'qq.example.test:3080', originalLogin: { ...original, redirect: originalRedirect } });
  for (const options of [{ ...post(), auth: false }, post({}, { origin: 'https://attacker.test' }), post({ container: 'other' }), post({ path: '/tmp/other' })]) {
    const denied = await f.request('/original/password', { ...options, prefix: '/dsh' });
    assert.notEqual(denied.status, 200); assert.doesNotMatch(denied.text, /testpass|synthetic-private/);
  }
  assert.deepEqual(commands, []);
  const ready = await f.request('/desktop/session', { ...post(), prefix: '/dsh' });
  assert.equal(ready.status, 200); assert.equal(ready.json.url, '/dsh-qq/login/original');
  const hop = await f.request('/original', { prefix: '/dsh' });
  assert.equal(hop.status, 302);
  assert.equal(hop.headers.location, 'http://qq.example.test:26081/vnc.html?autoconnect=1&resize=scale');
  assert.equal(hop.headers['cache-control'], 'no-store');
  assert.ok(!f.calls.some(([name]) => name === 'start'));
  assert.deepEqual(commands, Array.from({ length: 2 }, () => ['docker', ['port', container, '6081/tcp']]));
  assert.ok(probes.every(([url, options]) => url === 'http://127.0.0.1:26081/vnc.html' && options.redirect === 'error' && options.credentials === 'omit'));
  assert.doesNotMatch(JSON.stringify([ready, hop]), /testpass|synthetic-private/);
  const copied = await f.request('/original/password', { ...post(), prefix: '/dsh' });
  assert.equal(copied.status, 200); assert.deepEqual(copied.json, { ok: true, password: 'testpass' });
  assert.equal(copied.headers['cache-control'], 'no-store'); assert.equal(copied.headers.location, undefined);
  assert.deepEqual(commands.slice(2), [
    ['docker', ['inspect', '--format', '{{json .Config.Env}}', container]],
    ['docker', ['exec', container, 'head', '-c', '8', '/root/.vnc/passwd']],
  ]);
  assert.doesNotMatch(copied.text, /synthetic-private|root\/\.vnc/);
});

test('browser-only password POST authenticates, checks mutations, bounds JSON and projects only verified credential', async t => {
  let passwords = 0;
  const f = await fixture(t, { originalLogin: { password: async ({ signal }) => { assert.equal(signal.aborted, false); passwords++; return { ok: true, password: 'testpass', env: ['OTHER=synthetic-private'], path: '/root/private' }; } } });
  for (const [options, expected] of [
    [{ ...post(), auth: false }, 401], [{ method: 'GET' }, 400], [{ method: 'PUT', body: '{}' }, 400],
    [post({}, { origin: '' }), 400], [post({}, { origin: 'http://evil.test' }), 403],
    [post({}, { 'sec-fetch-site': 'cross-site' }), 400], [post({}, { 'content-type': 'text/plain' }), 400],
    [post({}, { host: 'wrong.test' }), 403], [post('true'), 400], [post('[]'), 400], [post('null'), 400],
    [post('{invalid'), 400], [post({ password: 'replacement' }), 400], [post(' '.repeat(4097)), 400],
  ]) { const denied = await f.request('/original/password', options); assert.equal(denied.status, expected); assert.equal(denied.headers['cache-control'], 'no-store'); assert.doesNotMatch(denied.text, /testpass|synthetic-private|root\/private/); }
  assert.equal(passwords, 0);
  assert.equal((await f.request('/original/password?token=x', post())).status, 400); assert.equal(passwords, 0);
  const result = await f.request('/original/password', { ...post(), prefix: '/dsh' });
  assert.equal(result.status, 200); assert.deepEqual(result.json, { ok: true, password: 'testpass' });
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers.location, undefined); assert.equal(result.headers['set-cookie'], undefined);
  assert.doesNotMatch(result.text, /synthetic-private|root\/private/); assert.equal(passwords, 1);
});

test('password only appears in explicit credential response, never discovery status session redirect or GET', async t => {
  let reads = 0;
  const f = await fixture(t, { originalLogin: {
    target: async () => ({ port: 6081, path: '/vnc.html?autoconnect=1&resize=scale' }),
    redirect: (_req, target) => `http://qq.test:${target.port}${target.path}`,
    password: async () => { reads++; return { ok: true, password: 'testpass' }; },
  } });
  for (const [path, options] of [['/status', {}], ['/desktop/session', post()], ['/original', {}], ['/original/password', {}]]) {
    const result = await f.request(path, options); assert.doesNotMatch(JSON.stringify(result), /testpass/);
  }
  assert.equal(reads, 0);
  assert.equal((await f.request('/original/password', post())).json.password, 'testpass'); assert.equal(reads, 1);
});

test('password is unavailable without original Docker backend and Connection fails closed', async t => {
  const absent = await fixture(t); assert.equal((await absent.request('/original/password', post())).status, 400);
  for (const options of [{ missingConnection: true }, { throwAuth: true }]) {
    let reads = 0;
    const f = await fixture(t, { ...options, originalLogin: { password: async () => { reads++; return { ok: true, password: 'testpass' }; } } });
    assert.equal((await f.request('/original/password', post())).status, 403); assert.equal(reads, 0);
  }
});

test('password backend rejection and malformed result cannot leak raw secrets or paths', async t => {
  for (const password of [async () => { throw new Error('testpass QQ_PASSWORD=synthetic-private /root/private'); }, async () => ({ ok: false, password: 'testpass', error: 'synthetic-private' }), async () => ({ ok: true, password: 'too-long-secret' }), async () => ({ ok: true, password: 'bad\npass' })]) {
    const f = await fixture(t, { originalLogin: { password } }); const result = await f.request('/original/password', post());
    assert.equal(result.status, 400); assert.match(result.json.error, /无法安全读取并核实/);
    assert.doesNotMatch(result.text, /testpass|synthetic-private|root\/private|too-long|bad/);
  }
});

test('credential reads have a six-per-minute cap in addition to global concurrency bound', async t => {
  let reads = 0;
  const f = await fixture(t, { originalLogin: { password: async () => { reads++; return { ok: true, password: 'testpass' }; } } });
  for (let i = 0; i < 6; i++) assert.equal((await f.request('/original/password', post())).status, 200);
  const denied = await f.request('/original/password', post()); assert.equal(denied.status, 429);
  assert.equal(denied.headers['cache-control'], 'no-store'); assert.equal(reads, 6); assert.doesNotMatch(denied.text, /testpass/);
});

test('credential route disposal and disconnect abort in-flight backend read without leaking late rejection', async t => {
  const entered = deferred(), stopped = deferred(); let signal, reject;
  const f = await fixture(t, { originalLogin: { password: async options => { signal = options.signal; signal.addEventListener('abort', () => stopped.resolve(), { once: true }); entered.resolve(); return new Promise((_resolve, fail) => { reject = fail; }); } } });
  const request = f.request('/original/password', post()); await entered.promise; f.api.dispose();
  const response = await request; assert.equal(response.status, 400); assert.equal(signal.aborted, true); assert.doesNotMatch(response.text, /testpass/);
  reject(new Error('late testpass')); await new Promise(resolve => setImmediate(resolve));
  const qEntered = deferred(), qStopped = deferred(); let qReject;
  const q = await fixture(t, { originalLogin: { password: async ({ signal }) => { signal.addEventListener('abort', () => qStopped.resolve(), { once: true }); qEntered.resolve(); return new Promise((_resolve, fail) => { qReject = fail; }); } } });
  const req = http.request(q.origin + root + '/original/password', { method: 'POST', headers: { 'x-auth': 'yes', origin: q.origin, 'content-type': 'application/json' } });
  req.on('error', () => {}); req.end('{}'); await qEntered.promise; req.destroy(); await qStopped.promise; qReject(new Error('late testpass'));
});

test('failed original service does not silently fall back to a substitute', async t => {
  const f = await fixture(t, { originalLogin: { target: async () => { throw new Error('原版网页桌面不可连接'); } } });
  const ready = await f.request('/desktop/session', post()); assert.equal(ready.status, 400);
  assert.match(ready.json.error, /原版/); assert.ok(!f.calls.some(([name]) => name === 'start'));
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

const napcatToken = 'test-only-napcat-token-0123456789';
function napcatBackend(overrides = {}) {
  return { target: async () => ({ provider: 'napcat', port: 6099 }), redirect: () => 'http://qq-login.example.test:6099/webui/', token: async () => ({ ok: true, token: napcatToken, internal: 'do-not-project' }), ...overrides };
}
test('NapCat official HTTP hop and explicit token action retain browser authentication/CSRF and no-store', async t => {
  let reads = 0;
  const f = await fixture(t, { napcatLogin: napcatBackend({ token: async () => { reads++; return { ok: true, token: napcatToken, password: 'never-project' }; } }) });
  for (const path of ['/napcat', '/napcat/token']) {
    assert.equal((await f.request(path, { auth: false, ...(path.endsWith('token') ? post() : {}) })).status, 401);
  }
  for (const options of [{ method: 'GET' }, post({}, { origin: '' }), post({}, { origin: 'http://evil.test' }), post({}, { 'sec-fetch-site': 'cross-site' }), post({}, { 'content-type': 'text/plain' }), post({ redirect: 'http://evil.test' }), post(' '.repeat(4097))]) {
    assert.notEqual((await f.request('/napcat/token', options)).status, 200);
  }
  assert.equal(reads, 0);
  const prepared = await f.request('/desktop/session', post());
  assert.equal(prepared.json.provider, 'napcat'); assert.equal(prepared.json.url, root + '/napcat');
  assert.doesNotMatch(prepared.text, /token|password/);
  assert.ok(!f.calls.some(([name]) => name === 'start'));
  const jump = await f.request('/napcat');
  assert.equal(jump.status, 302); assert.equal(jump.headers.location, 'http://qq-login.example.test:6099/webui/');
  assert.equal(jump.headers['cache-control'], 'no-store'); assert.equal(jump.headers['referrer-policy'], 'no-referrer');
  assert.notEqual((await f.request('/napcat?redirect=http://evil.test')).status, 302);
  const copied = await f.request('/napcat/token', post());
  assert.deepEqual(copied.json, { ok: true, token: napcatToken }); assert.equal(copied.headers['cache-control'], 'no-store');
  assert.equal(reads, 1);
  for (let i = 1; i < 6; i++) assert.equal((await f.request('/napcat/token', post())).status, 200);
  assert.equal((await f.request('/napcat/token', post())).status, 429); assert.equal(reads, 6);
});
test('NapCat token errors and malformed backend output never echo secrets or metadata', async t => {
  for (const token of ['', 'eightchr', 'a'.repeat(4097), 'a'.repeat(32) + '\n', 42]) {
    const f = await fixture(t, { napcatLogin: napcatBackend({ token: async () => ({ ok: true, token, password: napcatToken }) }) });
    const result = await f.request('/napcat/token', post()); assert.equal(result.status, 400); assert.doesNotMatch(result.text, /test-only-napcat|password/);
  }
  const f = await fixture(t, { napcatLogin: napcatBackend({ token: async () => { throw new Error(napcatToken); }, target: async () => { throw new Error(napcatToken); } }) });
  for (const [path, options] of [['/napcat/token', post()], ['/napcat', {}]]) { const r = await f.request(path, options); assert.equal(r.status, 400); assert.equal(r.text.includes(napcatToken), false); }
});
