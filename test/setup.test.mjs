import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSetup, localUrl, nativeServiceArgs, nativeStatus } from '../setup.js';
class Socket extends EventTarget {
  constructor(url) { super(); this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-setup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const initial = { onebot: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001/event', accessToken: 'secret', wsAccessToken: 'ws-secret' }, llm: { apiKey: 'model-secret', model: 'old' }, persona: { systemPrompt: 'keep this' }, storage: { dataDir: 'archive' }, arbitrary: ['keep'] };
  fs.writeFileSync(configPath, JSON.stringify(initial));
  return { root, configPath, initial };
}
const good = async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 123, nickname: 'Test bot' } }), { status: 200 });
test('local endpoint validation rejects public, credential, query and path SSRF; allows /event', () => {
  for (const u of ['http://example.com', 'http://127.0.0.1@evil.com', 'http://127.0.0.1/?token=secret', 'http://127.0.0.1/path', 'file:///tmp/x']) assert.throws(() => localUrl(u));
  assert.equal(localUrl('ws://[::1]:3001/event', ['ws:', 'wss:']), 'ws://[::1]:3001/event');
});
test('setup status never exposes tokens/keys and does not execute deployment commands', async t => {
  const f = fixture(t); let commands = 0;
  const setup = createSetup({ configPath: f.configPath, run: async () => { commands++; return ''; } });
  const status = await setup.status();
  assert.equal(status.preferredMode, 'native'); assert.equal(status.automaticInstall.available, false);
  assert.equal(status.current.hasToken, true); assert.equal(status.current.hasApiKey, true);
  assert.ok(!JSON.stringify(status).includes('secret')); assert.equal(commands, 0);
});
test('connect probes both transports, preserves config and makes private backup', async t => {
  const f = fixture(t); let auth, target;
  class Capture extends Socket { constructor(u) { super(u); target = String(u); } }
  const setup = createSetup({ configPath: f.configPath, Socket: Capture, fetcher: async (_url, init) => { auth = init.headers.authorization; assert.equal(init.redirect, 'error'); return good(); } });
  const result = await setup.connect({ httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001/event', llm: { model: 'new' } });
  assert.equal(result.websocket, 'open'); assert.equal(result.restartRequired, true); assert.equal(auth, 'Bearer secret'); assert.match(target, /ws-secret/);
  const saved = JSON.parse(fs.readFileSync(f.configPath));
  assert.deepEqual(saved.persona, f.initial.persona); assert.deepEqual(saved.storage, f.initial.storage); assert.deepEqual(saved.arbitrary, ['keep']); assert.equal(saved.llm.model, 'new'); assert.equal(saved.llm.models.chat, 'new'); assert.equal(saved.llm.apiKey, 'model-secret');
  assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
  const backup = fs.readdirSync(f.root).find(n => n.includes('before-setup'));
  assert.equal(fs.statSync(path.join(f.root, backup)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, backup))), f.initial);
});
test('changing endpoint never forwards old secrets, invalid login never writes', async t => {
  const f = fixture(t); let hits = 0;
  const setup = createSetup({ configPath: f.configPath, Socket, fetcher: async () => { hits++; return new Response('{}'); } });
  await assert.rejects(setup.check({ httpUrl: 'http://127.0.0.1:3900' }), /重新输入/); assert.equal(hits, 0);
  await assert.rejects(setup.connect({ token: '' }), /尚未登录/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)), f.initial);
  assert.equal(fs.readdirSync(f.root).length, 1);
});
test('replacement token applies both transports and clears stale WS token', async t => {
  const f = fixture(t);
  const setup = createSetup({ configPath: f.configPath, Socket, fetcher: good });
  await setup.connect({ token: 'replacement' });
  const c = JSON.parse(fs.readFileSync(f.configPath)); assert.equal(c.onebot.accessToken, 'replacement'); assert.equal(c.onebot.wsAccessToken, undefined);
});
test('changing model endpoints cannot reuse old inline or environment credentials', async t => {
  const f = fixture(t);
  const setup = createSetup({ configPath: f.configPath, Socket, fetcher: good });
  await assert.rejects(setup.connect({ llm: { baseUrl: 'https://new-provider.example/v1' } }), /须明确填写新 API Key/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)), f.initial);
  assert.equal(fs.readdirSync(f.root).length, 1);
  await setup.connect({ llm: { baseUrl: 'https://new-provider.example/v1', apiKey: '' } });
  let saved = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(saved.llm.apiKey, ''); assert.equal(saved.llm.apiKeyEnv, '');
  await setup.connect({ llm: { baseUrl: 'https://another-provider.example/v1', apiKey: 'new-key' } });
  saved = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(saved.llm.apiKey, 'new-key'); assert.equal(saved.llm.apiKeyEnv, '');
});
test('native service commands are shell-free and reject injection; status distinguishes missing services', async () => {
  assert.deepEqual(nativeServiceArgs('snowluma.target', 'user', 'restart'), ['--user', 'restart', 'snowluma.target']);
  for (const name of ['--help', '/tmp/x.service', 'a;evil.service', 'snowluma']) assert.throws(() => nativeServiceArgs(name));
  const status = await nativeStatus('snowluma.target', 'system', async () => { throw new Error('Unit snowluma.target could not be found.'); });
  assert.equal(status.status, 'not-installed');
});
test('WS authentication failure and concurrent config edits cannot be saved', async t => {
  const f = fixture(t);
  class Failed extends EventTarget { constructor() { super(); this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('error'))); } }
  const failed = createSetup({ configPath: f.configPath, Socket: Failed, fetcher: good });
  await assert.rejects(failed.connect(), /WebSocket/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)), f.initial);
  const changed = { ...f.initial, arbitrary: ['newer-edit'] };
  const racing = createSetup({ configPath: f.configPath, Socket, fetcher: async () => { fs.writeFileSync(f.configPath, JSON.stringify(changed)); return good(); } });
  await assert.rejects(racing.connect(), /配置在检测期间已变化/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)), changed);
  assert.equal(fs.readdirSync(f.root).length, 1);
});
