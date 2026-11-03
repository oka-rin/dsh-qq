import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the shipped validation/copy orchestration helpers only. Clipboard
// functions are injected; there is no React/DOM renderer or browser claim here.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('    function loginDetail('), source.indexOf('    // User-only credential action.'));
const panel = source.slice(source.indexOf('    function DesktopPasswordCopy()'), source.indexOf('    // Only this exact relative URL'));
function fixture(clock = { setTimeout, clearTimeout }) {
  return vm.runInNewContext(`${helpers}\n({ loginDetail, remoteDesktopPassword, copyDesktopPassword })`, { tr: key => key, ...clock });
}
const { loginDetail, remoteDesktopPassword, copyDesktopPassword } = fixture();
const value = 'synthetic-vnc-secret';

test('validates explicit success and a bounded nonempty password without trimming', () => {
  assert.equal(remoteDesktopPassword({ ok: true, password: ' pass word ' }), ' pass word ');
  for (const result of [null, {}, { ok: true }, { ok: 1, password: value }, ...['', 3, null, 'x'.repeat(4097), 'one\ntwo', 'one\rtwo', 'one\0two'].map(password => ({ ok: true, password }))]) {
    assert.throws(() => remoteDesktopPassword(result));
  }
  assert.throws(() => remoteDesktopPassword({ ok: false, error: 'Docker password unavailable' }), /Docker password unavailable/);
  assert.throws(() => remoteDesktopPassword({ ok: false, password: value, reason: `bad ${value}` }), error => !error.message.includes(value));
});

test('failure detail is bounded and redacts credential/image bytes', () => {
  assert.equal(loginDetail(`bad ${value} / ${value}`, value), 'bad [private password] / [private password]');
  assert.equal(loginDetail('data:image/png;base64,private'), '[private image]');
  assert.equal(loginDetail('x'.repeat(1000)).length, 700);
});

test('HTTP compatibility: legacy copy runs synchronously, first, with no secure API dependency', async () => {
  const calls = [];
  const pending = copyDesktopPassword(value, secret => { calls.push(secret); return true; }, null, () => true);
  assert.deepEqual(calls, [value]); // Before awaiting, as needed for a fresh trusted click.
  assert.equal((await pending).ok, true);
});

test('secure clipboard fallback also starts before yielding and only after legacy denial', async () => {
  const calls = [];
  const pending = copyDesktopPassword(value, () => { calls.push('legacy'); return false; }, secret => { calls.push(secret); return Promise.resolve(); }, () => true);
  assert.deepEqual(calls, ['legacy', value]);
  assert.equal((await pending).ok, true);
});

test('denied HTTP/secure copy never reports copied; reasons survive but secret does not', async () => {
  const http = await copyDesktopPassword(value, () => false, null, () => true);
  assert.equal(http.ok, false);
  assert.match(http.error, /desktopCopyDenied.*desktopCopyUnavailable/);
  const denied = await copyDesktopPassword(value, () => { throw new Error('copy blocked'); }, () => Promise.reject(new Error(`NotAllowedError: ${value}`)), () => true);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /NotAllowedError/);
  assert.equal(denied.error.includes(value), false);
  const thrown = await copyDesktopPassword(value, () => false, () => { throw new Error(`disabled ${value}`); }, () => true);
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.includes(value), false);
});

test('bounded clipboard deadline releases busy wait and handles a later rejection', async () => {
  let expire, failLate, cleared = false;
  const api = fixture({
    setTimeout: (fn, ms) => { assert.equal(ms, 2000); expire = fn; return 7; },
    clearTimeout: id => { assert.equal(id, 7); cleared = true; },
  });
  const pending = api.copyDesktopPassword(value, () => false, () => new Promise((_resolve, reject) => { failLate = reject; }), () => true);
  expire();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'desktopCopyTimeout');
  assert.equal(cleared, true);
  failLate(new Error(value));
  await new Promise(resolve => setImmediate(resolve));
});

test('stale lifetime never copies or shows a late success', async () => {
  const stale = await copyDesktopPassword(value, () => assert.fail('stale copy'), null, () => false);
  assert.equal(stale.ok, false);
  let resolve, current = true;
  const pending = copyDesktopPassword(value, () => false, () => new Promise(done => { resolve = done; }), () => current);
  current = false; resolve();
  assert.equal((await pending).ok, false);
});

