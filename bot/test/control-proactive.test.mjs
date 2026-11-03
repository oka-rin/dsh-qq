import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlServer } from '../src/control.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };

// Only a loopback ControlServer and fake executors: no QQ/LLM endpoints,
// configuration files, production history, or real scheduler timers.
async function fixture(t, { enabled = true, dryRun = false, missing = [], result, throws = false } = {}) {
  const calls = [];
  const config = { control: { host: '127.0.0.1', port: 0, token: '' }, agent: { enabled, dryRun } };
  const invoke = (executor, method) => async (...args) => {
    calls.push({ executor, method, args });
    if (throws) throw new Error('fake executor failure');
    return result ?? { ok: true, executor, dryRun: executor === 'agent' && config.agent.dryRun };
  };
  const agent = { act: invoke('agent', 'act'), tick: invoke('agent', 'tick') };
  const share = { share: invoke('share', 'share'), tick: invoke('share', 'tick') };
  const interject = { say: invoke('interject', 'say'), tick: invoke('interject', 'tick') };
  const server = new ControlServer({
    config,
    bot: {},
    agent: missing.includes('agent') ? null : agent,
    share: missing.includes('share') ? null : share,
    interject: missing.includes('interject') ? null : interject,
    log,
  });
  await server.listen();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.server.address().port}`;
  return {
    calls,
    post: async (route, body = {}) => {
      const response = await fetch(base + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

const routes = [
  { route: '/api/share', mode: 'share', legacy: 'share', method: 'share', missingError: '主动分享模块没启动' },
  { route: '/api/interject', mode: 'speak', legacy: 'interject', method: 'say', missingError: '定时插嘴模块没启动' },
];
const targets = [
  { label: 'explicit scope', body: { scope: 'private:123' }, scope: 'private:123' },
  { label: 'groupId', body: { groupId: 456 }, scope: 'group:456' },
  { label: 'scope takes precedence', body: { scope: 'group:789', groupId: 456 }, scope: 'group:789' },
  { label: 'automatic target', body: {}, scope: null },
];

for (const { route, mode, legacy, method, missingError } of routes) {
  for (const target of targets) {
    test(`${route}: agent enabled routes ${target.label} through ${mode}`, async (t) => {
      const f = await fixture(t);
      const response = await f.post(route, target.body);
      assert.equal(response.status, 200);
      assert.equal(response.body.executor, 'agent');
      assert.deepEqual(f.calls, [{
        executor: 'agent',
        method: target.scope ? 'act' : 'tick',
        args: target.scope ? [target.scope, { force: true, mode }] : [{ force: true, mode }],
      }]);
    });

    test(`${route}: agent disabled retains legacy ${target.label}`, async (t) => {
      const f = await fixture(t, { enabled: false });
      const response = await f.post(route, target.body);
      assert.equal(response.status, 200);
      assert.equal(response.body.executor, legacy);
      assert.deepEqual(f.calls, [{
        executor: legacy,
        method: target.scope ? method : 'tick',
        args: target.scope ? [target.scope, { force: true }] : [{ force: true }],
      }]);
    });
  }

  test(`${route}: agent dryRun is authoritative; legacy executor need not exist`, async (t) => {
    const f = await fixture(t, { dryRun: true, missing: ['share', 'interject'] });
    const response = await f.post(route, { scope: 'group:123', dryRun: false, force: false });
    assert.equal(response.status, 200);
    assert.equal(response.body.dryRun, true);
    assert.deepEqual(f.calls, [{ executor: 'agent', method: 'act', args: ['group:123', { force: true, mode }] }]);
  });

  test(`${route}: enabled agent missing fails closed instead of falling back to legacy`, async (t) => {
    const f = await fixture(t, { missing: ['agent'] });
    const response = await f.post(route);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { ok: false, error: '自主决策模块没启动' });
    assert.deepEqual(f.calls, []);
  });

  test(`${route}: disabled agent does not require agent instance`, async (t) => {
    const f = await fixture(t, { enabled: false, missing: ['agent'] });
    assert.equal((await f.post(route)).body.executor, legacy);
    assert.equal(f.calls[0].executor, legacy);
  });

  test(`${route}: disabled agent retains missing legacy error`, async (t) => {
    const f = await fixture(t, { enabled: false, missing: [legacy] });
    const response = await f.post(route);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { ok: false, error: missingError });
    assert.deepEqual(f.calls, []);
  });

  test(`${route}: preserves unsuccessful agent result`, async (t) => {
    const f = await fixture(t, { result: { ok: false, reason: 'busy' } });
    const response = await f.post(route);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: false, reason: 'busy' });
    assert.equal(f.calls.length, 1);
  });

  test(`${route}: catches executor errors without trying legacy`, async (t) => {
    const f = await fixture(t, { throws: true });
    const response = await f.post(route);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { ok: false, error: 'fake executor failure' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].executor, 'agent');
  });
}
