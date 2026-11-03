import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run only the shipped pure navigation helpers and request transport. No React,
// DOM, browser renderer, credential data, or live QQ session is involved.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const helperSource = source.slice(source.indexOf('    function desktopViewPath('), source.indexOf('    function LoginPanel()'));
const { desktopViewPath, navigateToQQLogin } = vm.runInNewContext(`${helperSource}\n({ desktopViewPath, navigateToQQLogin })`, { tr: key => key });
const future = () => Date.now() + 600_000;
const success = () => ({ ok: true, url: '/dsh-qq/login/desktop/view', expiresAt: future() });

test('login URL is exact and mount-prefixed once, for numeric and ISO expiry', () => {
  for (const mount of ['', '/dsh', '/team/gui']) {
    assert.equal(desktopViewPath(success(), mount), `${mount}/dsh-qq/login/desktop/view`);
    assert.equal(desktopViewPath({ ...success(), expiresAt: new Date(future()).toISOString() }, mount), `${mount}/dsh-qq/login/desktop/view`);
  }
  for (const url of ['https://evil.test/view', '//evil.test/view', '/dsh/dsh-qq/login/desktop/view', '/dsh-qq/login/desktop/view?token=secret', '/dsh-qq/login/desktop/view#x', '/dsh-qq/login/desktop/view/']) {
    assert.throws(() => desktopViewPath({ ...success(), url }, '/dsh'), /desktopInvalid/);
  }
  for (const expiresAt of [undefined, null, '', 'invalid', 0, Date.now() - 1]) {
    assert.throws(() => desktopViewPath({ ...success(), expiresAt }, ''), /desktopInvalid/);
  }
});

test('original SnowLuma hop is exact, mount-preserving and never an arbitrary redirect', () => {
  assert.equal(desktopViewPath({ ...success(), url: '/dsh-qq/login/original' }, '/dsh'), '/dsh/dsh-qq/login/original');
  for (const url of ['/dsh-qq/login/original?url=evil', '//evil.test', 'http://evil.test:6081/vnc.html']) {
    assert.throws(() => desktopViewPath({ ...success(), url }, '/dsh'), /desktopInvalid/);
  }
});

test('navigation awaits successful POST and uses the current tab destination', async () => {
  let resolvePost;
  const calls = [];
  const pending = navigateToQQLogin(() => new Promise(resolve => { resolvePost = resolve; }), url => calls.push(url), () => true, '/gui');
  assert.deepEqual(calls, []);
  resolvePost(success());
  await pending;
  assert.deepEqual(calls, ['/gui/dsh-qq/login/desktop/view']);
});

test('failed session, bad reply and navigation error do not prevent a later retry', async () => {
  const calls = [];
  for (const createSession of [
    async () => ({ ok: false, httpStatus: 401, error: 'DSH login expired' }),
    async () => ({ ...success(), url: '//evil.test' }),
    async () => { throw new Error('transport failed'); },
  ]) {
    await assert.rejects(navigateToQQLogin(createSession, url => calls.push(url), () => true, '/dsh'));
    assert.deepEqual(calls, []);
  }
  await assert.rejects(navigateToQQLogin(async () => success(), () => { throw new Error('navigation refused'); }, () => true, ''), /navigation refused/);
  await navigateToQQLogin(async () => success(), url => calls.push(url), () => true, '/dsh');
  assert.deepEqual(calls, ['/dsh/dsh-qq/login/desktop/view']);
});

test('discarded mount cannot navigate or close a session after POST finishes', async () => {
  let resolvePost, current = true;
  const pending = navigateToQQLogin(() => new Promise(resolve => { resolvePost = resolve; }), () => assert.fail('stale navigation'), () => current, '');
  current = false;
  resolvePost(success());
  await pending;
  assert.doesNotMatch(helperSource, /close|release|window\.open/);
});

function transport(fetch) {
  let deadline, cleared = false;
  const requestSource = source.slice(source.indexOf('    const request = async'), source.indexOf('    const configWrite'));
  const api = vm.runInNewContext(`${requestSource}\n({ get, post })`, {
    B: '/gui/dsh-qq', fetch, AbortController,
    setTimeout: (fn, ms) => { assert.equal(ms, 45000); deadline = fn; return 1; },
    clearTimeout: id => { assert.equal(id, 1); cleared = true; },
  });
  return { ...api, expire: () => deadline(), cleared: () => cleared };
}

test('session POST preserves same-origin authentication and bounded request busy time', async () => {
  let target, options;
  const api = transport(async (url, init) => {
    target = url; options = init;
    return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('expired', 'AbortError')), { once: true }));
  });
  const pending = api.post('/login/desktop/session', {});
  assert.equal(target, '/gui/dsh-qq/login/desktop/session');
  assert.equal(options.method, 'POST');
  assert.equal(options.body, '{}');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  api.expire();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.equal(api.cleared(), true);
});

test('auth failure remains a visible recoverable error rather than navigation', async () => {
  const api = transport(async () => ({ ok: false, status: 401, json: async () => ({ error: 'auth' }) }));
  const result = await api.post('/login/desktop/session', {});
  assert.equal(result.httpStatus, 401);
  assert.match(result.error, /DSH/);
  await assert.rejects(navigateToQQLogin(async () => result, () => assert.fail('unauthenticated navigation'), () => true, ''), /DSH/);
});

test('panel has one primary same-tab action, no QR capture, iframe, popup or unmount close', () => {
  const panel = source.slice(source.indexOf('    function LoginPanel()'), source.indexOf('    // Native setup only probes'));
  assert.equal((panel.match(/style: S\.btn\(true\)/g) || []).length, 1);
  assert.match(panel, /window\.location\.assign\(url\)/);
  assert.match(panel, /finally\s*\{[\s\S]*openLock\.current = null;[\s\S]*setOpening\(false\)/);
  assert.match(panel, /window\.location\.protocol === 'http:'/);
  assert.doesNotMatch(panel, /iframe|window\.open|\/login\/(?:qr|refresh|desktop\/close)|type: 'password'|setInterval/);
  for (const deadKey of ['loginShow:', 'loginNoImage:', 'loginPrivate:', 'loginPolling:', 'desktopCloseFailed:', 'desktopFrameFailed:']) assert.equal(source.includes(deadKey), false, deadKey);
  assert.match(source, /desktopOpen: '打开 QQ 登录页'/);
  assert.match(source, /desktopOpen: 'Open QQ login page'/);
});
