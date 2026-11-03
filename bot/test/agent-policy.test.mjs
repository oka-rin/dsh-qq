import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agent.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proact-'));
const histDir = path.join(tmp, 'history');
fs.mkdirSync(histDir, { recursive: true });
const now = Date.now();
const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } };
const skipBrain = {
  chatWithTools: async () => ({ tool_calls: [{ id: 'c1', function: { name: 'skip', arguments: '{}' } }] }),
  complete: async () => '兜底一句话，随便说说。',
};
const sendBrain = {
  chatWithTools: async () => ({ tool_calls: [{ id: 'c2', function: { name: 'send_message', arguments: JSON.stringify({ text: '我说一句' }) } }] }),
  complete: async () => '兜底一句话。',
};

function mk({ rows, brain, cfg = {}, logLines = [] }) {
  fs.writeFileSync(path.join(histDir, 'agent-log.jsonl'), logLines.map((o) => JSON.stringify(o)).join('\n') + (logLines.length ? '\n' : ''));
  const sent = [];
  const bot = {
    groups: new Map(),
    recent: (scope, limit = 20) => (rows[scope] || []).slice(-limit),
    send: async (scope, text) => { sent.push({ scope, text }); return 9000 + sent.length; },
  };
  const a = new AgentLoop({
    config: {
      storage: { dataDir: tmp },
      agent: { enabled: true, targets: Object.keys(rows), minPerDay: 4, maxPerDay: 16, minGapMs: 0,
        shareEveryHours: 4, qzoneEveryHours: 20, selfHoldMs: 600000, quietHours: [], contextChars: 6000, ...cfg },
      llm: {}, chat: {},
    },
    bot, brain, log,
  });
  return { a, sent };
}

// S1 上一条是我说的（只有 ts，1 分钟前）→ working-for-reply，不许切 share
{
  const g = 'group:111';
  const { a, sent } = mk({ rows: { [g]: [
    { role: 'user', name: 'A', text: '在吗', ts: now - 5 * 60_000 },
    { role: 'bot', name: '我', text: '在的', ts: now - 60_000 },
  ] }, brain: sendBrain });
  const out = await a.act(g, { force: false });
  console.log('S1', out.reason || 'ACTED', '| sends', sent.length);
}

// S2 我说完 3h 没人接、分享/说说都刚做过 → 不开旧话头，改成「开新话题」
{
  const g = 'group:222';
  const seen = [];
  const brain = {
    chatWithTools: async ({ messages }) => {
      seen.push(messages[1].content);
      return { tool_calls: [{ id: 'c2', function: { name: 'send_message', arguments: JSON.stringify({ text: '新话题一句' }) } }] };
    },
    complete: async () => '兜底一句话。',
  };
  const { a, sent } = mk({
    rows: { [g]: [
      { role: 'user', name: 'A', text: '早', ts: now - 4 * 3600_000 },
      { role: 'bot', name: '我', text: '早啊', ts: now - 3 * 3600_000 },
    ] },
    brain,
    logLines: [
      { at: now - 30 * 60_000, scope: g, kind: 'share', tool: 'send_message', ok: true },
      { at: now - 60 * 60_000, scope: g, kind: 'qzone', tool: 'post_qzone', ok: true },
    ],
  });
  const out = await a.act(g, { force: false });
  const brief = seen[0] || '';
  console.log('S2 没人接 → 任务', /开一个新话题/.test(brief) ? 'topic' : '未切话题', '| sends', sent.length, '| 早啊还在上下文里', /早啊/.test(brief));
}

// S3 群额度满 → 改挑还有额度的私聊
{
  const g = 'group:333'; const p = 'private:555';
  const lines = [];
  for (let i = 0; i < 16; i += 1) lines.push({ at: now - (i + 1) * 60_000, scope: g, kind: 'speak', tool: 'send_message', ok: true });
  const { a, sent } = mk({
    rows: {
      [g]: [{ role: 'user', name: 'A', text: '聊得热闹', ts: now - 60_000 }, { role: 'user', name: 'B', text: '+1', ts: now - 30_000 }],
      [p]: [{ role: 'user', name: 'C', text: '你好', ts: now - 30 * 60_000 }],
    },
    brain: sendBrain,
    cfg: { private: { maxPerDay: 8, minPerDay: 4, minGapMs: 0 } },
    logLines: lines,
  });
  const out = await a.tick({ force: false });
  console.log('S3', out.ok ? 'ACTED' : out.reason, '| 发到', sent.map((s) => s.scope).join(',') || '无');
}

// S4 skip + 没到下限 + 最近没人说话 → 兜底改成起新话头（仍然发出去）
{
  const g = 'group:444';
  const prompts = [];
  const brain = {
    chatWithTools: async () => ({ tool_calls: [{ id: 'c1', function: { name: 'skip', arguments: '{}' } }] }),
    complete: async ({ prompt }) => { prompts.push(prompt); return '新话头：最近在玩的那个肉鸽又开始逼我氪了。'; },
  };
  const { a, sent } = mk({ rows: { [g]: [{ role: 'user', name: 'A', text: '三小时前', ts: now - 3 * 3600_000 }] }, brain });
  const out = await a.act(g, { force: false });
  console.log('S4 skip+没人说话 → sends', sent.length, '| 兜底是起新话头', /新话头|安静/.test(prompts[0] || ''));
}

// S5 skip + 没到下限 + 10 分钟前有人说话 → 兜底接话，且日志记 speak
{
  const g = 'group:666';
  const { a, sent } = mk({ rows: { [g]: [{ role: 'user', name: 'A', text: '刚说的话', ts: now - 10 * 60_000 }] }, brain: skipBrain });
  const out = await a.act(g, { force: false });
  const rows = fs.readFileSync(path.join(histDir, 'agent-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  console.log('S5 sends', sent.length, '| kinds', rows.map((r) => r.kind).join(','), '| said.source', out.said?.source);
}
