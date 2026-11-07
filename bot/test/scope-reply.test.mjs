import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Bot } from '../src/bot.mjs';
import { ControlServer } from '../src/control.mjs';
import { Store } from '../src/store.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };

// Real persisted state plus a loopback API; never start a bot or connect QQ/LLM.
async function fixture(t, { globalEnabled = true, token = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-scope-reply-'));
  const config = {
    onebot: { selfId: '9' },
    chat: { enabled: globalEnabled },
    control: { host: '127.0.0.1', port: 0, token },
    storage: { dataDir: dir },
  };
  const store = new Store(dir);
  const bot = new Bot({ config, store, onebot: {}, brain: {}, log });
  const server = new ControlServer({ config, bot, log });
  await server.listen();
  t.after(async () => {
    await server.close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('qq-scope-reply-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  async function request(route, { method = 'GET', body, authorized = true } = {}) {
    const headers = {};
    if (authorized && token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, {
      method, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  }
  return { bot, store, config, request,
    get: (scope) => request('/api/autochat?scope=' + encodeURIComponent(scope)),
    post: (body) => request('/api/autochat', { method: 'POST', body }),
  };
}

const status = (scope, autochat, globalEnabled = true) => ({
  scope, autochat, globalEnabled, effectiveEnabled: autochat && globalEnabled,
});

test('scope reply status: defaults are enabled and GET is strictly read only', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.store.state);
  f.store.scopeState = () => { throw new Error('a read must not create a scope'); };
  f.store.save = () => { throw new Error('a read must not save state'); };
  for (const scope of ['group:123', 'private:456', ' group:789 ']) {
    assert.deepEqual(f.bot.getAutochat(scope), status(scope.trim(), true));
    assert.deepEqual(await f.get(scope), { status: 200, body: { ok: true, ...status(scope.trim(), true) } });
  }
  assert.deepEqual(f.store.state, before);
  assert.equal(fs.existsSync(f.store.stateFile), false);
  assert.deepEqual(fs.readdirSync(f.store.historyDir), []);
});

test('scope reply status: a persisted pause survives reload and GET never rewrites it', async (t) => {
  const f = await fixture(t);
  f.bot.setAutochat('group:123', false);
  f.store.state.scopes['group:123'].replies = 7;
  f.store.state.scopes['group:123'].lastReplyAt = 42;
  f.store.save();
  f.bot.store = new Store(f.store.dataDir);
  const before = fs.readFileSync(f.store.stateFile, 'utf8');
  const beforeState = structuredClone(f.bot.store.state);
  assert.deepEqual(await f.get('group:123'), { status: 200, body: { ok: true, ...status('group:123', false) } });
  assert.deepEqual(await f.get('private:456'), { status: 200, body: { ok: true, ...status('private:456', true) } });
  assert.deepEqual(f.bot.store.state, beforeState);
  assert.equal(fs.readFileSync(f.store.stateFile, 'utf8'), before);
});

test('scope reply status: global off is separate from the local allow/pause gate', async (t) => {
  const f = await fixture(t, { globalEnabled: false });
  assert.deepEqual(await f.get('private:123'), { status: 200, body: { ok: true, ...status('private:123', true, false) } });
  f.bot.setAutochat('private:123', false);
  assert.deepEqual(await f.get('private:123'), { status: 200, body: { ok: true, ...status('private:123', false, false) } });
  f.config.chat.enabled = true;
  assert.deepEqual(f.bot.getAutochat('private:123'), status('private:123', false, true));
});

test('scope reply status: matches trigger Boolean semantics for existing state and global gate', async (t) => {
  const f = await fixture(t);
  const entries = [
    [{}, false], [{ autochat: undefined }, false], [{ autochat: null }, false],
    [{ autochat: false }, false], [{ autochat: 0 }, false], [{ autochat: '' }, false],
    [{ autochat: 'false' }, true], [{ autochat: 1 }, true],
    [null, true], [undefined, true],
  ];
  for (const [entry, enabled] of entries) {
    f.store.state.scopes['group:123'] = entry;
    for (const global of [true, false, 0, '', undefined, null, 'false', 1]) {
      f.config.chat.enabled = global;
      assert.deepEqual(f.bot.getAutochat('group:123'), status('group:123', enabled, Boolean(global)));
      assert.equal(f.store.state.scopes['group:123'], entry);
    }
  }
});

test('scope reply POST: returns authoritative gates and preserves persisted counters and defaults', async (t) => {
  const f = await fixture(t, { globalEnabled: false });
  f.store.scopeState('group:123').replies = 7;
  f.store.scopeState('group:123').lastReplyAt = 42;
  for (const [body, enabled] of [
    [{ scope: ' group:123 ', enabled: false }, false],
    [{ scope: 'group:123', enabled: true }, true],
    [{ scope: 'group:123' }, true],
    [{ scope: 'group:123', enabled: 0 }, true],
    [{ scope: 'group:123', enabled: null }, true],
  ]) {
    const expected = { ok: true, replies: 7, lastReplyAt: 42, ...status('group:123', enabled, false) };
    assert.deepEqual(await f.post(body), { status: 200, body: expected });
    assert.deepEqual(new Store(f.store.dataDir).state.scopes['group:123'], { autochat: enabled, replies: 7, lastReplyAt: 42 });
    assert.deepEqual((await f.get('group:123')).body, { ok: true, ...status('group:123', enabled, false) });
    assert.equal(f.config.chat.enabled, false);
  }
  assert.deepEqual((await f.post({ scope: 'private:456', enabled: false })).body, {
    ok: true, replies: 0, lastReplyAt: 0, ...status('private:456', false, false),
  });
});

test('scope reply API: token authorization and existing scopeKey validation apply to reads and writes', async (t) => {
  const f = await fixture(t, { token: 'scope-test-token' });
  assert.equal((await f.request('/api/autochat?scope=group:123', { authorized: false })).status, 401);
  assert.equal((await f.request('/api/autochat', { method: 'POST', body: { scope: 'group:123', enabled: false }, authorized: false })).status, 401);
  for (const route of ['/api/autochat', '/api/autochat?scope=']) {
    assert.deepEqual(await f.request(route), { status: 400, body: { ok: false, error: '缺少 scope' } });
  }
  for (const scope of ['other:123', 'group:abc', 'private:123/../../state', '   ']) {
    assert.throws(() => f.bot.getAutochat(scope), /scope/);
    for (const result of [await f.get(scope), await f.post({ scope, enabled: false })]) {
      assert.equal(result.status, 400);
      assert.equal(result.body.ok, false);
      assert.match(result.body.error, /scope/);
    }
  }
  assert.deepEqual(f.store.state.scopes, {});
  assert.equal(fs.existsSync(f.store.stateFile), false);
});
