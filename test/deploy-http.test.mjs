import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { registerDeploymentHttp } from '../deploy-http.js';

const root = '/dsh-qq/deploy';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const post = (body = { confirm: true }, headers = {}) => ({ method: 'POST', body, headers });
const safeHeaders = result => {
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.match(result.headers['content-type'], /^application\/json/);
};

async function fixture(t, options = {}) {
  const routes = new Map(), effects = [], calls = [], clients = new Set();
  let authenticated = true, disposed = false;
  const deployment = {
    status: async (...args) => { calls.push(['status', ...args]); return { ok: true, host: { platform: 'linux' }, task: null }; },
    start: async (...args) => { calls.push(['start', ...args]); return { id: 'start-1', state: 'running' }; },
    resume: async (...args) => { calls.push(['resume', ...args]); return { id: 'resume-1', state: 'running' }; },
    dispose: () => { calls.push(['dispose']); }, ...options.deployment,
  };
  const ctx = {
    effect: fn => { const dispose = fn(); if (dispose) effects.push(dispose); },
    connection: options.missingConnection ? undefined : { requestRejection(req) {
      calls.push(['auth', req.url]);
      if (options.throwAuth) throw new Error('AUTH_SECRET=/root/private');
      if (Object.hasOwn(options, 'authResult')) return options.authResult;
      if (!authenticated || req.headers['x-auth'] !== 'yes') return 401;
      if (req.headers.host !== authority) return 403;
      if (req.headers.origin && ![`http://${authority}`, `https://${authority}`].includes(req.headers.origin)) return 403;
    } },
    webServer: { register(route) {
      assert.equal(route.kind, 'exact');
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route.handler); return () => routes.delete(route.path);
    } },
    tools: { register() { throw new Error('deployment must never be a model tool'); } },
  };
  const api = registerDeploymentHttp({ ctx, deployment });
  const server = http.createServer((req, res) => {
    if (options.encrypted) req.socket.encrypted = true;
    req.url = req.url.replace(/^\/dsh(?=\/)/, '');
    options.onRequest?.(req, res);
    const route = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    route(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('UNHANDLED'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const authority = options.publicHost || `127.0.0.1:${port}`, origin = `http://${authority}`;
  const transport = `http://127.0.0.1:${port}`;
  const open = (path, { method = 'GET', headers = {}, auth = true, prefix = '' } = {}) => {
    let req;
    const response = new Promise((resolve, reject) => {
      req = http.request(transport, { path: prefix + root + path, method, headers: {
        host: authority, ...(auth ? { 'x-auth': 'yes' } : {}),
        ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers,
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString(); let json;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      clients.add(req); req.once('close', () => clients.delete(req)); req.on('error', reject);
    });
    return { req, response };
  };
  const request = (path, options = {}) => {
    const { req, response } = open(path, options);
    req.end(options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    return response;
  };
  const dispose = () => { if (!disposed) { disposed = true; api.dispose(); for (const fn of effects.reverse()) fn(); } };
  t.after(async () => { dispose(); for (const req of clients) req.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { api, routes, calls, request, open, dispose, origin, setAuth: value => { authenticated = value; } };
}
const managerCalls = f => f.calls.filter(([action]) => ['status', 'start', 'resume', 'dispose'].includes(action));

test('only three exact browser routes; every route authenticates before backend work', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.routes.keys()], [root + '/status', root + '/start', root + '/resume']);
  for (const [path, opts] of [['/status', {}], ['/start', post()], ['/resume', post()]]) {
    const r = await f.request(path, { ...opts, auth: false });
    assert.equal(r.status, 401); safeHeaders(r);
  }
  assert.deepEqual(managerCalls(f), []);
  f.setAuth(false); assert.equal((await f.request('/status')).status, 401);
});

test('missing, throwing, or invalid Connection rejection fails closed and never leaks errors', async t => {
  for (const options of [{ missingConnection: true }, { throwAuth: true }, { authResult: null }, { authResult: false }, { authResult: Promise.resolve() }, { authResult: 500 }]) {
    const f = await fixture(t, options);
    for (const [path, opts] of [['/status', {}], ['/start', post()], ['/resume', post()]]) {
      const r = await f.request(path, opts); assert.equal(r.status, 403); safeHeaders(r);
      assert.doesNotMatch(r.text, /AUTH_SECRET|root\/private/);
    }
    assert.deepEqual(managerCalls(f), []);
  }
});

test('all mutation validation is before start/resume, including auth, origin, POST and JSON', async t => {
  const f = await fixture(t);
  for (const path of ['/start', '/resume']) for (const options of [
    { method: 'GET' }, { method: 'HEAD' }, { method: 'PUT', body: '{"confirm":true}' },
    { method: 'DELETE' }, { method: 'OPTIONS' },
    post(undefined, { origin: '' }), post(undefined, { origin: 'http://evil.example' }),
    post(undefined, { host: 'wrong.example', origin: 'http://wrong.example' }),
    post(undefined, { 'sec-fetch-site': 'cross-site' }), post(undefined, { 'sec-fetch-site': 'same-site' }),
    post(undefined, { 'content-type': 'text/plain' }), post(undefined, { 'content-type': 'application/jsonx' }),
    post(''), post('true'), post('[]'), post('null'), post('1'), post('"text"'), post('{bad'),
  ]) assert.notEqual((await f.request(path, options)).status, 200);
  assert.deepEqual(managerCalls(f), []);
});

test('start accepts only the fixed boolean fields and optional <=200 character image', async t => {
  const f = await fixture(t);
  const input = { confirm: true, installDocker: true, installWsl: false, authorized: true, injectionRisk: true, publicDesktop: false, allowExistingPublicPorts: false, image: 'x'.repeat(200) };
  const result = await f.request('/start', post(input));
  assert.equal(result.status, 200); safeHeaders(result);
  assert.deepEqual(result.json, { ok: true, task: { id: 'start-1', state: 'running' } });
  assert.deepEqual(managerCalls(f), [['start', input]]);
  assert.equal((await f.request('/start', post({ confirm: true }))).status, 200);
  for (const field of ['confirm', 'installDocker', 'installWsl', 'authorized', 'injectionRisk', 'publicDesktop', 'allowExistingPublicPorts']) {
    for (const value of ['true', 1, 0, null, [], {}]) {
      assert.equal((await f.request('/start', post({ confirm: true, [field]: value }))).status, 400);
    }
  }
  for (const input of [{}, { confirm: false }, { confirm: true, image: null }, { confirm: true, image: 1 }, { confirm: true, image: [] }, { confirm: true, image: 'x'.repeat(201) }]) {
    assert.equal((await f.request('/start', post(input))).status, 400);
  }
  assert.equal(managerCalls(f).length, 2);
});

test('unknown and prototype-like fields cannot reach start and resume accepts only {confirm:true}', async t => {
  const f = await fixture(t);
  for (const field of ['command', 'container', 'port', 'token', 'signal', 'backend', 'mode', 'env', '__proto__', 'constructor', 'prototype']) {
    const input = `{"confirm":true,"${field}":true}`;
    for (const path of ['/start', '/resume']) assert.equal((await f.request(path, post(input))).status, 400);
  }
  for (const input of [{}, { confirm: false }, { confirm: 1 }, { confirm: 'true' }, { confirm: true, installDocker: true }, { confirm: true, image: 'snowluma' }]) {
    assert.equal((await f.request('/resume', post(input))).status, 400);
  }
  assert.deepEqual(managerCalls(f), []);
  const r = await f.request('/resume', post()); assert.equal(r.status, 200); safeHeaders(r);
  assert.deepEqual(r.json, { ok: true, task: { id: 'resume-1', state: 'running' } });
  assert.deepEqual(managerCalls(f), [['resume', { confirm: true }]]);
});

test('status is GET-only, zero-argument and returns the complete manager result without wrapping', async t => {
  const expected = { ok: true, host: { platform: 'linux', arch: 'x64' }, docker: { installed: false }, selected: { container: 'chosen' }, defaults: { image: 'upstream/image' }, existing: { exists: false }, warnings: [], task: null };
  let reads = 0;
  const f = await fixture(t, { deployment: { status: async (...args) => { assert.deepEqual(args, []); reads++; return expected; } } });
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) assert.notEqual((await f.request('/status', { method, body: '{}' })).status, 200);
  const result = await f.request('/status', { body: '{bad', headers: { 'content-length': '4' } });
  assert.equal(result.status, 200); assert.deepEqual(result.json, expected); safeHeaders(result);
  assert.equal(reads, 1); assert.deepEqual(managerCalls(f), []);
});

test('GET status does not wait for or read an unfinished request body', async t => {
  const f = await fixture(t);
  const { req, response } = f.open('/status', { headers: { 'content-length': '100' } });
  req.flushHeaders();
  const r = await response;
  assert.equal(r.status, 200); req.destroy();
  assert.deepEqual(managerCalls(f), [['status']]);
});

test('query parameters are forbidden on every route before body consumption or manager calls', async t => {
  const f = await fixture(t);
  for (const [path, opts] of [['/status', {}], ['/start', post()], ['/resume', post()]]) {
    for (const query of ['?', '?token=private', '?image=changed']) {
      const r = await f.request(path + query, opts); assert.equal(r.status, 400); safeHeaders(r);
      assert.doesNotMatch(r.text, /private|changed/);
    }
  }
  assert.deepEqual(managerCalls(f), []);
});

for (const prefix of ['', '/dsh']) test(`authenticated public HTTP and trusted TLS origin support proxy mount ${prefix || '/'}`, async t => {
  const f = await fixture(t, { publicHost: 'qq.example.test:3080' });
  for (const origin of ['http://qq.example.test:3080', 'https://qq.example.test:3080']) {
    const r = await f.request('/start', { ...post(undefined, { origin, 'sec-fetch-site': 'same-origin' }), prefix });
    assert.equal(r.status, 200); safeHeaders(r);
  }
  for (const headers of [{ origin: 'https://evil.test' }, { origin: 'https://qq.example.test:3080/path' }, { origin: 'null' }, { origin: 'ftp://qq.example.test:3080' }, { origin: 'http://qq.example.test:3080?x=1' }]) {
    assert.notEqual((await f.request('/resume', { ...post(undefined, headers), prefix })).status, 200);
  }
  assert.equal(managerCalls(f).length, 2);
});

test('body size limit is byte-based for content-length and chunked JSON, boundary 4096 is accepted', async t => {
  const f = await fixture(t);
  const boundary = '{"confirm":true}' + ' '.repeat(4096 - '{"confirm":true}'.length);
  assert.equal((await f.request('/start', post(boundary))).status, 200);
  for (const headers of [{ 'content-length': '4097' }, { 'transfer-encoding': 'chunked' }]) {
    const r = await f.request('/start', post(boundary + ' ', headers)); assert.equal(r.status, 400); safeHeaders(r);
  }
  // The character count is <4096, but UTF-8 encoded input exceeds the byte cap.
  const r = await f.request('/start', post('{"confirm":true,"image":"' + '界'.repeat(1500) + '"}'));
  assert.equal(r.status, 400); assert.equal(managerCalls(f).length, 1);
});

test('slow unfinished JSON body times out at ten seconds without starting installation', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const { req, response } = f.open('/start', { method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
  const started = Date.now(); req.write('{"confirm":');
  const r = await response;
  assert.equal(r.status, 400); assert.match(r.json.error, /超时/); safeHeaders(r);
  assert.ok(Date.now() - started >= 9_500); assert.ok(Date.now() - started < 14_000);
  assert.deepEqual(managerCalls(f), []); req.destroy();
});

test('eight active requests maximum across all routes; request disposal frees waiters, not manager lifecycle', async t => {
  const entered = deferred(), pending = deferred(); let count = 0;
  const f = await fixture(t, { deployment: { status: async (...args) => { assert.deepEqual(args, []); if (++count === 8) entered.resolve(); return pending.promise; } } });
  const requests = Array.from({ length: 8 }, () => f.request('/status'));
  await entered.promise;
  for (const [path, opts] of [['/status', {}], ['/start', post()], ['/resume', post()]]) {
    const r = await f.request(path, opts); assert.equal(r.status, 429); safeHeaders(r);
  }
  f.api.dispose();
  const results = await Promise.all(requests); assert.ok(results.every(r => r.status === 400));
  assert.deepEqual(managerCalls(f), []); pending.resolve({ ok: true });
  assert.equal(f.routes.size, 0);
});

test('partial body disposal cancels IO and stale captured callbacks cannot start work', async t => {
  const accepted = deferred();
  const f = await fixture(t, { onRequest: () => accepted.resolve() });
  const callback = f.routes.get(root + '/start');
  const { req, response } = f.open('/start', { method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
  req.write('{"confirm":'); await accepted.promise; await tick();
  f.api.dispose(); f.api.dispose();
  const result = await response; assert.equal(result.status, 400); safeHeaders(result);
  assert.deepEqual(managerCalls(f), []); assert.equal(f.routes.size, 0); req.destroy();
  // Re-expose a stale handler, emulating an already-dispatched callback after unload.
  f.routes.set(root + '/start', callback);
  assert.equal((await f.request('/start', post())).status, 400);
  assert.deepEqual(managerCalls(f), []);
});

test('HTTP disposal cancels waiting only and does not dispose or abort a host operation', async t => {
  for (const action of ['start', 'resume']) {
    const entered = deferred(), pending = deferred(); let completed = false;
    const f = await fixture(t, { deployment: { [action]: async (...args) => {
      assert.deepEqual(args, [{ confirm: true }]); entered.resolve();
      await pending.promise; completed = true; return { id: 'late-host-task', state: 'succeeded' };
    } } });
    const request = f.request('/' + action, post()); await entered.promise;
    f.api.dispose();
    const r = await request; assert.equal(r.status, 400); assert.equal(completed, false);
    assert.deepEqual(managerCalls(f), []);
    pending.resolve(); await tick(); assert.equal(completed, true);
  }
});

test('HTTP disconnect never owns manager operation lifetime and late rejection is observed/redacted', async t => {
  const entered = deferred(), closed = deferred(), pending = deferred(); let finished = false;
  const f = await fixture(t, {
    onRequest: (_req, res) => res.once('close', () => closed.resolve()),
    deployment: { start: async (...args) => {
      assert.deepEqual(args, [{ confirm: true }]); entered.resolve();
      try { await pending.promise; } finally { finished = true; }
    } },
  });
  const { req, response } = f.open('/start', post());
  const rejected = response.catch(() => {}); req.end('{"confirm":true}');
  await entered.promise; req.destroy(); await closed.promise; await tick(); await rejected;
  assert.equal(finished, false); assert.deepEqual(managerCalls(f), []);
  // A disconnected operation is still owned by the host manager, not the socket.
  assert.equal((await f.request('/status')).status, 200);
  pending.reject(new Error('late SUBPROCESS_SECRET=/root/private')); await tick(); assert.equal(finished, true);
});

test('all backend thrown errors are generic, including stdout/stderr secrets and lookalike validation messages', async t => {
  for (const action of ['status', 'start', 'resume']) {
    for (const error of [new Error('TOKEN=secret /root/private\nstdout password'), new Error('部署操作需要明确确认 TOKEN=secret'), { message: 'TOKEN=secret', stderr: 'password' }, 'TOKEN=secret', null]) {
      const f = await fixture(t, { deployment: { [action]: async () => { throw error; } } });
      const r = await f.request('/' + action, action === 'status' ? {} : post());
      assert.equal(r.status, 400); safeHeaders(r);
      assert.deepEqual(r.json, { ok: false, error: '部署请求失败；请刷新状态核查宿主任务' });
      assert.doesNotMatch(r.text, /TOKEN|secret|root\/private|stdout|password/);
    }
  }
});
