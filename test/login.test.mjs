import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { captureCommand, qqWindows, loginQr, createLogin, assertLoginRequest } from '../login.js';

const tree = '  0x123 "QQ": ("qq" "qq") 600x500+0+0\n';
function fixture(options = {}) {
  const calls = [];
  const run = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const command = bin === 'docker' ? args[7] : bin;
    if (command === 'xwininfo') return Buffer.from(tree);
    if (command === 'xprop') return Buffer.from('_NET_WM_PID(CARDINAL) = 123\nWM_CLASS(STRING) = "qq", "qq"\n');
    if (command === 'readlink') return Buffer.from(options.exe || '/opt/QQ/qq');
    if (command === 'ffmpeg') return Buffer.from('synthetic pixels never returned');
    throw new Error('unexpected mock command');
  };
  let checks = 0;
  const login = createLogin({ xauthority: '', check: async () => { checks++; return { ok: true, account: { user_id: 123 }, websocket: 'open' }; }, run, decode: async () => 'data:image/png;base64,c3ludGhldGlj', ...options });
  return { login, calls, checks: () => checks };
}

test('window candidates reject root/tray/oversized windows and retain expected geometry', () => {
  assert.deepEqual(qqWindows(tree), [{ id: '291', width: 600, height: 500 }]);
  for (const value of ['0x0 "QQ": ("qq" "qq") 600x500+0+0', '0x123 "QQ": ("qq" "qq") 30x30+0+0', '0x123 "Desktop": ("qq" "qq") 600x500+0+0', '0x123 "QQ": ("qq" "qq") 3000x500+0+0']) assert.equal(qqWindows(value).length, 0);
});

test('configured gateway readiness never gates explicit selected window capture', async () => {
  const f = fixture();
  const status = await f.login.status();
  assert.equal(status.gatewayReady, true); assert.equal(status.selectedClientVerified, false);
  const out = await f.login.qr();
  assert.equal(f.checks(), 1); assert.equal(out.state, 'qr_captured'); assert.equal(out.expiryUnknown, true);
  assert.equal(out.image, 'data:image/png;base64,c3ludGhldGlj');
  assert.ok(!JSON.stringify(out).includes('synthetic pixels'));
  assert.ok(f.calls.some(c => c.bin === 'ffmpeg'));
  const window = await f.login.window();
  assert.deepEqual(window, { id: '291', width: 600, height: 500, display: ':99', source: 'qq-window', mode: 'native' });
  f.login.dispose();
});

test('Docker discovery and capture share fixed display and in-container deadline', async () => {
  const f = fixture({ mode: 'docker', display: ':44', xauthority: '/host-only/authority' });
  await f.login.qr();
  for (const { bin, args, opts } of f.calls) {
    assert.equal(bin, 'docker');
    assert.deepEqual(args.slice(0, 7), ['exec', '-e', 'DISPLAY=:1', 'snowluma', 'timeout', '--signal=KILL', '8s']);
    assert.ok(opts.signal); assert.equal(opts.timeoutMs, 9000);
    assert.ok(!args.some(arg => arg.includes('/host-only/')));
  }
  const capture = f.calls.find(c => c.args[7] === 'ffmpeg');
  assert.equal(capture.args[capture.args.indexOf('-i') + 1], ':1');
  assert.equal(capture.args[capture.args.indexOf('-video_size') + 1], '600x500');
  f.login.dispose();
});

test('trusted process paths are exact and discovery does not expose captured pixels', async () => {
  const f = fixture({ exe: '/tmp/qq' });
  await assert.rejects(f.login.window(), /受信任路径/);
  assert.ok(!f.calls.some(c => c.bin === 'ffmpeg')); f.login.dispose();
});

test('dispose cancels in-flight discovery and all later operations', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let received;
  const f = fixture({ run: async (_bin, _args, opts) => { received = opts.signal; started(); return new Promise(() => {}); } });
  const pending = f.login.qr();
  await ready; f.login.dispose();
  await assert.rejects(pending, /取消|卸载/); assert.equal(received.aborted, true);
  for (const op of ['status', 'qr', 'window', 'refresh']) await assert.rejects(f.login[op](), /卸载/);
});

