import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { apply } from '../index.js';
import { TOOLS } from '../bot/src/tools.mjs';
import { createBotManager } from '../runtime.js';

test('native tools preserve nested required schemas, JSON requests and failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-test-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ storage: { dataDir: 'ledger' } }));
  const calls = [], routes = new Map(), tools = new Map(), disposers = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/send' ? { ok: false, error: 'send rejected' } : { ok: true, data: { done: true } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ctx = {
    effect(fn) { const d = fn(); if (d) disposers.push(d); }, logger: { info() {} },
    webServer: { register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path); } },
    tools: { register(t) { tools.set(t.name, t); return () => tools.delete(t.name); } },
  };
  try {
    const live = apply(ctx, { dataDir: root, manageBot: false, controlUrl: `http://127.0.0.1:${server.address().port}` });
    await live.ready;
    assert.equal(tools.size, TOOLS.length + 2);
    assert.ok(tools.has('qq_setup')); assert.ok(tools.has('qq_gateway'));
    const forward = tools.get('qq_forward').parameters;
    assert.deepEqual(forward.properties.nodes.items.required, ['content']);
    await tools.get('qq_raw_action').execute({ action: 'get_login_info', params: { test: 1 } });
    assert.deepEqual(calls.at(-1).body, { action: 'get_login_info', params: { test: 1 } });
    await assert.rejects(tools.get('qq_send_message').execute({ scope: 'private:123', text: 'hello' }), /send rejected/);
    fs.mkdirSync(path.join(root, 'ledger/history'), { recursive: true });
    const long = 'x'.repeat(1100);
    fs.writeFileSync(path.join(root, 'ledger/history/private_123.jsonl'), JSON.stringify({ text: long, ts: 1000 }) + '\n');
    const result = await live.overview(new URL('http://test/?scope=private:123'));
    assert.equal(result.messages[0].text.length, 1100);
  } finally { for (const d of disposers.reverse()) d(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('first-run setup works without a backend and model listing respects disabled environment credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-first-run-'));
  const routes = new Map(), disposers = [];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: [{ id: 'test-model' }] })); };
  process.env.DEEPSEEK_API_KEY = 'must-not-leak';
  const ctx = { effect(fn) { const d = fn(); if (d) disposers.push(d); }, logger: { info() {} }, webServer: { register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path); } }, tools: { register() { return () => {}; } } };
  t.after(() => { for (const d of disposers.reverse()) d(); globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = originalKey; fs.rmSync(root, { recursive: true, force: true }); });
  const live = apply(ctx, { dataDir: root, manageBot: false }); await live.ready;
  const invoke = async route => { let body; await routes.get(route)({ url: route, method: 'GET' }, { writeHead() {}, end(s) { body = JSON.parse(s); } }); return body; };
  const status = await invoke('/dsh-qq/setup');
  assert.equal(status.ok, true); assert.equal(status.preferredMode, 'native'); assert.equal(calls.length, 0);
  const file = path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.agent.enabled, false);
  config.llm = { baseUrl: 'https://new-provider.example/v1', apiKey: '', apiKeyEnv: '' };
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(root, '.env'), 'DEEPSEEK_API_KEY=file-key-must-not-leak\n');
  assert.equal((await invoke('/dsh-qq/setup')).current.hasApiKey, false);
  const models = await invoke('/dsh-qq/models');
  assert.deepEqual(models.models, ['test-model']);
  assert.equal(calls.length, 1); assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[0].url, 'https://new-provider.example/v1/models');
});

test('process lifecycle serializes starts, refuses attached restart and fences disposal', async () => {
  let probes = 0, initialized = 0;
  const manager = createBotManager({ enabled: true, entry: '/missing', cwd: '/', env: {}, initialize() { initialized++; }, async probe() { probes++; await new Promise(r => setTimeout(r, 10)); return true; }, log() {} });
  await Promise.all([manager.start(), manager.start()]);
  assert.equal(manager.state.attached, true);
  await assert.rejects(manager.restart(), /外部机器人/);
  manager.dispose(); await manager.start();
  assert.equal(probes, 3); assert.equal(initialized, 2);
});
