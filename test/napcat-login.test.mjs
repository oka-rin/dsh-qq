import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createNapcatLogin, napcatRedirect, napcatPort, validNapcatToken } from '../napcat-login.js';
import { createSetup } from '../setup.js';
const token = 'test-only-strong-webui-token-0123456789';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-login-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'webui.json');
  fs.writeFileSync(configPath, JSON.stringify({ token, ignored: 'never-project' }));
  return { dir, configPath };
}
test('fixed same-host HTTP redirect never carries tokens, paths or browser redirect values', () => {
  assert.equal(napcatRedirect({ headers: { host: 'qq.example:3080' } }), 'http://qq.example:6099/webui/');
  assert.equal(napcatRedirect({ headers: { host: '[::1]:3080' } }, 6100), 'http://[::1]:6100/webui/');
  for (const host of ['', 'evil.test/path', 'good.test@evil.test', 'evil.test?redirect=1', 'x\\y', 'evil.test\r\nX:a']) assert.throws(() => napcatRedirect({ headers: { host } }));
  for (const port of [0, 65536, '6099', -1, 3.5]) assert.throws(() => napcatPort(port));
});
test('probe uses loopback /webui/ with redirect refusal and no credentials', async t => {
  const f = fixture(t); let calls = 0;
  const login = createNapcatLogin({ ...f, fetcher: async (url, init) => {
    calls++; assert.equal(url, 'http://127.0.0.1:6099/webui/'); assert.equal(init.redirect, 'error');
    assert.equal(JSON.stringify(init).includes(token), false); return new Response('<html>NapCat</html>');
  } });
  assert.deepEqual(await login.target(), { provider: 'napcat', port: 6099 }); assert.equal(calls, 1);
  login.dispose(); await assert.rejects(login.target(), /未就绪/); assert.equal(calls, 1);
  const bad = createNapcatLogin({ ...f, fetcher: async () => { throw new Error(token); } });
  await assert.rejects(bad.target(), e => !e.message.includes(token));
});
test('token is a separate explicit bounded JSON read, independent of 8-character VNC secrets', async t => {
  const f = fixture(t); const login = createNapcatLogin({ ...f, fetcher: async () => assert.fail('copy must not contact WebUI or transmit token') });
  assert.deepEqual(await login.token(), { ok: true, token });
  for (const value of ['eightchr', '', 'bad\ntoken01234567890123456789', 'x'.repeat(4097), 123]) {
    fs.writeFileSync(f.configPath, JSON.stringify({ token: value }));
    await assert.rejects(login.token(), e => !e.message.includes(String(value)) || value === '');
  }
  assert.equal(validNapcatToken('x'.repeat(4096)), true);
  fs.writeFileSync(f.configPath, 'x'.repeat(65537)); await assert.rejects(login.token(), /安全读取/);
  fs.writeFileSync(f.configPath, JSON.stringify({ nested: { token } })); await assert.rejects(login.token(), /安全读取/);
  const link = path.join(f.dir, 'link.json'); fs.symlinkSync(f.configPath, link);
  await assert.rejects(createNapcatLogin({ configPath: link }).token(), /安全读取/);
  await assert.rejects(createNapcatLogin({ configPath: path.join(f.dir, 'missing.json') }).token(), e => !e.message.includes(f.dir));
  for (const configPath of ['webui.json', '/tmp/config.txt', '']) assert.throws(() => createNapcatLogin({ configPath }));
  const controller = new AbortController(); controller.abort(); await assert.rejects(login.token({ signal: controller.signal }), /安全读取/);
});
test('NapCat setup status names selected backend and never advertises SnowLuma/noVNC installation', async t => {
  const f = fixture(t); fs.writeFileSync(f.configPath, JSON.stringify({ onebot: { accessToken: token }, llm: { apiKey: token } }));
  const setup = createSetup({ configPath: f.configPath, gatewayBackend: 'napcat', run: async () => assert.fail('read-only status') });
  const result = await setup.status();
  assert.equal(result.backend, 'napcat'); assert.equal(result.native.service, 'napcat.service');
  assert.equal(result.checks.some(c => c.id === 'display'), false); assert.equal(result.automaticInstall.scriptAvailable, false);
  assert.doesNotMatch(JSON.stringify(result), /snowluma|noVNC|test-only-strong/i);
});
test('client token validation accepts strong tokens and fixed mount-preserving WebUI hop only', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('    function napcatWebuiToken('), source.indexOf('    // Deliberately synchronous:'));
  const validate = vm.runInNewContext(helper + '\nnapcatWebuiToken', { tr: k => k });
  assert.equal(validate({ ok: true, token }), token);
  for (const value of ['', 'eightchr', 'x'.repeat(4097), token + '\n']) assert.throws(() => validate({ ok: true, token: value }));
  assert.throws(() => validate({ ok: false, token, error: token }), e => !e.message.includes(token));
  assert.match(source, /post\('\/login\/napcat\/token', \{\}\)/);
  assert.match(source, /if \(napcat\) result.token = ''/);
  assert.match(source, /napcat \? h\(DesktopPasswordCopy, \{ key: 'napcat', napcat: true \}\)/);
  const targetHelper = source.slice(source.indexOf('    function desktopViewPath('), source.indexOf('    async function navigateToQQLogin('));
  const target = vm.runInNewContext(targetHelper + '\ndesktopViewPath', { tr: k => k });
  assert.equal(target({ url: '/dsh-qq/login/napcat', expiresAt: 100 }, '/dsh', 1), '/dsh/dsh-qq/login/napcat');
  assert.throws(() => target({ url: 'http://evil.test:6099/webui/', expiresAt: 100 }, '', 1));
});