test('request abort and capture mutex prevent continuing stale capture', async () => {
  const controller = new AbortController(); let start;
  const ready = new Promise(resolve => { start = resolve; });
  const f = fixture({ run: async () => { start(); return new Promise(() => {}); } });
  const pending = f.login.qr({ signal: controller.signal }); await ready;
  await assert.rejects(f.login.qr(), /正在读取/);
  controller.abort(); await assert.rejects(pending, /取消/); f.login.dispose();
});

test('capture timestamp is not a validity claim and failed reread clears it', async () => {
  let fail = false;
  const f = fixture({ now: () => 1000, check: async () => { throw new Error('offline'); }, decode: async () => { if (fail) throw new Error('secret-url-must-not-leak'); return 'synthetic-image'; } });
  await f.login.qr();
  assert.equal((await f.login.status()).state, 'qr_captured');
  fail = true;
  await assert.rejects(f.login.qr(), error => !error.message.includes('secret-url-must-not-leak'));
  assert.equal((await f.login.status()).capturedAt, null); f.login.dispose();
});

test('captureCommand bounds stdout/stderr and cancellation without exposing child output', async () => {
  const base = { timeoutMs: 3000 };
  await assert.rejects(captureCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { ...base, maxBytes: 100 }), /数据过大/);
  await assert.rejects(captureCommand(process.execPath, ['-e', 'process.stderr.write("private-output".repeat(1000))'], { ...base, maxStderrBytes: 100 }), error => /输出过大/.test(error.message) && !error.message.includes('private-output'));
  await assert.rejects(captureCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }), /超时/);
  const controller = new AbortController();
  const pending = captureCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...base, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal((await captureCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], base)).toString(), 'ok');
});

test('worker accepts only sanitized NTQQ login family fixtures and never original pixels', async () => {
  const good = await QRCode.toBuffer('https://txz.qq.com/p?k=synthetic-not-a-credential&f=synthetic', { width: 320 });
  const image = await loginQr(good);
  assert.match(image, /^data:image\/png;base64,/);
  for (const value of ['https://ssl.ptlogin2.qq.com/ptqrshow?synthetic=1', 'https://txz.qq.com/prefix?k=synthetic', 'https://txz.qq.com/p?k=synthetic&redirect=other', 'https://txz.qq.com/p?k=one&k=two', 'https://txz.qq.com/p?k=', 'https://txz.qq.com/p?k=synthetic#fragment', 'http://txz.qq.com/p?k=synthetic', 'https://txz.qq.com.evil.invalid/p?k=synthetic']) {
    await assert.rejects(loginQr(await QRCode.toBuffer(value, { width: 320 })), error => !error.message.includes(value));
  }
});

test('PNG validation rejects interlace/oversize before worker launch and accepts cancellation', async () => {
  const good = await QRCode.toBuffer('https://txz.qq.com/p?k=synthetic', { width: 320 });
  const interlaced = Buffer.from(good); interlaced[28] = 1;
  await assert.rejects(loginQr(interlaced), /格式/);
  const huge = Buffer.from(good); huge.writeUInt32BE(2049, 16);
  await assert.rejects(loginQr(huge), /尺寸/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loginQr(good, { signal: controller.signal }), /取消/);
});

test('request guard requires JSON POST and exact browser origin', () => {
  const req = { method: 'POST', headers: { host: 'localhost:3080', origin: 'http://localhost:3080', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, socket: {} };
  assert.doesNotThrow(() => assertLoginRequest(req));
  const proxied = { ...req, headers: { ...req.headers, origin: 'https://localhost:3080' } };
  assert.doesNotThrow(() => assertLoginRequest(proxied, { trustedOrigin: 'https://localhost:3080' }));
  assert.throws(() => assertLoginRequest(proxied, { trustedOrigin: 'https://attacker.invalid' }));
  for (const patch of [{ method: 'GET' }, { headers: { ...req.headers, origin: undefined } }, { headers: { ...req.headers, origin: 'https://localhost:3080' } }, { headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } }, { headers: { ...req.headers, 'content-type': 'text/plain' } }]) assert.throws(() => assertLoginRequest({ ...req, ...patch }));
});
