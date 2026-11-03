import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createOriginalLogin, originalRedirect } from '../original-login.js';

const path = '/vnc.html?autoconnect=1&resize=scale';
const html = '<!DOCTYPE html><html><head><title>noVNC</title></head><body id="noVNC_container"></body></html>';
const page = (body = html, options = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...options });
function fixture(options = {}) {
  const calls = [], requests = [];
  const login = createOriginalLogin({
    mode: 'docker', container: 'SnowLuma_1.test-2',
    run: async (...args) => { calls.push(args); return '0.0.0.0:6081\n[::]:6082\n'; },
    fetcher: async (...args) => { requests.push(args); return page(); },
    ...options,
  });
  return { login, calls, requests };
}

test('discovers first existing Docker publication, then locally GET-probes noVNC without credentials', async () => {
  const f = fixture();
  assert.deepEqual(await f.login.target(), { port: 6081, path });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'docker');
  assert.deepEqual(f.calls[0][1], ['port', 'SnowLuma_1.test-2', '6081/tcp']);
  assert.equal(f.calls[0][2].timeoutMs, 8000);
  assert.ok(f.calls[0][2].signal instanceof AbortSignal);
  const [url, options] = f.requests[0];
  assert.equal(url, 'http://127.0.0.1:6081/vnc.html');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(options.headers, { accept: 'text/html' });
  assert.ok(options.signal instanceof AbortSignal);
});

for (const [binding, port] of [['127.0.0.1:1', 1], ['0.0.0.0:65535', 65535], ['[::]:16081', 16081], [':::6081', 6081], ['[::1]:6081', 6081]]) {
  test(`accepts Docker host binding ${binding} but probes only IPv4 loopback`, async () => {
    const f = fixture({ run: async () => binding });
    assert.deepEqual(await f.login.target(), { port, path });
    assert.equal(f.requests[0][0], `http://127.0.0.1:${port}/vnc.html`);
  });
}

for (const output of ['', '6081', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:-1', '127.0.0.1:1x', 'evil.example:6081', 'http://127.0.0.1:6081', '127.0.0.1:6081/vnc.html', '[broken]:6081', 'not a binding\n0.0.0.0:6081', '0.0.0.0:6081\n' + 'x'.repeat(32769)]) {
  test(`rejects invalid Docker publication ${output.slice(0, 45)}`, async () => {
    const f = fixture({ run: async () => output });
    await assert.rejects(f.login.target(), /noVNC 尚未就绪/);
    assert.equal(f.requests.length, 0);
  });
}

test('container is shell-free and validated before execution', () => {
  for (const container of ['', '-snowluma', 'snowluma;id', '$(id)', 'snow\nluma', 'x'.repeat(129), undefined, null]) {
    assert.throws(() => fixture({ container }), /容器名无效/);
  }
});

for (const mode of ['native', 'external', undefined]) test(`${mode} uses legacy fallback without commands or probes`, async () => {
  const f = fixture({ mode, container: 'unused;not-a-command' });
  assert.equal(await f.login.target(), null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.requests, []);
});

test('command failures are sanitized and do not probe, start services, read passwords or publish ports', async () => {
  const f = fixture({ run: async () => { throw new Error('synthetic-secret from docker'); } });
  await assert.rejects(f.login.target(), error => /noVNC 尚未就绪/.test(error.message) && !error.message.includes('synthetic-secret'));
  assert.equal(f.requests.length, 0);
});

for (const [label, fetcher] of [
  ['connection refused', async () => { throw new Error('synthetic-secret refused'); }],
  ['non-success', async () => page(html, { status: 404 })],
  ['unrecognized service', async () => page('<html><title>Unrelated app</title></html>')],
  ['non-HTML body', async () => page('noVNC')],
  ['wrong content type', async () => page(html, { headers: { 'content-type': 'application/json' } })],
  ['redirect', async () => ({ ok: true, redirected: true, body: new ReadableStream() })],
  ['oversized header', async () => page(html, { headers: { 'content-length': '262145' } })],
  ['oversized stream', async () => page(html + 'x'.repeat(262144))],
]) test(`unready probe: ${label}`, async () => {
  const f = fixture({ fetcher });
  await assert.rejects(f.login.target(), error => /noVNC 尚未就绪/.test(error.message) && !error.message.includes('synthetic-secret'));
});

test('body bytes are bounded and oversized/invalid bodies are cancelled', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(html)); controller.enqueue(new Uint8Array(262144)); },
    cancel() { cancelled = true; },
  });
  const f = fixture({ fetcher: async () => new Response(body) });
  await assert.rejects(f.login.target(), /noVNC 尚未就绪/);
  assert.equal(cancelled, true);
});

test('exactly 256KB noVNC body is accepted', async () => {
  const f = fixture({ fetcher: async () => page(html + ' '.repeat(262144 - Buffer.byteLength(html))) });
  assert.deepEqual(await f.login.target(), { port: 6081, path });
});

