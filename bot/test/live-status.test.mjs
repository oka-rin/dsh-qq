import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Bot } from '../src/bot.mjs';
import { OneBot } from '../src/onebot.mjs';
import { ControlServer } from '../src/control.mjs';
const log = { info() {}, debug() {}, warn() {}, error() {} };

async function fixture(t) {
  let nickname = 'new profile', loginNickname = 'old login cache', fail = false, invalid = false, groups = [{ group_id: 11, group_name: 'new group' }];
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const action = new URL(req.url, 'http://localhost').pathname.slice(1), params = JSON.parse(body);
    calls.push({ action, params });
    res.setHeader('content-type', 'application/json');
    const data = action === 'get_login_info' ? { user_id: 123, nickname: loginNickname }
      : action === 'get_stranger_info' ? invalid ? { nickname: null } : { user_id: 123, nickname }
      : groups;
    res.end(JSON.stringify(fail ? { status: 'failed', retcode: 1, message: 'synthetic upstream failure' } : { status: 'ok', retcode: 0, data }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const onebot = new OneBot({ httpUrl: `http://127.0.0.1:${upstream.address().port}` }, { log });
  const bot = new Bot({ config: { onebot: {}, llm: {}, persona: { name: 'persona' }, chat: { enabled: true } }, onebot, brain: {}, store: { persona: () => null, state: { stats: {} }, listScopes: () => [] }, log });
  const control = new ControlServer({ config: { control: { host: '127.0.0.1', port: 0, token: 'fixture' } }, bot, log });
  await control.listen();
  t.after(async () => { await control.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const get = async route => {
    const r = await fetch(`http://127.0.0.1:${control.server.address().port}${route}`, { headers: { authorization: 'Bearer fixture' } });
    assert.match(r.headers.get('cache-control'), /no-store/);
    return r.json();
  };
  return { bot, onebot, get, calls, set(values) { if ('nickname' in values) nickname = values.nickname; if ('fail' in values) fail = values.fail; if ('invalid' in values) invalid = values.invalid; if ('groups' in values) groups = values.groups; } };
}

test('status endpoint refreshes QQ profile each time, ignoring stale gateway login nickname', async t => {
  const f = await fixture(t);
  let s = await f.get('/api/status');
  assert.equal(s.nickname, 'new profile');
  assert.equal(s.transport.nickname, s.nickname);
  assert.equal(s.freshness.identity.ok, true);
  assert.equal(s.freshness.identity.source, 'profile');
  assert.ok(s.freshness.identity.updatedAt);
  assert.deepEqual(f.calls[1], { action: 'get_stranger_info', params: { user_id: 123, no_cache: true } });
  f.set({ nickname: 'renamed again' });
  s = await f.get('/api/status');
  assert.equal(s.nickname, 'renamed again');
  assert.equal(f.calls.length, 4);
});

test('identity refresh coalesces concurrent reads and retains last good value with explicit failure', async t => {
  const f = await fixture(t);
  await Promise.all([f.bot.refreshStatus(), f.bot.refreshStatus(), f.bot.refreshStatus()]);
  assert.equal(f.calls.length, 2);
  const lastGood = f.bot.status().freshness.identity.updatedAt;
  f.set({ invalid: true });
  const invalid = await f.get('/api/status');
  assert.equal(invalid.freshness.identity.ok, false);
  assert.equal(invalid.nickname, 'new profile');
  assert.equal(invalid.freshness.identity.updatedAt, lastGood);
  assert.equal(invalid.transport.nickname, 'new profile');
  f.set({ fail: true });
  const failed = await f.get('/api/status');
  assert.equal(failed.ok, true, 'control remains reachable even when gateway profile failed');
  assert.equal(failed.freshness.identity.ok, false);
  assert.match(failed.freshness.identity.error, /synthetic upstream failure/);
  assert.equal(failed.nickname, 'new profile');
  f.set({ fail: false, invalid: false, nickname: 'recovered' });
  assert.equal((await f.get('/api/status')).nickname, 'recovered');
});

test('group refresh exposes failures without clearing data, and valid empty list replaces cache', async t => {
  const f = await fixture(t);
  let r = await f.get('/api/groups?refresh=1');
  assert.equal(r.groups[0].group_name, 'new group');
  assert.equal(r.freshness.ok, true);
  f.set({ fail: true });
  r = await f.get('/api/groups?refresh=1');
  assert.equal(r.groups.length, 1);
  assert.equal(r.freshness.ok, false);
  f.set({ fail: false, groups: {} });
  r = await f.get('/api/groups?refresh=1');
  assert.equal(r.freshness.ok, false);
  assert.equal(r.groups.length, 1);
  f.set({ groups: [] });
  r = await f.get('/api/groups?refresh=1');
  assert.equal(r.freshness.ok, true);
  assert.equal(r.groups.length, 0);
});
