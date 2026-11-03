import test from 'node:test';
import assert from 'node:assert/strict';


test('头像用群里此刻的名字，旧昵称作为别名；久未更新的画像会标注可能过时', async () => {
  const { PeopleBook } = await import('../src/people.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
  const pb = new PeopleBook({ dataDir: dir });
  pb.note({ uin: '1', name: '老昵称', text: '你好', at: Date.now() - 1000 });
  const file = path.join(dir, 'people', '1.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.names = ['老昵称', '新昵称'];
  data.summary = '一个喜欢打游戏的群友';
  data.learnedAt = Date.now() - 4 * 86400000;
  fs.writeFileSync(file, JSON.stringify(data));
  const fresh = new PeopleBook({ dataDir: dir }); // 磁盘改过，换实例避开缓存
  const out = fresh.render('1', { preferName: '新昵称', maxFacts: 1 });
  assert.match(out, /^新昵称（也叫 老昵称）/);
  assert.match(out, /可能已经变了/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('名册把所有人都列出来（人多了也不漏），在场的人可以排除', async () => {
  const { PeopleBook } = await import('../src/people.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
  const pb = new PeopleBook({ dataDir: dir });
  for (let i = 1; i <= 12; i += 1) {
    pb.note({ uin: String(1000 + i), name: `群友${i}`, text: '在的', at: Date.now() - i * 60000 });
  }
  const roster = pb.renderRoster({});
  assert.equal(roster.total, 12);
  for (let i = 1; i <= 12; i += 1) assert.match(roster.text, new RegExp(`群友${i}`));
  const only = pb.renderRoster({ exclude: ['1001'] });
  assert.equal(only.total, 11);
  assert.doesNotMatch(only.text, /群友1（/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('事实不再只留 10 条：旧事实不丢，被更新的也不会被一次覆盖掉', async () => {
  const { PeopleBook } = await import('../src/people.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
  const pb = new PeopleBook({ dataDir: dir });
  const old = ['养了只布偶猫', '在准备考研', '喜欢半夜打游戏', '刚换了显卡', '常用A卡', '讨厌加班', '住成都',
    '会写前端', '在学日语', '养了乌龟', '喜欢吃辣', '刚买了相机', '爱看番', '骑摩托上班', '周末爬山'];
  const merged = PeopleBook.mergeFacts(['新事实：在准备考研'], old);
  assert.equal(merged.length, 15);
  assert.equal(merged[0], '新事实：在准备考研');
  assert.equal(PeopleBook.mergeFacts(['养了只布偶猫'], ['养了布偶猫']).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('按当下这句话挑相关事实、按名字捞不在场的老熟人', async () => {
  const { PeopleBook } = await import('../src/people.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
  const pb = new PeopleBook({ dataDir: dir });
  pb.note({ uin: '7', name: '老王', text: '显卡到了', at: Date.now() });
  const file = path.join(dir, 'people', '7.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.summary = '一个折腾电脑的群友';
  data.facts = ['刚换了显卡，正在跑分', '养了只柴犬', '最近在减肥'];
  fs.writeFileSync(file, JSON.stringify(data));
  const fresh = new PeopleBook({ dataDir: dir });
  const out = fresh.render('7', { context: '显卡跑分多少', maxFacts: 1 });
  assert.match(out, /跑到|显卡/);
  assert.equal(PeopleBook.rankFacts(['养了只柴犬', '刚换了显卡'], '显卡')[0], '刚换了显卡');
  assert.deepEqual(fresh.findByName('老王最近咋样').map((x) => x.uin), ['7']);
  assert.deepEqual(fresh.findByName('老王最近咋样', { exclude: ['7'] }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('composeFor 三段齐全：名册（排除在场）+ 在场详细 + 话里提到的老熟人', async () => {
  const { PeopleBook } = await import('../src/people.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
  const pb = new PeopleBook({ dataDir: dir });
  const seed = (uin, name, summary, facts) => {
    pb.note({ uin, name, text: '在的', at: Date.now() });
    const file = path.join(dir, 'people', `${uin}.json`);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    d.summary = summary;
    d.facts = facts;
    fs.writeFileSync(file, JSON.stringify(d));
  };
  seed('11', '在场甲', '一个折腾显卡的群友', ['刚换了显卡在跑分']);
  seed('22', '在场乙', '一个爱看番的群友', ['在追新番']);
  seed('33', '老王', '一个养狗的老群友', ['养了只柴犬', '住成都']);
  const fresh = new PeopleBook({ dataDir: dir });
  const text = fresh.composeFor({
    present: ['11', '22'],
    nameOf: new Map([['11', '在场甲'], ['22', '在场乙']]),
    said: '老王那条柴犬咋样了',
    recent: '显卡又涨价了',
  });
  assert.match(text, /【名册·你认识的所有人】/);
  assert.match(text, /老王（QQ 33）/); // 名册里有不在场的人
  assert.doesNotMatch(text, /【名册·你认识的所有人】[\s\S]*在场甲（QQ 11）[\s\S]*【现在就这几个人/); // 在场的不重复占名册
  assert.match(text, /【现在就这几个人在说话】/);
  assert.match(text, /在场甲（QQ 11）/);
  assert.match(text, /【这话里提到的、不在场的人】/);
  assert.match(text, /养了只柴犬/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('事实一条都不丢：已有 60 条时再学一次，旧的全都留着（不截断）', async () => {
  const { PeopleBook } = await import('../src/people.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
  const pb = new PeopleBook({ dataDir: dir, minGapMs: 0 });
  for (let i = 0; i < 4; i += 1) pb.note({ uin: '9', name: '甲', text: `第${i}句`, at: Date.now() - i * 1000 });
  // 先塞 60 条已有的记忆点（note 是每 5 条落盘一次，第 5 条会触发写盘）
  const file = path.join(dir, 'people', '9.json');
  const live = pb.read('9');
  live.facts = Array.from({ length: 60 }, (_, i) => `记忆点${i.toString(36)}${(i * 7919).toString(36)}`);
  live.summary = '一个测试群友';
  pb.note({ uin: '9', name: '甲', text: '触发落盘', at: Date.now() });
  const fresh = new PeopleBook({ dataDir: dir, minGapMs: 0 });
  fresh.brain = { complete: async () => '总述：一个测试群友\n- 新学到的第 61 条' };
  const r = await fresh.learn('9', { force: true });
  assert.equal(r.ok, true);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(data.facts.length >= 60, `旧的 60 条应全部保留，实际 ${data.facts.length}`);
  assert.equal(data.facts[0], '新学到的第 61 条'); // 新的在前
  assert.match(fresh.renderFull('9', { maxFacts: 100 }), /记下的事共 \d{2} 条/);
  assert.ok(data.notes.length >= 1); // 每次学习的快照也留档
  fs.rmSync(dir, { recursive: true, force: true });
});

test('查档案：按名字 / QQ 号 / 关键词都能翻出来，命中事实排最前', async () => {
  const { PeopleBook } = await import('../src/people.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
  const pb = new PeopleBook({ dataDir: dir });
  const seed = (uin, name, summary, facts) => {
    pb.note({ uin, name, text: '在的', at: Date.now() });
    const file = path.join(dir, 'people', `${uin}.json`);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    d.summary = summary;
    d.facts = facts;
    fs.writeFileSync(file, JSON.stringify(d));
  };
  seed('33', '老王', '一个养狗的老群友', ['养了只柴犬', '在准备考研', '住成都']);
  seed('44', '小李', '一个刚毕业的群友', ['在找工作', '喜欢打游戏']);
  const fresh = new PeopleBook({ dataDir: dir });
  assert.deepEqual(fresh.lookup('老王').map((x) => x.uin), ['33']);
  assert.deepEqual(fresh.lookup('44').map((x) => x.uin), ['44']);
  const byFact = fresh.lookup('考研');
  assert.deepEqual(byFact.map((x) => x.uin), ['33']);
  assert.match(byFact[0].facts[0], /考研/); // 命中事实排在第一
  assert.match(fresh.renderFull('33', { maxFacts: 1 }), /记下的事共 3 条/);
  assert.deepEqual(fresh.lookup('没有这个人啊'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