test('already-cancelled request does not execute a command', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.login.target({ signal: controller.signal }), /已取消/);
  assert.equal(f.calls.length, 0);
});

test('cancellation stops waiting on a command that ignores its signal and suppresses late errors', async () => {
  let reject, commandSignal;
  const f = fixture({ run: (_bin, _args, options) => { commandSignal = options.signal; return new Promise((_resolve, fail) => { reject = fail; }); } });
  const controller = new AbortController(), result = f.login.target({ signal: controller.signal });
  await setImmediate(); controller.abort();
  await assert.rejects(result, /已取消/);
  assert.equal(commandSignal.aborted, true);
  reject(new Error('late error'));
  assert.equal(f.requests.length, 0);
});

test('dispose aborts a hanging body read, cancels body, and prevents another operation', async () => {
  let streamCancelled = false, fetchSignal;
  const f = fixture({ fetcher: async (_url, options) => {
    fetchSignal = options.signal;
    return new Response(new ReadableStream({ cancel() { streamCancelled = true; } }));
  } });
  const result = f.login.target();
  await setImmediate(); f.login.dispose();
  await assert.rejects(result, /已取消/);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(streamCancelled, true);
  await assert.rejects(f.login.target(), /已取消/);
  assert.equal(f.calls.length, 1);
});

test('4s probe deadline bounds an injected fetch that ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probeSignal;
  const f = fixture({ fetcher: (_url, options) => { probeSignal = options.signal; return new Promise(() => {}); } });
  const result = f.login.target();
  await setImmediate();
  t.mock.timers.tick(4000);
  await assert.rejects(result, /noVNC 尚未就绪/);
  assert.equal(probeSignal.aborted, true);
});

test('8s command deadline bounds an injected runner that ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let commandSignal;
  const f = fixture({ run: (_bin, _args, options) => { commandSignal = options.signal; return new Promise(() => {}); } });
  const result = f.login.target();
  await setImmediate();
  t.mock.timers.tick(8000);
  await assert.rejects(result, /noVNC 尚未就绪/);
  assert.equal(commandSignal.aborted, true);
  assert.equal(f.requests.length, 0);
});

const req = (host, encrypted = false, extra = {}) => ({ headers: { host, ...extra }, socket: { encrypted } });
for (const [host, expected] of [
  ['example.test:3080', 'example.test:6081'], ['example.test', 'example.test:6081'],
  ['127.0.0.1:3080', '127.0.0.1:6081'], ['localhost', 'localhost:6081'],
  ['[2001:db8::1]:3080', '[2001:db8::1]:6081'], ['[::1]', '[::1]:6081'],
]) test(`redirect keeps request hostname ${host} and changes only port/path`, () => {
  assert.equal(originalRedirect(req(host), { port: 6081, path }), `http://${expected}${path}`);
  assert.equal(originalRedirect(req(host, true), { port: 6081, path }), `https://${expected}${path}`);
});

test('redirect protocol derives only from socket encryption, never proxy headers or origin', () => {
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.test', forwarded: 'proto=https;host=attacker.test', origin: 'https://attacker.test' };
  assert.equal(originalRedirect(req('qq.test:3080', false, headers), { port: 6081, path }), `http://qq.test:6081${path}`);
  assert.equal(originalRedirect(req('qq.test:3080', true, { 'x-forwarded-proto': 'http' }), { port: 6081, path }), `https://qq.test:6081${path}`);
});

for (const host of [undefined, null, [], ['qq.test'], '', ' qq.test', 'qq.test ', 'qq.test\r\nX: 1', 'qq.test\t', 'qq.test,evil.test', 'qq.test/evil', 'qq.test\\evil', 'qq.test?x=1', 'qq.test#x', 'user@qq.test', 'http://qq.test', '//qq.test', 'qq.test:', 'qq.test:0', 'qq.test:65536', 'qq.test:-1', 'qq.test:abc', '::1:3080', '[::1', '[:::1]:3080', '[::1]:80:90', 'bad..test', '-bad.test', 'bad-.test', '.test', 'a'.repeat(64) + '.test']) {
  test(`rejects malformed Host ${String(host).slice(0, 45)}`, () => {
    assert.throws(() => originalRedirect(req(host), { port: 6081, path }), /Host 无效/);
  });
}

test('redirect accepts no arbitrary target URL, path, port, password or query', () => {
  for (const target of [null, {}, { port: 0, path }, { port: 65536, path }, { port: '6081', path }, { port: 6081.5, path }, { port: 6081, path: 'https://attacker.test/' }, { port: 6081, path: '/vnc.html?password=secret' }]) {
    assert.throws(() => originalRedirect(req('example.test'), target), /目标无效/);
  }
});
