import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ControlServer } from '../src/control.mjs';
import { Store } from '../src/store.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-sync-'));
  const configPath = path.join(dir, 'config.json');
  const config = { control: { host: '127.0.0.1', port: 0, token: 'test' }, persona: { name: 'old', style: 'old style' }, llm: { apiKey: 'preserve-secret' } };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const current = { name: 'new', style: 'new style', systemPrompt: 'FULL'.repeat(6000), beginDialogs: [{ role: 'assistant', content: 'example' }], abstract: false, custom: { keep: true } };
  let persona = structuredClone(current);
  let fail = false;
  const bot = { store: { persona: () => persona, setPersona(p) { if (fail) throw new Error('synthetic state write failure'); persona = p; return p; } } };
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => delay === 400 ? { unref() {} } : original(fn, delay, ...args));
  const server = new ControlServer({ config, configPath, bot, log: { info() {}, error() {} } });
  await server.listen();
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${server.server.address().port}${route}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { server, request, configPath, current, persona: () => persona, fail: () => { fail = true; } };
}

test('settings schema, editable and persona endpoint share runtime persona precedence', async t => {
  const f = await fixture(t);
  const { body } = await f.request('/api/config');
  assert.equal(body.editable.persona.name, 'new');
  assert.equal(body.editable.persona.systemPrompt, f.current.systemPrompt);
  assert.equal(body.schema.flatMap(g => g.fields).find(x => x.path === 'persona.name').value, 'new');
  assert.deepEqual((await f.request('/api/persona')).body.persona, f.current);
  const before = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal((await f.request('/api/persona', { persona: { name: 'new' } })).status, 200);
  const saved = JSON.parse(fs.readFileSync(f.configPath));
  assert.deepEqual({ ...saved, persona: null }, { ...before, persona: null }, 'persona-only edits do not materialize runtime defaults or modify unrelated settings');
});

test('both settings routes and live persona edits persist full persona without dropping imported fields', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/config', { updates: { 'llm.reasoningEffort': 'low' } })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)).persona, f.current, 'unrelated settings cannot restore old persona');
  assert.equal((await f.request('/api/config', { updates: { 'persona.name': 'renamed' } })).status, 200);
  assert.equal(f.persona().name, 'renamed', 'settings must update persisted runtime override too');
  assert.equal((await f.request('/api/config', { patch: { persona: { systemPrompt: f.current.systemPrompt, style: 'edited' } } })).status, 200);
  assert.equal(f.persona().systemPrompt.length, 24000, 'full prompt cannot be silently truncated');
  assert.equal((await f.request('/api/persona', { persona: { name: 'tool-edit' } })).status, 200);
  const saved = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(saved.persona.name, 'tool-edit');
  assert.equal(saved.persona.style, 'edited');
  assert.equal(saved.persona.systemPrompt, f.current.systemPrompt);
  assert.deepEqual(saved.persona.beginDialogs, f.current.beginDialogs);
  assert.deepEqual(saved.persona.custom, f.current.custom);
  assert.equal(saved.persona.abstract, false);
  assert.deepEqual(saved.persona, f.persona());
  assert.equal(saved.llm.apiKey, 'preserve-secret');
  assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
});

test('failed state write rolls config and runtime view back rather than reporting saved', async t => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.configPath, 'utf8');
  f.fail();
  const r = await f.request('/api/persona', { persona: { name: 'never-saved' } });
  assert.equal(r.status, 500);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  assert.deepEqual(f.persona(), f.current);
});

test('Store rolls in-memory persona back when persistence fails', () => {
  const old = { name: 'old' };
  const fake = { state: { persona: old }, save() { throw new Error('write failed'); } };
  assert.throws(() => Store.prototype.setPersona.call(fake, { name: 'new' }), /write failed/);
  assert.equal(fake.state.persona, old);
});
