import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const host = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const cacheSource = host.slice(host.indexOf('  // Keep last-good data'), host.indexOf('  const readAgentLog'));
const overviewSource = host.slice(host.indexOf('  const overview = async'), host.indexOf('  const readBody = async'));
function fixture() {
  let now = 1000;
  const values = new Map(), calls = [];
  const DateMock = class extends Date { static now() { return now; } };
  const context = {
    Date: DateMock, URL, cfg: {}, botState: {}, logs: [],
    readBotConfig: () => ({ llm: { model: 'configured-not-runtime' } }), controlBase: () => 'http://localhost',
    summarize: () => ({}), readAgentLog: () => [], readMemory: () => [], readArchive: () => [], readMessages: () => [],
    api: async path => { calls.push(path); const value = values.get(path); if (value instanceof Error) throw value; return typeof value === 'function' ? value() : structuredClone(value || { ok: true }); },
  };
  const functions = vm.runInNewContext(`${cacheSource}\n${overviewSource}\n({readSource,freshGroups,overview})`, context);
  return { ...functions, values, calls, advance: ms => { now += ms; } };
}

test('overview preserves last-good lists on partial errors and marks identity separately from transport', async () => {
  const f = fixture();
  f.values.set('/api/status', { ok: true, nickname: '新昵称', model: 'runtime', freshness: { identity: { checkedAt: 1000, updatedAt: 1000, ok: true, error: '' } } });
  f.values.set('/api/groups?refresh=1', { ok: true, groups: [{ group_id: 1, group_name: '新群名' }], freshness: { checkedAt: 1000, updatedAt: 1000, ok: true, error: '' } });
  f.values.set('/api/friends', { ok: true, friends: [{ user_id: 2 }] });
  let out = await f.overview(new URL('http://localhost/overview'));
  assert.equal(out.status.nickname, '新昵称');
  assert.equal(out.freshness.identity.ok, true);
  f.advance(2000);
  f.values.set('/api/friends', Error('friend API down'));
  f.values.set('/api/groups?refresh=1', Error('group API down'));
  f.values.set('/api/status', { ok: true, nickname: '新昵称', freshness: { identity: { checkedAt: 3000, updatedAt: 1000, ok: false, error: 'profile down' } } });
  out = await f.overview(new URL('http://localhost/overview?refresh=1'));
  assert.equal(out.friends.length, 1);
  assert.equal(out.groups.length, 1);
  assert.equal(out.freshness.friends.ok, false);
  assert.equal(out.freshness.friends.updatedAt, 1000);
  assert.equal(out.freshness.groups.ok, false);
  assert.equal(out.freshness.identity.ok, false);
  assert.equal(out.control.reachable, true, 'profile failure is not transport failure');
  assert.equal(out.status.nickname, '新昵称');
});

test('first failure yields unknown not fake zero; force refresh bypasses group TTL and concurrent reads deduplicate', async () => {
  const f = fixture();
  f.values.set('/api/groups?refresh=1', Error('offline'));
  f.values.set('/api/friends', Error('offline'));
  let out = await f.overview(new URL('http://localhost/overview'));
  assert.equal(out.groups, null);
  assert.equal(out.friends, null);
  assert.equal(out.freshness.groups.updatedAt, null);
  f.values.set('/api/groups?refresh=1', { ok: true, groups: [] });
  await f.freshGroups(); const count = f.calls.length;
  await f.freshGroups(); assert.equal(f.calls.length, count);
  await f.freshGroups(true); assert.equal(f.calls.length, count + 1);
  let resolve; f.values.set('/api/friends', () => new Promise(r => { resolve = r; }));
  const first = f.readSource('friends', '/api/friends'); const second = f.readSource('friends', '/api/friends');
  const active = f.calls.filter(x => x === '/api/friends').length;
  resolve({ ok: true, friends: [] }); await Promise.all([first, second]);
  assert.equal(f.calls.filter(x => x === '/api/friends').length, active);
});

test('UI selector labels old/unknown identity, child failures and manual force without config model fallback', () => {
  const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = client.indexOf('      function overviewSource(');
  const end = client.indexOf('      const { live, later }', start);
  const select = vm.runInNewContext(`${client.slice(start, end)}\noverviewSource`);
  assert.match(select({}, 'identity').suffix, /未验证/);
  assert.match(select({ freshness: { identity: { ok: false, updatedAt: 1000, checkedAt: 2000, error: 'bad profile' } } }, 'identity').suffix, /旧值/);
  assert.match(select({ freshness: { identity: { ok: false } } }, 'identity').suffix, /未知/);
  assert.match(client, /部分数据刷新失败/);
  assert.match(client, /拉\(scope, true\)/);
  assert.match(client, /force \? '&refresh=1'/);
  assert.doesNotMatch(client, /st\.model \|\| view\.editable/);
  assert.match(client, /!脏Ref\.current && !保存中Ref\.current/);
});
