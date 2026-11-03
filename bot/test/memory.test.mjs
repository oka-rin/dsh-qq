import test from 'node:test';
import assert from 'node:assert/strict';


test('私聊记忆的提示词说「私聊」，不说「群里」', async () => {
  const { ScopeMemory } = await import('../src/memory.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const prompts = [];
  const brain = {
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      return '总述：聊手机\n- 他关心旗舰机拍照';
    },
  };
  const mem = new ScopeMemory({ dataDir: dir, brain });
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'history', 'private_10000001.jsonl'), JSON.stringify({ ts: Date.now(), role: 'user', name: '测试用户甲', text: '这手机镜头凸起好丑' }) + '\n');
  await mem.refresh('private:10000001', { force: true });
  assert.ok(prompts.length >= 1);
  assert.match(prompts[0], /一对一私聊/);
  assert.ok(!/这个群里/.test(prompts[0]), '私聊不能写成群里');
  fs.rmSync(dir, { recursive: true, force: true });
});
