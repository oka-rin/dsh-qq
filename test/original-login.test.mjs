import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createCipheriv } from 'node:crypto';
import { createOriginalLogin, originalRedirect } from '../original-login.js';
import { registerLoginHttp } from '../login-http.js';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Config } from '../index.js';
import fs from 'node:fs';
import vm from 'node:vm';

const endpoint = 'unix:///var/run/docker.sock';
const localArgs = args => ['--host', endpoint, ...args];

const path = '/vnc.html?autoconnect=1&resize=scale';
const html = '<!DOCTYPE html><html><head><title>noVNC</title></head><body id="noVNC_container"></body></html>';
const page = (body = html, options = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...options });
function fixture(options = {}) {
  const calls = [], requests = [];
  const login = createOriginalLogin({
    mode: 'docker', container: 'SnowLuma_1.test-2', platform: 'linux',
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
  assert.deepEqual(f.calls[0][1], localArgs(['port', 'SnowLuma_1.test-2', '6081/tcp']));
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

for (const [binding, port] of [['127.0.0.1:1', 1], ['0.0.0.0:65535', 65535], ['[::]:16081\n127.0.0.1:16082', 16082], ['192.0.2.10:6081\n0.0.0.0:16081', 16081]]) {
  test(`accepts Docker host binding ${binding} but probes only IPv4 loopback`, async () => {
    const f = fixture({ run: async () => binding });
    assert.deepEqual(await f.login.target(), { port, path });
    assert.equal(f.requests[0][0], `http://127.0.0.1:${port}/vnc.html`);
  });
}

for (const output of ['[::]:16081', ':::6081', '[::1]:6081', '192.0.2.10:6081', '[::1]:6081\n192.0.2.10:6082', '', '6081', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:-1', '127.0.0.1:1x', 'evil.example:6081', 'http://127.0.0.1:6081', '127.0.0.1:6081/vnc.html', '[broken]:6081', 'not a binding\n0.0.0.0:6081', '0.0.0.0:6081\n' + 'x'.repeat(32769)]) {
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

// Synthetic fixtures only: never inspect a live container's credential in tests.
function vncFile(value) {
  const key = Buffer.from([232, 74, 214, 96, 196, 114, 26, 224]);
  const input = Buffer.alloc(8); input.write(value.slice(0, 8), 'ascii');
  const cipher = createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(input), cipher.final()]);
}
function passwordFixture({ env = ['OTHER_SYNTHETIC=hidden', 'VNC_PASSWD=testpass'], file = vncFile('testpass'), run, ...options } = {}) {
  const calls = [];
  const f = fixture({ run: run || (async (bin, args, opts) => { calls.push([bin, args, opts]); return args[2] === 'inspect' ? JSON.stringify(env) : Buffer.from(file); }), ...options });
  return { ...f, calls };
}
for (const [platform, host] of [['linux', endpoint], ['win32', 'npipe:////./pipe/dockerDesktopLinuxEngine']]) {
  test(`${platform} pins every page and credential Docker command to the local engine, ignoring inherited context`, async t => {
    for (const [key, value] of Object.entries({ DOCKER_HOST: 'tcp://attacker.invalid:2375', DOCKER_CONTEXT: 'remote', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/private/cert', docker_config: '/private/config' })) {
      const previous = process.env[key]; process.env[key] = value;
      t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const calls = [];
    const f = fixture({ platform, run: async (bin, args, options) => {
      calls.push([bin, args, options]);
      if (args[2] === 'port') return '127.0.0.1:26081';
      if (args[2] === 'inspect') return '["VNC_PASSWD=testpass"]';
      if (args[2] === 'exec') return vncFile('testpass');
      throw new Error('unexpected Docker command');
    } });
    assert.deepEqual(await f.login.target(), { port: 26081, path });
    assert.deepEqual(await f.login.password(), { ok: true, password: 'testpass' });
    assert.deepEqual(calls.map(call => call[1]), [
      ['--host', host, 'port', 'SnowLuma_1.test-2', '6081/tcp'],
      ['--host', host, 'inspect', '--format', '{{json .Config.Env}}', 'SnowLuma_1.test-2'],
      ['--host', host, 'exec', 'SnowLuma_1.test-2', 'head', '-c', '8', '/root/.vnc/passwd'],
    ]);
    for (const [bin, , options] of calls) {
      assert.ok(bin === 'docker' || (platform === 'win32' && /[\\/]Docker[\\/]Docker[\\/]resources[\\/]bin[\\/]docker\.exe$/i.test(bin)));
      assert.equal(options.env.DOCKER_HOST, host);
      assert.deepEqual(Object.keys(options.env).filter(key => /^DOCKER_/i.test(key)), ['DOCKER_HOST']);
      assert.ok(options.signal instanceof AbortSignal); assert.equal(options.timeoutMs, 8000);
    }
    assert.deepEqual(calls.map(call => call[2].maxOutputBytes), [32768, 65536, 8]);
  });
}
test('unsupported Docker platforms fail before executing commands or probing', async () => {
  const f = fixture({ platform: 'darwin' });
  await assert.rejects(f.login.target(), /noVNC 尚未就绪/);
  await assert.rejects(f.login.password(), /无法安全读取并核实/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
});
test('bounded credential subprocess uses shell:false and the supplied safe environment on Windows too', async () => {
  const source = fs.readFileSync(new URL('../original-login.js', import.meta.url), 'utf8');
  const implementation = source.slice(source.indexOf('function credentialCommand('), source.indexOf('\nfunction effectivePassword('));
  const calls = [], env = { Path: 'C:\\Program Files\\Docker', DOCKER_HOST: 'npipe:////./pipe/dockerDesktopLinuxEngine' };
  const run = vm.runInNewContext(`(${implementation})`, { Buffer, setTimeout, clearTimeout,
    cancelled: () => new Error('cancelled'), passwordUnavailable: () => new Error('unavailable'),
    spawn: (bin, args, options) => {
      calls.push([bin, args, options]);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from('ok')); child.emit('close', 0); });
      return child;
    },
  });
  const args = ['--host', env.DOCKER_HOST, 'inspect'];
  assert.equal((await run('C:\\Program Files\\Docker\\docker.exe', args, { signal: new AbortController().signal, timeoutMs: 8000, maxOutputBytes: 8, env })).toString(), 'ok');
  assert.equal(calls[0][2].shell, false); assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].env, env); assert.equal(calls[0][1], args);
});
test('explicit password operation verifies original fixed password file with VNC DES key bit ordering', async () => {
  // Independently confirmed by x11vnc -storepasswd testpass on a temporary file.
  assert.equal(vncFile('testpass').toString('hex'), '87803c720bbb91d5');
  const f = passwordFixture();
  assert.deepEqual(await f.login.password(), { ok: true, password: 'testpass' });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0][1], localArgs(['inspect', '--format', '{{json .Config.Env}}', 'SnowLuma_1.test-2']));
  assert.deepEqual(f.calls[1][1], localArgs(['exec', 'SnowLuma_1.test-2', 'head', '-c', '8', '/root/.vnc/passwd']));
  assert.deepEqual(f.calls.map(call => call[2].maxOutputBytes), [65536, 8]);
  assert.ok(f.calls.every(call => call[0] === 'docker' && call[2].timeoutMs === 8000 && call[2].signal instanceof AbortSignal));
  assert.deepEqual(f.requests, []);
});
for (const value of ['a', 'abc def', '12345678', '12345678ignored-suffix']) test(`returns verified effective first eight bytes for synthetic password length ${value.length}`, async () => {
  const f = passwordFixture({ env: [`VNC_PASSWD=${value}`], file: vncFile(value) });
  assert.deepEqual(await f.login.password(), { ok: true, password: value.slice(0, 8) });
});
for (const env of [['VNC_PASSWD=testpass', 'VNC_PASSWD=testpass'], ['VNC_PASSWD=密码'], ['VNC_PASSWD=test\npass'], ['VNC_PASSWD=test\u0000pass'], ['VNC_PASSWD=' + 'a'.repeat(4097)], [null], null, {}]) test('ambiguous/unsupported VNC source fails closed without default', async () => {
  const f = passwordFixture({ env });
  await assert.rejects(f.login.password(), /无法安全读取并核实/);
  assert.equal(f.calls.length, 1);
});
for (const env of [[], ['VNC_PASSWD='], ['VNC_PASSWORD=not-the-vnc-source']]) test('unset/empty env uses authoritative actual fixed VNC file, never a guessed default', async () => {
  const f = passwordFixture({ env }); assert.deepEqual(await f.login.password(), { ok: true, password: 'testpass' }); assert.equal(f.calls.length, 2);
});
for (const value of ['a', 'abc def', '12345678']) test(`fixed-file fallback validates printable ASCII and zero-padding for length ${value.length}`, async () => {
  const f = passwordFixture({ env: [], file: vncFile(value) }); assert.deepEqual(await f.login.password(), { ok: true, password: value });
});
for (const value of ['', 'bad\u0000pad', 'bad\npass', '\u007f']) test('fixed-file fallback rejects empty, control, non-ASCII or malformed padding', async () => {
  const f = passwordFixture({ env: [], file: vncFile(value) }); await assert.rejects(f.login.password(), /无法安全读取并核实/);
});
for (const file of [Buffer.alloc(8), Buffer.alloc(7), Buffer.alloc(9), '87803c720bbb91d5']) test('unset env and corrupt fixed-file source fail closed without default', async () => {
  const f = passwordFixture({ run: async (_bin, args) => args[2] === 'inspect' ? '[]' : file }); await assert.rejects(f.login.password(), /无法安全读取并核实/);
});
for (const file of [Buffer.alloc(8), Buffer.alloc(7), Buffer.alloc(9), vncFile('changed'), '87803c720bbb91d5']) test('mismatched or invalid original password file never discloses env credential', async () => {
  const f = passwordFixture({ run: async (_bin, args) => args[2] === 'inspect' ? '["VNC_PASSWD=testpass"]' : file });
  await assert.rejects(f.login.password(), error => /无法安全读取并核实/.test(error.message) && !error.message.includes('testpass'));
});
for (const output of ['not JSON synthetic-secret', JSON.stringify(['VNC_PASSWD=testpass', 'OTHER=' + 'x'.repeat(65536)]), Buffer.alloc(65537)]) test('malformed/oversized environment output is sanitized', async () => {
  const f = passwordFixture({ run: async () => output });
  await assert.rejects(f.login.password(), error => /无法安全读取并核实/.test(error.message) && !error.message.includes('synthetic-secret'));
});
test('both credential commands sanitize injected rejection including stdout, host path and other credentials', async () => {
  for (const failAt of ['inspect', 'exec']) {
    const f = passwordFixture({ run: async (_bin, args) => { if (args[2] === failAt) throw new Error('testpass QQ_PASSWORD=synthetic-secret /root/private'); return '["VNC_PASSWD=testpass"]'; } });
    await assert.rejects(f.login.password(), error => /无法安全读取并核实/.test(error.message) && !/testpass|synthetic-secret|private/.test(error.message));
  }
});
for (const mode of ['native', 'external', undefined]) test(`password unavailable in ${mode} mode without reading any source`, async () => {
  const f = passwordFixture({ mode }); await assert.rejects(f.login.password(), /无法安全读取并核实/); assert.equal(f.calls.length, 0);
});
test('cancelled/disposed credential reads do not run, wait for or reveal late backend failures', async () => {
  let reject, commandSignal;
  const f = passwordFixture({ run: (_bin, _args, opts) => { commandSignal = opts.signal; return new Promise((_resolve, fail) => { reject = fail; }); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.login.password({ signal: controller.signal }), /已取消/);
  assert.equal(commandSignal, undefined);
  const result = f.login.password(); await setImmediate(); f.login.dispose();
  await assert.rejects(result, /已取消/); assert.equal(commandSignal.aborted, true);
  reject(new Error('late synthetic-secret')); await setImmediate();
  await assert.rejects(f.login.password(), /已取消/);
});
test('credential deadline includes both reads and handles an injected runner ignoring abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal;
  const f = passwordFixture({ run: async (_bin, args, options) => { signal = options.signal; if (args[2] === 'inspect') return '["VNC_PASSWD=testpass"]'; return new Promise(() => {}); } });
  const result = f.login.password(); await setImmediate(); t.mock.timers.tick(8000);
  await assert.rejects(result, /无法安全读取并核实/); assert.equal(signal.aborted, true);
});
test('credential source buffers are cleared after success and parse failure', async () => {
  const environment = Buffer.from('["VNC_PASSWD=testpass"]'), file = vncFile('testpass');
  const f = passwordFixture({ run: async (_bin, args) => args[2] === 'inspect' ? environment : file });
  assert.equal((await f.login.password()).ok, true); assert.ok(environment.every(b => b === 0)); assert.ok(file.every(b => b === 0));
  const bad = Buffer.from('malformed private-secret');
  const broken = passwordFixture({ run: async () => bad });
  await assert.rejects(broken.login.password(), /无法安全读取并核实/); assert.ok(bad.every(b => b === 0));
});

test('native Config is opt-in and accepts only integer ports in range', () => {
  assert.equal(Config({}).snowLumaDesktopPort, 0);
  for (const port of [0, 1, 6081, 65535]) assert.equal(Config({ snowLumaDesktopPort: port }).snowLumaDesktopPort, port);
  for (const port of [-1, 65536, 1.5, '6081', NaN, Infinity]) assert.throws(() => Config({ snowLumaDesktopPort: port }));
});

for (const port of [1, 6081, 65535]) test(`native original probes only fixed loopback noVNC at port ${port} without commands or credentials`, async () => {
  const f = fixture({ mode: 'native', nativePort: port, container: ';unused', host: 'attacker.test', path: '/arbitrary', url: 'https://attacker.test/' });
  assert.deepEqual(await f.login.target({ port: 4444, path: '/arbitrary', url: 'https://attacker.test/' }), { port, path });
  assert.deepEqual(f.calls, []);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][0], `http://127.0.0.1:${port}/vnc.html`);
  assert.equal(f.requests[0][1].redirect, 'error');
  assert.equal(f.requests[0][1].credentials, 'omit');
  assert.equal(f.requests[0][1].cache, 'no-store');
});
for (const nativePort of [-1, 65536, 1.5, '6081', NaN, Infinity, null, {}, '6081/vnc.html', 'http://attacker.test']) test('native original rejects malformed ports before any operation', () => {
  assert.throws(() => fixture({ mode: 'native', nativePort }), /原生端口无效/);
});
for (const mode of ['external', undefined]) test(`native port never enables original login in ${mode} mode`, async () => {
  const f = fixture({ mode, nativePort: 6081 });
  assert.equal(await f.login.target(), null);
  await assert.rejects(f.login.password(), /无法安全读取并核实/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
});
test('Docker original ignores native port and still discovers the existing publication', async () => {
  const f = fixture({ nativePort: 4444 });
  assert.deepEqual(await f.login.target(), { port: 6081, path });
  assert.equal(f.calls[0][0], 'docker');
});
test('native probe rejects redirects, unrelated services and oversized output without a legacy fallback', async () => {
  for (const fetcher of [async () => page('<html>unrelated</html>'), async () => ({ ok: true, redirected: true }), async () => page(html + 'x'.repeat(262144)), async () => { throw new Error('synthetic-secret'); }]) {
    const f = fixture({ mode: 'native', nativePort: 6081, fetcher });
    await assert.rejects(f.login.target(), error => /noVNC 尚未就绪/.test(error.message) && !error.message.includes('synthetic-secret'));
    assert.deepEqual(f.calls, []);
  }
});
test('native probe is cancelled on request abort/disposal and does not run after cancellation', async () => {
  for (const dispose of [false, true]) {
    let signal;
    const f = fixture({ mode: 'native', nativePort: 6081, fetcher: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
    const controller = new AbortController(), result = f.login.target({ signal: controller.signal });
    await setImmediate(); if (dispose) f.login.dispose(); else controller.abort();
    await assert.rejects(result, /已取消/); assert.equal(signal.aborted, true);
    await assert.rejects(f.login.target({ signal: controller.signal }), /已取消/);
    assert.equal(f.calls.length, 0);
  }
});
test('native probe retains the 4s deadline for an injected fetch ignoring cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal;
  const f = fixture({ mode: 'native', nativePort: 6081, fetcher: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const result = f.login.target(); await setImmediate(); t.mock.timers.tick(4000);
  await assert.rejects(result, /noVNC 尚未就绪/); assert.equal(signal.aborted, true); assert.equal(f.calls.length, 0);
});

function nativePasswordFixture(options = {}) {
  return passwordFixture({ mode: 'native', nativePort: 6081, ...options });
}
test('native password uses only the fixed bounded binary credential command, never supplied paths or environment', async () => {
  const f = nativePasswordFixture({ passwordPath: '/tmp/attacker', env: ['VNC_PASSWD=wrong'], container: ';unused' });
  assert.deepEqual(await f.login.password({ path: '/tmp/attacker', password: 'wrong' }), { ok: true, password: 'testpass' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'head');
  assert.deepEqual(f.calls[0][1], ['-c', '8', '/var/lib/snowluma/.vnc/passwd']);
  assert.equal(f.calls[0][2].timeoutMs, 8000); assert.equal(f.calls[0][2].maxOutputBytes, 8);
  assert.ok(f.calls[0][2].signal instanceof AbortSignal);
  assert.deepEqual(f.requests, []);
});
for (const value of ['a', 'abc def', '12345678']) test(`native password decodes and matches the actual VNC file for length ${value.length}`, async () => {
  const file = vncFile(value), f = nativePasswordFixture({ run: async () => file });
  assert.deepEqual(await f.login.password(), { ok: true, password: value });
  assert.ok(file.every(byte => byte === 0));
});
for (const file of [Buffer.alloc(7), Buffer.alloc(9), Buffer.alloc(8), '87803c720bbb91d5', vncFile(''), vncFile('bad\u0000pad'), vncFile('bad\npass'), vncFile('\u007f')]) test('native password rejects invalid fixed source without a default and wipes buffers', async () => {
  const source = Buffer.isBuffer(file) ? Buffer.from(file) : file;
  const f = nativePasswordFixture({ run: async () => source });
  await assert.rejects(f.login.password(), /无法安全读取并核实/);
  if (Buffer.isBuffer(source)) assert.ok(source.every(byte => byte === 0));
});
test('native credential failures are sanitized without logging secret output', async t => {
  const logged = [];
  for (const name of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, name, (...args) => logged.push(args));
  const f = nativePasswordFixture({ run: async () => { throw new Error('testpass QQ_PASSWORD=synthetic-secret /root/private'); } });
  await assert.rejects(f.login.password(), error => /无法安全读取并核实/.test(error.message) && !/testpass|synthetic-secret|private/.test(error.message));
  assert.deepEqual(logged, []);
});
test('native credential cancellation prevents execution, aborts hanging reads and sanitizes late failures', async () => {
  let reject, signal, calls = 0;
  const f = nativePasswordFixture({ run: (_bin, _args, options) => { calls++; signal = options.signal; return new Promise((_resolve, fail) => { reject = fail; }); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.login.password({ signal: controller.signal }), /已取消/); assert.equal(calls, 0);
  const result = f.login.password(); await setImmediate(); f.login.dispose();
  await assert.rejects(result, /已取消/); assert.equal(signal.aborted, true);
  reject(new Error('late synthetic-secret')); await setImmediate();
  await assert.rejects(f.login.password(), /已取消/); assert.equal(calls, 1);
});
test('native credential runner remains bounded to 8s even when injected runner ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal;
  const f = nativePasswordFixture({ run: (_bin, _args, options) => { signal = options.signal; return new Promise(() => {}); } });
  const result = f.login.password(); await setImmediate(); t.mock.timers.tick(8000);
  await assert.rejects(result, /无法安全读取并核实/); assert.equal(signal.aborted, true);
});

test('native original password remains browser-only authenticated same-origin POST with no request parameters', async () => {
  const routes = new Map(), disposers = [], f = nativePasswordFixture();
  const ctx = {
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); },
    connection: { requestRejection(req) { return req.headers['x-auth'] === 'yes' ? 0 : 401; } },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); }, registerUpgrade() { return () => {}; } },
  };
  const api = registerLoginHttp({ ctx, login: { dispose() {} }, desktop: { stop() {}, dispose() {} }, originalLogin: { ...f.login, redirect: originalRedirect } });
  async function request({ method = 'POST', auth = true, headers = {}, input = {} } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(input))]);
    req.method = method; req.url = '/dsh-qq/login/original/password';
    req.headers = { host: 'localhost:3080', origin: 'http://localhost:3080', 'content-type': 'application/json', ...(auth ? { 'x-auth': 'yes' } : {}), ...headers };
    const res = new EventEmitter();
    res.writeHead = (status, values) => { res.status = status; res.headers = values; res.headersSent = true; };
    res.end = text => { res.writableEnded = true; res.text = text; };
    await routes.get(req.url)(req, res); return res;
  }
  try {
    for (const options of [{ auth: false }, { method: 'GET' }, { headers: { origin: 'http://attacker.test' } }, { headers: { 'sec-fetch-site': 'cross-site' } }, { input: { path: '/tmp/attacker' } }, { input: { port: 4444 } }]) {
      const denied = await request(options); assert.notEqual(denied.status, 200); assert.equal(denied.headers['cache-control'], 'no-store');
    }
    assert.equal(f.calls.length, 0);
    const allowed = await request(); assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(allowed.text), { ok: true, password: 'testpass' });
    assert.equal(allowed.headers['cache-control'], 'no-store'); assert.equal(f.calls.length, 1);
  } finally { api.dispose(); for (const dispose of disposers.reverse()) dispose(); }
});

const req = (host, encrypted = false, extra = {}) => ({ headers: { host, ...extra }, socket: { encrypted } });
for (const [host, expected] of [
  ['example.test:3080', 'example.test:6081'], ['example.test', 'example.test:6081'],
  ['127.0.0.1:3080', '127.0.0.1:6081'], ['localhost', 'localhost:6081'],
  ['[2001:db8::1]:3080', '[2001:db8::1]:6081'], ['[::1]', '[::1]:6081'],
]) test(`redirect keeps request hostname ${host} and changes only port/path`, () => {
  assert.equal(originalRedirect(req(host), { port: 6081, path }), `http://${expected}${path}`);
  assert.equal(originalRedirect(req(host, true), { port: 6081, path }), `http://${expected}${path}`);
});

test('redirect uses verified HTTP even when GUI has TLS, never proxy headers or origin', () => {
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.test', forwarded: 'proto=https;host=attacker.test', origin: 'https://attacker.test' };
  assert.equal(originalRedirect(req('qq.test:3080', false, headers), { port: 6081, path }), `http://qq.test:6081${path}`);
  assert.equal(originalRedirect(req('qq.test:3080', true, { 'x-forwarded-proto': 'http' }), { port: 6081, path }), `http://qq.test:6081${path}`);
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
