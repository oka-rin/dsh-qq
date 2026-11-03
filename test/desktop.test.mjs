import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';
import { createDesktop, desktopCommand, desktopWindows, DESKTOP_SOCKET_RELAY } from '../desktop.js';

const WINDOW = { id: '12345', width: 600, height: 500 };
const TREE = '   0x3039 "QQ": ("qq" "qq")  600x500+0+0  +0+0\n';
const HELP = '-id windowid   Restrict capture\n-inetd  stdio\n';
const PROPS = '_NET_WM_PID(CARDINAL) = 123\nWM_CLASS(STRING) = "qq", "qq"\n';
class FakeWS extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated = true; this.readyState = 3; }
  send(data, _options, callback) { this.sent.push(Buffer.from(data)); callback?.(); }
  pause() { this.paused = true; } resume() { this.paused = false; }
}
function fakeServer() {
  const server = new EventEmitter();
  server.handleUpgrade = (_req, _socket, _head, callback) => { server.ws = new FakeWS(); callback(server.ws); };
  server.close = () => { server.closed = true; }; return server;
}
function fakeChild() {
  const child = new EventEmitter(); child.writes = []; child.signals = [];
  child.stdin = new Writable({ write(data, _encoding, done) { child.writes.push(Buffer.from(data)); child.emit('input', data); done(); } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { child.signals.push(signal); child.emit('close', 0); return true; }; return child;
}
function harness(options = {}) {
  const calls = [], spawns = [], children = [], wss = fakeServer();
  let clock = 1000, selectedWindow = { ...WINDOW }, executable = '/opt/QQ/qq';
  const run = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (bin === 'docker') { const i = args.indexOf('snowluma'); [bin, ...args] = args.slice(i + 1); if (bin === 'timeout') [bin, ...args] = args.slice(2); }
    if (bin === 'x11vnc') return Buffer.from(HELP);
    if (bin === 'timeout') return Buffer.from('--kill-after');
    if (bin === 'python3') return Buffer.alloc(0);
    if (bin === 'xwininfo') return Buffer.from(TREE);
    if (bin === 'xprop') return Buffer.from(PROPS);
    if (bin === 'readlink') return Buffer.from(executable);
    throw new Error('unexpected command');
  };
  const spawn = (bin, args, opts) => { const child = fakeChild(); children.push(child); spawns.push({ bin, args, opts }); return child; };
  const desktop = createDesktop({ run, spawn, now: () => clock, discoverWindow: async () => selectedWindow,
    webSocketServerFactory: opts => { wss.options = opts; return wss; }, ...options });
  const request = info => ({ method: 'GET', url: info.wsPath, headers: { origin: 'http://localhost:3080', host: 'localhost:3080', 'sec-websocket-protocol': info.protocols.join(', ') } });
  const socket = () => ({ destroyed: false, end(response) { this.response = response; } });
  return { desktop, wss, calls, spawns, children, request, socket, setClock(value) { clock = value; }, setWindow(value) { selectedWindow = value; }, setExecutable(value) { executable = value; } };
}
async function connected(h) { const info = await h.desktop.start(); await h.desktop.upgrade(h.request(info), h.socket(), Buffer.alloc(0)); return info; }

test('discovery excludes root, arbitrary title/class, dimensions and out-of-range XID', () => {
  assert.deepEqual(desktopWindows(TREE), [WINDOW]);
  for (const input of [TREE.replace('"QQ"', '"other"'), TREE.replace('"qq" "qq"', '"terminal" "terminal"'), TREE.replace('600x500', '100x500'), TREE.replace('0x3039', '0x100000000'), '0x1 "root": () 1024x768']) assert.deepEqual(desktopWindows(input), []);
});
test('fixed server-side configuration rejects injection', () => {
  for (const options of [{ mode: 'unknown' }, { display: 'host:0' }, { display: ':99;sh' }, { container: '--privileged' }, { container: 'x;sh' }, { xauthority: '/tmp/x\nsh' }, { xauthority: 'relative' }]) assert.throws(() => createDesktop(options));
});
test('start metadata-only checks return random short-lived header nonce; no capture', async t => {
  const h = harness(); t.after(() => h.desktop.dispose()); const info = await h.desktop.start();
  assert.equal(info.wsPath, '/dsh-qq/login/desktop/ws'); assert.deepEqual(info.window, { width: 600, height: 500 });
  assert.equal(info.expiresAt, 121000); assert.equal(info.sessionExpiresAt, 601000);
  assert.match(info.protocols[1], /^dsh-qq-session\.[A-Za-z0-9_-]{43}$/); assert.equal(h.spawns.length, 0);
  assert.ok(h.calls.find(c => c.bin === 'x11vnc').opts.allowExitCodes.includes(1));
  assert.ok(h.calls.some(c => c.bin === 'python3' && c.args.includes('-I')));
  assert.equal(h.wss.options.maxPayload, 256 * 1024); assert.equal(h.wss.options.perMessageDeflate, false);
  assert.equal(h.wss.options.handleProtocols(new Set(info.protocols)), 'binary');
  assert.notEqual(info.protocols[1], (await h.desktop.start()).protocols[1]);
});
test('missing dependencies, untrusted executable, invalid window, external mode fail closed', async t => {
  const h = harness(); t.after(() => h.desktop.dispose()); h.setExecutable('/tmp/qq'); await assert.rejects(h.desktop.start(), /受支持的 QQ/);
  h.setWindow({ ...WINDOW, id: '0' }); await assert.rejects(h.desktop.start(), /无效/);
  for (const [options, pattern] of [[{ run: async () => Buffer.from('no support') }, /不支持/], [{ mode: 'external' }, /外部网关/], [{ run: async () => { throw new Error('sensitive'); } }, /无法检查/]]) {
    const fail = harness(options); t.after(() => fail.desktop.dispose()); await assert.rejects(fail.desktop.start(), pattern); assert.equal(fail.spawns.length, 0);
  }
});
test('upgrade exact nonquery path, Origin and capability required; rejects do not echo secrets', async t => {
  const h = harness(); t.after(() => h.desktop.dispose()); const info = await h.desktop.start();
  for (const alter of [r => { r.url += '?token=secret'; }, r => { r.method = 'POST'; }, r => { delete r.headers.origin; }, r => { r.headers.origin = 'http://evil.example'; }, r => { r.headers.origin += '/other'; }, r => { r.headers['sec-fetch-site'] = 'cross-site'; }, r => { r.headers['sec-websocket-protocol'] = 'binary, dsh-qq-session.wrong'; }, r => { r.headers['sec-websocket-protocol'] += ', extra'; }]) {
    const req = h.request(info); alter(req); const socket = h.socket();
    assert.equal(await h.desktop.upgrade(req, socket, Buffer.alloc(0)), false); assert.match(socket.response, /^HTTP\/1.1 403/);
    assert.ok(!socket.response.includes('secret')); assert.ok(!socket.response.includes(info.protocols[1]));
  }
  assert.equal(h.spawns.length, 0);
});
test('bounded socketpair inetd process is window-only; forwards binary without child diagnostics', async t => {
  const h = harness(); t.after(() => h.desktop.dispose()); const info = await connected(h);
  const spawned = h.spawns[0], child = h.children[0], ws = h.wss.ws; assert.equal(spawned.bin, 'timeout');
  for (const arg of ['--kill-after=2s', '600s', 'python3', '-I', '-c', DESKTOP_SOCKET_RELAY, 'x11vnc', '-norc', '-inetd', '-quiet', '-id', WINDOW.id, '-display', ':99', '-nosel', '-safer', '-nocmds']) assert.ok(spawned.args.includes(arg));
  for (const arg of ['-rfbport', '-listen', '-sid', '-root', '-forever', '-tightfilexfer', '-ultrafilexfer', '-connect']) assert.ok(!spawned.args.includes(arg));
  assert.equal(spawned.args[spawned.args.indexOf('-input') + 1], 'KMB'); assert.equal(spawned.opts.detached, true);
  assert.ok(!JSON.stringify(spawned).includes(info.protocols[1]));
  child.stdout.write(Buffer.from('RFB 003.008\n')); assert.equal(ws.sent[0].toString(), 'RFB 003.008\n');
  const input = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]); ws.emit('message', input, true); assert.deepEqual(child.writes[0], input);
  child.stderr.write('discarded diagnostics'); assert.equal(ws.sent.length, 1);
  ws.close(1000); assert.ok(child.stdin.destroyed); assert.ok(child.signals.includes('SIGTERM'));
});
test('expiry, replay and changed verified window cannot open another process', async t => {
  const h = harness(); t.after(() => h.desktop.dispose()); let info = await h.desktop.start(); h.setClock(info.expiresAt);
  assert.equal(await h.desktop.upgrade(h.request(info), h.socket(), Buffer.alloc(0)), false);
  h.setClock(1000); info = await connected(h); assert.equal(await h.desktop.upgrade(h.request(info), h.socket(), Buffer.alloc(0)), false); assert.equal(h.spawns.length, 1);
  info = await h.desktop.start(); h.setWindow({ ...WINDOW, id: '12346' });
  assert.equal(await h.desktop.upgrade(h.request(info), h.socket(), Buffer.alloc(0)), false); assert.equal(h.spawns.length, 1);
});
test('parallel upgrades reserve nonce before asynchronous discovery', async t => {
  const h = harness(); t.after(() => h.desktop.dispose()); const info = await h.desktop.start();
  const results = await Promise.all([h.desktop.upgrade(h.request(info), h.socket(), Buffer.alloc(0)), h.desktop.upgrade(h.request(info), h.socket(), Buffer.alloc(0))]);
  assert.deepEqual(results.sort(), [false, true]); assert.equal(h.spawns.length, 1);
});
test('text or oversized frame, server queue overflow, child errors close and reap', async t => {
  for (const event of [h => h.wss.ws.emit('message', Buffer.from('text'), false), h => h.wss.ws.emit('message', Buffer.alloc(256 * 1024 + 1), true), h => { h.wss.ws.bufferedAmount = 4 * 1024 * 1024; h.children[0].stdout.write(Buffer.from('x')); }, h => h.children[0].emit('error', new Error('sensitive'))]) {
    const h = harness(); t.after(() => h.desktop.dispose()); await connected(h); event(h);
    assert.equal(h.wss.ws.readyState, 3); assert.ok(h.children[0].stdin.destroyed);
  }
});
test('input backpressure pauses websocket then drain resumes', async t => {
  const h = harness(); t.after(() => h.desktop.dispose()); await connected(h);
  h.children[0].stdin.write = () => false; h.wss.ws.emit('message', Buffer.from('x'), true); assert.equal(h.wss.ws.paused, true);
  h.children[0].stdin.emit('drain'); assert.equal(h.wss.ws.paused, false);
});
test('Docker timeout and socketpair run inside fixed container, no tty or port', async t => {
  const h = harness({ mode: 'docker' }); t.after(() => h.desktop.dispose()); await connected(h);
  const { bin, args } = h.spawns[0]; assert.equal(bin, 'docker');
  assert.deepEqual(args.slice(0, 7), ['exec', '-i', '-e', 'DISPLAY=:1', 'snowluma', 'timeout', '--signal=TERM']);
  assert.ok(args.includes('--kill-after=2s')); assert.ok(args.includes(DESKTOP_SOCKET_RELAY)); assert.ok(!args.includes('-t')); assert.ok(!args.includes('-p'));
  h.desktop.stop(); assert.ok(h.children[0].signals.includes('SIGTERM'));
});
test('stop cancels pending start; dispose and spawn failure fail closed', async () => {
  let unblock; const h = harness({ discoverWindow: () => new Promise(resolve => { unblock = resolve; }) }); const pending = h.desktop.start();
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  h.desktop.stop(); unblock(WINDOW); await assert.rejects(pending, /取消/); h.desktop.dispose(); await assert.rejects(h.desktop.start(), /卸载/);
  const failed = harness({ spawn: () => { throw new Error('sensitive'); } });
  try { await connected(failed); assert.equal(failed.wss.ws.readyState, 3); } finally { failed.desktop.dispose(); }
});
test('metadata execution bounds timeout/output and redacts stderr/nonzero errors', async () => {
  assert.equal((await desktopCommand(process.execPath, ['-e', 'process.stdout.write("metadata")'])).toString(), 'metadata');
  await assert.rejects(desktopCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048))'], { maxBytes: 10 }));
  await assert.rejects(desktopCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 20 }));
  await assert.rejects(desktopCommand(process.execPath, ['-e', 'process.stderr.write("sensitive");process.exit(1)']), error => !error.message.includes('sensitive'));
  assert.equal((await desktopCommand(process.execPath, ['-e', 'process.stdout.write("help");process.exit(1)'], { allowExitCodes: [0, 1] })).toString(), 'help');
});
test('real ws handshake negotiates binary and relays fake child RFB, no X capture', { timeout: 5000 }, async t => {
  const h = harness({ webSocketServerFactory: undefined }); const server = http.createServer(); const upgrades = [];
  server.on('upgrade', (req, socket, head) => { upgrades.push(h.desktop.upgrade(req, socket, head)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { h.desktop.dispose(); await Promise.all(upgrades); await new Promise(resolve => server.close(resolve)); });
  const info = await h.desktop.start(), origin = `http://127.0.0.1:${server.address().port}`;
  const client = new WebSocket(origin.replace('http:', 'ws:') + info.wsPath, info.protocols, { origin }); client.on('error', () => {}); t.after(() => client.terminate());
  await once(client, 'open'); assert.equal(client.protocol, 'binary');
  const received = once(client, 'message'); h.children[0].stdout.write(Buffer.from('RFB 003.008\n'));
  const [data, binary] = await received; assert.equal(binary, true); assert.equal(data.toString(), 'RFB 003.008\n');
  const input = once(h.children[0], 'input'); client.send(Buffer.from([1])); await input; assert.deepEqual(h.children[0].writes[0], Buffer.from([1]));
  client.close(); await once(client, 'close'); assert.ok(h.children[0].stdin.destroyed);
});
const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
test('real Python stdlib socketpair supports inetd bidirectional FD0 and EOF cleanup', { timeout: 5000, skip: !hasPython }, async t => {
  const fakeInetd = 'import os, socket; s=socket.socket(fileno=0); s.sendall(b"RFB 003.008\\n"); data=s.recv(12); s.sendall(data)';
  const relay = spawn('python3', ['-I', '-c', DESKTOP_SOCKET_RELAY, 'python3', '-I', '-c', fakeInetd], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => relay.kill('SIGKILL')); relay.stderr.resume(); relay.stdin.on('error', () => {});
  const [banner] = await once(relay.stdout, 'data'); assert.equal(banner.toString(), 'RFB 003.008\n');
  const echoed = once(relay.stdout, 'data'); relay.stdin.write(Buffer.from('HELLO')); const [bytes] = await echoed; assert.equal(bytes.toString(), 'HELLO');
  relay.stdin.end(); const [code] = await once(relay, 'close'); assert.equal(code, 0);
});
