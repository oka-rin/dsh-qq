import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_SCHEMA, FIELD_BY_PATH, getByPath, setByPath } from '../src/schema.mjs';
import { ControlServer } from '../src/control.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

test('schema helpers read and write nested paths without touching the source object', () => {
  const src = { a: { b: { c: 1 } }, list: [1, 2] };
  assert.equal(getByPath(src, 'a.b.c'), 1);
  assert.equal(getByPath(src, 'a.b.missing'), undefined);
  assert.equal(getByPath(src, 'nope.deep'), undefined);

  const next = setByPath(src, 'a.b.c', 9);
  assert.equal(getByPath(next, 'a.b.c'), 9);
  assert.equal(src.a.b.c, 1, '源对象不能被改');
  assert.notEqual(next.a.b, src.a.b, '链上每层都要复制');

  const created = setByPath({}, 'x.y.z', 'v');
  assert.deepEqual(created, { x: { y: { z: 'v' } } });
});

test('every field path is unique and present in the public example config', () => {
  const paths = CONFIG_SCHEMA.flatMap((g) => g.fields.map((f) => f.path));
  assert.equal(FIELD_BY_PATH.size, paths.length, '同一个 path 不能登记两次');
  assert.equal(CONFIG_SCHEMA.length, 12);
  assert.equal(paths.length, 201);
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const missing = paths.filter((p) => getByPath(live, p) === undefined);
  assert.deepEqual(missing, [], '公开示例应包含全部可编辑字段，测试不得依赖私人 config.json');
  const uncovered = [];
  function visit(value, prefix = '') {
    for (const [key, child] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (FIELD_BY_PATH.has(p)) continue;
      if (child && typeof child === 'object' && !Array.isArray(child)) visit(child, p);
      else uncovered.push(p);
    }
  }
  visit(live);
  assert.deepEqual(uncovered, [], '现有配置的每个叶子都应有编辑入口');
});

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-schema-'));
  const configPath = path.join(dir, 'config.json');
  const config = {
    control: { host: '127.0.0.1', port: 0, token: 'schema-test' },
    storage: { dataDir: dir },
    llm: { apiKey: 'keep-me', apiKeyEnv: 'SCHEMA_TEST_KEY' },
    chat: { draw: { maxPerDay: 6 }, vision: { maxImages: 6 }, whitelistGroups: [], quietHours: [] },
    __runtimeOnly: 'do not persist',
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 400) return { unref() {} };
    return originalSetTimeout(fn, delay, ...args);
  });
  const server = new ControlServer({
    config, configPath, log: { info() {}, error() {} },
    bot: { send() { throw new Error('QQ sends forbidden'); } },
  });
  await server.listen();
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const request = (route, init = {}) => fetch(base + route, {
    ...init, headers: { authorization: 'Bearer schema-test', 'content-type': 'application/json', ...init.headers },
  });
  const post = (updates) => request('/api/config', { method: 'POST', body: JSON.stringify({ updates }) });
  return { server, config, configPath, request, post };
}

test('GET /api/config exposes the whole schema, with secrets masked', async (t) => {
  const f = await fixture(t);
  const body = await (await f.request('/api/config')).json();
  assert.equal(body.ok, true);
  assert.equal(body.schema.length, 12);
  assert.equal(body.schema.flatMap((g) => g.fields).length, 201);

  const secret = body.schema.flatMap((g) => g.fields).find((fl) => fl.path === 'llm.apiKey');
  assert.equal(secret.value, '', '密钥不能回显');
  assert.equal(secret.set, true, '已经设置过的密钥要标出来');
  const draw = body.schema.flatMap((g) => g.fields).find((fl) => fl.path === 'chat.draw.maxPerDay');
  assert.equal(draw.value, 6, '普通字段要带当前值');
});

test('POST /api/config writes nested updates and rejects bad input', async (t) => {
  const f = await fixture(t);

  const ok = await f.post({ 'chat.draw.maxPerDay': 3, 'chat.vision.maxImages': 4 });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.changed, 2);
  assert.deepEqual(okBody.saved, ['chat.draw.maxPerDay', 'chat.vision.maxImages']);
  const onDisk = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.equal(onDisk.chat.draw.maxPerDay, 3);
  assert.equal(onDisk.chat.vision.maxImages, 4);
  assert.equal(onDisk.__runtimeOnly, undefined, '__ 开头的运行时字段不能落盘');

  // 密钥留空 = 保持原值
  const secret = await f.post({ 'llm.apiKey': '' });
  assert.equal(secret.status, 400, '全是空密钥等于没有改动');
  const kept = await f.post({ 'llm.apiKey': '', 'chat.vision.maxImages': 5 });
  assert.equal(kept.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).llm.apiKey, 'keep-me');

  const unknown = await f.post({ 'chat.notARealField': 1 });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /不认识的配置项/);

  const badNumber = await f.post({ 'control.port': 99999 });
  assert.equal(badNumber.status, 400);

  const badJson = await f.post({ 'chat.whitelistGroups': '[1,2' });
  assert.equal(badJson.status, 400);
  assert.match((await badJson.json()).error, /不是合法的 JSON/);

  const csv = await f.post({ 'chat.quietHours': '23:00-08:00\n12:00-13:00' });
  assert.equal(csv.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).chat.quietHours, ['23:00-08:00', '12:00-13:00']);
});

test('daily news updates share strict validation and fail without partial writes', async (t) => {
  const f = await fixture(t);
  const valid = await f.post({
    'dailyNews.enabled': true, 'dailyNews.time': '10:00',
    'dailyNews.sourceTimes': { ai: '18:00' }, 'dailyNews.sources': ['ai'],
    'share.interests': ['科技'],
  });
  assert.equal(valid.status, 200);
  const before = fs.readFileSync(f.configPath, 'utf8');
  for (const updates of [
    { 'dailyNews.time': '25:00' },
    { 'dailyNews.timeZone': 'UTC' },
    { 'dailyNews.sourceTimes': { nope: '10:00' } },
    { 'dailyNews.sources': ['nope'] },
    { 'dailyNews.notBeforeDate': '2026-02-30' },
    { 'dailyNews.retryMinutes': 1.5 },
  ]) {
    const response = await f.post({ 'chat.draw.maxPerDay': 1, ...updates });
    assert.equal(response.status, 400, JSON.stringify(updates));
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
    assert.equal(f.server.cfg.chat.draw.maxPerDay, 6);
  }
  const fresh = await (await f.request('/api/config')).json();
  const fields = fresh.schema.flatMap((g) => g.fields);
  assert.deepEqual(fields.find((fl) => fl.path === 'share.interests').value, ['科技']);
});
