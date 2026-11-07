import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('    function scopeReplyState('), source.indexOf('    // 对话：左边会话列表'));
const { scopeReplyState, createScopeReplies } = vm.runInNewContext(`${helpers}\n({scopeReplyState, createScopeReplies})`);
const response = (scope, autochat = true, globalEnabled = true) => ({ ok: true, result: { ok: true, scope, autochat, globalEnabled, effectiveEnabled: autochat && globalEnabled } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('actual state requires matching scope, booleans, global gate and explicit success', () => {
  assert.equal(scopeReplyState(response('group:1', true, false), 'group:1').effectiveEnabled, false);
  for (const bad of [null, {}, { ok: true }, response('group:2'), response('group:1', 1), { ok: true, result: { ...response('group:1').result, effectiveEnabled: false } }]) {
    assert.throws(() => scopeReplyState(bad, 'group:1'));
  }
});

test('GET reads actual state and POST uses server result, not requested toggle', async () => {
  const updates = [], calls = [];
  const controller = createScopeReplies({ get: async path => { calls.push(path); return response('private:5', false); }, post: async (path, body) => { calls.push([path, body.enabled]); return response('private:5', true, false); }, update: (scope, state) => updates.push({ scope, ...state }) });
  await controller.read('private:5');
  assert.equal(updates.at(-1).autochat, false);
  await controller.set('private:5', false);
  assert.equal(updates.at(-1).autochat, true);
  assert.equal(updates.at(-1).globalEnabled, false);
  assert.equal(calls[0], '/autochat?scope=private%3A5');
  assert.equal(calls[1][0], '/autochat');
});

test('late GET cannot overwrite a write and writes are serialized per scope', async () => {
  const old = deferred(), write = deferred(), updates = [];
  let writes = 0;
  const controller = createScopeReplies({ get: () => old.promise, post: () => { writes++; return write.promise; }, update: (scope, state) => updates.push({ scope, ...state }) });
  const read = controller.read('group:1');
  const set = controller.set('group:1', false);
  await controller.set('group:1', true);
  assert.equal(writes, 1);
  write.resolve(response('group:1', false)); await set;
  old.resolve(response('group:1', true)); await read;
  assert.equal(updates.at(-1).autochat, false);
});

test('scope changes stay scoped; failure clears stale state; disposal suppresses late updates', async () => {
  const first = deferred(), updates = [];
  const controller = createScopeReplies({ get: path => path.includes('group%3A1') ? first.promise : Promise.resolve(response('private:2', false)), post: async () => ({ ok: false, error: 'offline' }), update: (scope, state) => updates.push({ scope, ...state }) });
  const read = controller.read('group:1'); await controller.read('private:2');
  assert.equal(updates.at(-1).scope, 'private:2');
  await controller.set('private:2', true);
  assert.equal(updates.at(-1).error, 'offline');
  assert.equal(updates.at(-1).autochat, undefined);
  const count = updates.length;
  controller.dispose(); first.resolve(response('group:1')); await read;
  assert.equal(updates.length, count);
});

test('conversation UI labels explain local/global/passive behavior and refresh actual state', () => {
  const panel = source.slice(source.indexOf('    function ChatsPanel('), source.indexOf('    function ChatsPanel(') + 16000);
  assert.match(panel, /当前会话回复：/);
  assert.match(panel, /允许回复/);
  assert.match(panel, /暂停回复/);
  assert.match(panel, /全局自动聊天已关闭/);
  assert.match(panel, /暂停后即使 @ 也不回复/);
  assert.match(panel, /不影响主动搭话/);
  assert.match(panel, /replyController\.current\?\.read\(cur\)/);
  assert.doesNotMatch(panel, /开自动聊天|关自动聊天|自动聊天：尚未读取|本次已设置/);
});

test('Host GET proxies encoded scope read-only; POST returns authoritative bot result', async () => {
  const host = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = host.indexOf("  route('/dsh-qq/autochat'");
  const routeSource = host.slice(start, host.indexOf('\n\n  // 机器人进程', start));
  let handler, lastJson; const calls = [];
  vm.runInNewContext(routeSource, { route: (_path, fn) => { handler = fn; }, json: (_res, data) => { lastJson = data; return data; }, readBody: async req => req.body, api: async (path, init) => { calls.push({ path, init }); return response('group:1', false).result; } });
  const result = await handler({ method: 'GET' }, {}, new URL('http://localhost/dsh-qq/autochat?scope=group%3A1'));
  assert.equal(result.result.autochat, false);
  assert.equal(calls[0].path, '/api/autochat?scope=group%3A1');
  assert.equal(calls[0].init, undefined);
  await handler({ method: 'POST', body: { scope: 'group:1', enabled: true } }, {}, new URL('http://localhost'));
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(lastJson.result.autochat, false);
  const missing = await handler({ method: 'GET' }, {}, new URL('http://localhost'));
  assert.equal(missing.ok, false);
  assert.equal(calls.length, 2);
});