test('legacy implementation copies real selected textarea, checks true, wipes/removes it in finally', () => {
  const legacy = helpers.slice(helpers.indexOf('    function legacyCopyPassword('), helpers.indexOf('    async function copyDesktopPassword('));
  assert.match(legacy, /document\.createElement\('textarea'\)/);
  assert.match(legacy, /field\.readOnly = true/);
  assert.match(legacy, /field\.select\(\);[\s\S]*field\.setSelectionRange/);
  assert.match(legacy, /return document\.execCommand\('copy'\) === true/);
  assert.match(legacy, /finally \{\s*field\.value = '';\s*field\.remove\(\)/);
});

test('user-only component fetches exactly on explicit action and keeps same-tab login intact', () => {
  assert.equal((panel.match(/post\('\/login\/original\/password', \{\}\)/g) || []).length, 1);
  const effect = panel.slice(panel.indexOf('React.useEffect'), panel.indexOf('const run = async'));
  assert.doesNotMatch(effect, /post\(|get\(|fetch\(/);
  assert.match(panel, /onClick: \(\) => run\(false\)/);
  assert.match(panel, /onClick: \(\) => run\(true\)/);
  assert.match(panel, /window\.isSecureContext && typeof navigator\.clipboard\?\.writeText === 'function'/);
  const login = source.slice(source.indexOf('    function LoginPanel()'), source.indexOf('    // Native setup only probes'));
  assert.match(login, /h\(DesktopPasswordCopy\)/);
  assert.match(login, /window\.location\.assign\(url\)/);
  assert.doesNotMatch(panel, /console\.|localStorage|sessionStorage|URLSearchParams|window\.location|navigator\.clipboard\.writeText\(''\)/);
});

test('NapCat token responses are wiped after copy, invalid validation, late unmount and TTL', async () => {
  const token = 'synthetic-napcat-token-0123456789';
  async function mount({ late = false, invalid = false, copied = false } = {}) {
    const refs = [], timers = []; let cleanup, resolve;
    const response = { ok: true, token: invalid ? 'eightchr' : token };
    const React = {
      useState: value => [value, () => {}],
      useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
      useEffect: fn => { cleanup = fn(); },
    };
    const Component = vm.runInNewContext(`${helpers}\ncopyDesktopPassword = async () => ({ ok: ${copied} });\n${panel}\nDesktopPasswordCopy`, {
      React, tr: key => key, h: (type, props, ...children) => ({ type, props, children }),
      S: { btn: () => ({}), dim: {} }, T: {}, 行: {}, 输入框: {}, window: {}, navigator: {},
      post: (route, input) => { assert.equal(route, '/login/napcat/token'); assert.equal(JSON.stringify(input), '{}'); return late ? new Promise(done => { resolve = done; }) : Promise.resolve(response); },
      setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    });
    const tree = Component({ napcat: true });
    const pending = tree.children[0].props.onClick();
    if (late) { cleanup(); resolve(response); }
    await pending;
    assert.equal(response.token, '', 'response container is wiped even for stale/invalid data');
    return { refs, timers, cleanup };
  }
  const success = await mount({ copied: true }); assert.equal(success.refs[0].current, null);
  const fallback = await mount(); assert.equal(fallback.refs[0].current.value, token);
  const held = fallback.refs[0].current; fallback.timers[0](); assert.equal(held.value, ''); assert.equal(fallback.refs[0].current, null);
  const unmount = await mount(); const retained = unmount.refs[0].current; unmount.cleanup(); assert.equal(retained.value, '');
  await mount({ invalid: true }); await mount({ late: true });
});

test('fallback is readonly/masked until explicit reveal and fully cleared by TTL/unmount', () => {
  assert.match(panel, /type: 'password', readOnly: true/);
  assert.match(panel, /input\.current\.type = 'text'; input\.current\.focus\(\); input\.current\.select\(\)/);
  assert.match(panel, /if \(secret\.current\) secret\.current\.value = '';\s*secret\.current = null/);
  assert.match(panel, /input\.current\.value = ''; input\.current\.type = 'password'/);
  assert.match(panel, /return \(\) => \{ mounted\.current = false;[^\n]*clearSecret\(\)/);
  assert.match(panel, /expiresAt: Date\.now\(\) \+ 30000/);
  assert.match(panel, /expiry\.current = setTimeout\(\(\) => \{\s*clearSecret\(\)/);
  assert.match(panel, /\}, 30000\)/);
  assert.match(panel, /held\.expiresAt <= Date\.now\(\)/);
  assert.match(panel, /finally \{[\s\S]*lock\.current = null;[\s\S]*setBusy\(false\)/);
  assert.match(panel, /setCopied\(true\)/);
  assert.match(panel, /if \(result\.ok\) \{\s*clearSecret\(\); setFallback\(false\); setCopied\(true\)/);
  for (const text of ['复制远程桌面密码', 'Copy remote desktop password', '再次复制', 'Copy again', '不是 QQ 密码', 'not your QQ password']) assert.equal(source.includes(text), true, text);
});
