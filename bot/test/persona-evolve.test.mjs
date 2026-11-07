import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonaEvolver } from '../src/persona-evolve.mjs';

const log = { info() {}, warn() {}, debug() {} };

function harness(t, persona, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-evolve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let current = JSON.parse(JSON.stringify(persona));
  const evolver = new PersonaEvolver({
    dataDir: dir,
    brain: { complete: async () => raw },
    getPersona: () => current,
    setPersona: (p) => { current = p; },
    log,
    minGapMs: 24 * 3600_000,
  });
  return { dir, evolver, get: () => current };
}

test('PersonaEvolver：追加说话风格和行为规矩，撤销只拿走自己加的那段', async (t) => {
  const h = harness(t, { name: '小雪花', style: '说话短', rules: ['不装'] },
    '{"styleAdd":"偶尔自嘲一句","rule":"被夸时先嘴硬一下","reason":"群里吃这套"}');
  const r = await h.evolver.maybeEvolve({ notes: [{ text: '群友喜欢自嘲' }] });
  assert.equal(r.ok, true);
  assert.equal(h.get().style, '说话短；偶尔自嘲一句');
  assert.deepEqual(h.get().rules, ['不装', '被夸时先嘴硬一下']);
  assert.equal(h.evolver.status().count, 1);

  const undo = h.evolver.undo(r.id);
  assert.equal(undo.ok, true);
  assert.equal(h.get().style, '说话短');
  assert.deepEqual(h.get().rules, ['不装']);
  assert.equal(h.evolver.status().count, 0);
});

test('PersonaEvolver：有完整 systemPrompt 时追加到末尾的小节，不覆盖原文', async (t) => {
  const h = harness(t, { name: '小雪花', identity: '群友', systemPrompt: '你是小雪花，说话简短。' },
    '{"styleAdd":"遇到不懂的先问一句","reason":"别装懂"}');
  const r = await h.evolver.maybeEvolve({ notes: ['装懂会翻车'] });
  assert.equal(r.ok, true);
  assert.ok(h.get().systemPrompt.startsWith('你是小雪花，说话简短。'));
  assert.match(h.get().systemPrompt, /【自己后来悟到的】/);
  assert.match(h.get().systemPrompt, /遇到不懂的先问一句/);
  assert.equal(h.evolver.undo(r.id).ok, true);
  assert.equal(h.get().systemPrompt, '你是小雪花，说话简短。');
});

test('PersonaEvolver：24 小时内不重复改；敏感内容拒绝', async (t) => {
  const h = harness(t, { name: '小雪花', style: '' }, '{"styleAdd":"多说人话"}');
  await h.evolver.maybeEvolve({ notes: ['笔记'] });
  const again = await h.evolver.maybeEvolve({ notes: ['笔记'] });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'gap');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-evolve-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let p = { name: '小雪花', style: '' };
  const bad = new PersonaEvolver({
    dataDir: dir,
    brain: { complete: async () => '{"styleAdd":"聊点赌博色情"}' },
    getPersona: () => p,
    setPersona: (next) => { p = next; },
    log,
  });
  const r = await bad.maybeEvolve({ notes: ['乱七八糟'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nothing');
});
