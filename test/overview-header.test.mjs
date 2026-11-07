import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const ownershipHelpers = source.slice(source.indexOf('    function JsonValueEditor'), source.indexOf('    const 配置字段表'));
const section = source.slice(source.indexOf('    function Section()'), source.indexOf('    function apply(ctx)'));
const pure = section.slice(section.indexOf('      function overviewHealth'), section.indexOf('      const { live, later }'));
const { overviewHealth, overviewReasoning } = vm.runInNewContext(`${pure}\n({overviewHealth, overviewReasoning})`);
const healthy = { now: 1000, groups: [], freshness: Object.fromEntries(['status', 'identity', 'groups', 'config'].map(name => [name, { ok: true, checkedAt: 1000, updatedAt: 1000, error: '' }])), control: { reachable: true }, status: { ok: true, selfId: '123', nickname: '账号名', model: 'runtime-chat', persona: '人设名', transport: { http: 'ok', ws: 'open' } }, editable: { llm: { model: 'configured-other', reasoningEffort: 'high', reasoningEfforts: { chat: '' } }, agent: { targets: ['group:1'] }, chat: {}, persona: {} } };
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children || []).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(n => n.children).filter(x => typeof x === 'string').join(' ');
function fixture() {
  let states = [], refs = [], stateIndex = 0, refIndex = 0;
  const later = [], callbacks = [], changes = [];
  const style = new Proxy({}, { get: (_t, key) => ['btn', 'pill', 'stat', 'num'].includes(key) ? state => ({ tone: state }) : {} });
  const context = { h, S: style, T: {}, 输入框: {}, 说明: {}, 行: {}, 标签: {}, 分组: {}, 组名: {},
    configWrite: { busy: false }, useLifetime: () => ({ live: { current: true }, later: fn => later.push(fn) }),
    React: { useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = i === 0 ? structuredClone(healthy) : i === 5 ? structuredClone(healthy.editable) : typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; }, useRef(initial) { return refs[refIndex++] ||= { current: initial }; }, useEffect() {}, useCallback(fn) { callbacks.push(fn); return fn; }, useId: () => 'qq-test' },
    get: async () => structuredClone(healthy), post: async (_p, body) => { changes.push(body); return { ok: true }; },
    ConfigPanel() {}, ReasoningEffortFields() {}, DailyNewsPanel() {}, SetupPanel() {}, ChatsPanel() {}, OpsPanel() {},
    开关() {}, 数字() {}, 文本() {}, tr: key => key, timeText: String, bytesText: String,
  };
  const Section = vm.runInNewContext(`${ownershipHelpers}\n${section}\nSection`, context);
  const render = () => { stateIndex = refIndex = 0; callbacks.length = 0; return Section(); };
  return { context, render, later, callbacks, changes, states, refs };
}
test('transport health distinguishes confirmed online, offline, degraded and missing/failed unknown', () => {
  assert.equal(overviewHealth(healthy).state, 'online');
  assert.equal(overviewHealth({}).state, 'unknown');
  assert.equal(overviewHealth({ control: { reachable: true }, status: {} }).state, 'unknown');
  assert.equal(overviewHealth({ ...healthy, control: { reachable: false } }).state, 'offline');
  assert.equal(overviewHealth(healthy, 'failed').state, 'unknown');
  for (const [http, ws, state] of [['ok', 'closed', 'degraded'], ['error', 'open', 'degraded'], ['error', 'closed', 'offline'], ['ok', 'connecting', 'degraded'], ['ok', undefined, 'unknown']]) {
    assert.equal(overviewHealth({ ...healthy, status: { transport: { http, ws } } }).state, state);
  }
});
test('effective chat effort inherits global but blank never means none', () => {
  assert.equal(overviewReasoning(undefined), '未知');
  assert.equal(overviewReasoning({}), '接口默认');
  assert.equal(overviewReasoning(healthy.editable.llm), '高 · high');
  assert.equal(overviewReasoning({ reasoningEffort: 'high', reasoningEfforts: { chat: 'none' } }), '关闭 · none');
});
test('header shows runtime model, nickname vs persona, effort, transport and timestamp; buttons target existing sections', () => {
  const f = fixture(); let tree = f.render();
  assert.match(text(tree), /聊天模型 runtime-chat/);
  assert.match(text(tree), /QQ昵称 账号名/);
  assert.match(text(tree), /人设 人设名/);
  assert.match(text(tree), /聊天推理 高 · high/);
  assert.match(text(tree), /HTTP ok · WS open/);
  assert.match(text(tree), /上次读取 .*每15秒刷新/);
  for (const [label, heading] of [['聊天模型 runtime-chat', '模型'], ['聊天推理 高 · high', '模型'], ['人设 人设名', '人设'], ['主动目标 1 处', '安全与活动范围'], ['群 0', '群']]) {
    const button = nodes(tree).find(n => n.type === 'button' && n.children.includes(label));
    assert.ok(button, label);
    button.props.onClick(); tree = f.render();
    const target = nodes(tree).find(n => n.props.ref && n.children.includes(heading));
    let scrolled = false, focused = false;
    target.props.ref({ scrollIntoView() { scrolled = true; }, focus() { focused = true; } });
    f.later.shift()(); assert.ok(scrolled); assert.ok(focused);
    if (heading !== '群') assert.equal(nodes(tree).find(n => n.props.role === 'tab' && n.children.includes('settings')).props['aria-selected'], true);
  }
  assert.equal(f.changes.length, 0, 'navigation never saves or changes config');
});
test('refresh shows progress, catches failures and removes stale green status without discarding draft', async () => {
  const f = fixture(); let tree = f.render();
  const baselineDraft = f.states[5];
  let finish;
  f.context.get = () => new Promise(resolve => { finish = resolve; });
  const refresh = nodes(tree).find(n => n.type === 'button' && n.children.includes('刷新'));
  const pending = refresh.props.onClick(); tree = f.render();
  assert.ok(nodes(tree).find(n => n.type === 'button' && n.children.includes('刷新中…')).props.disabled);
  finish({ ok: false, error: 'network down' }); await pending; tree = f.render();
  assert.match(text(tree), /刷新失败 · 状态未确认/);
  assert.match(text(tree), /读取失败，以下为上次数据/);
  assert.equal(nodes(tree).filter(n => n.props.role === 'status' && n.props.style?.tone === 'ok').length, 0);
  assert.equal(f.states[5], baselineDraft);
  f.context.get = async () => { throw Error('thrown failure'); };
  await nodes(tree).find(n => n.type === 'button' && n.children.includes('刷新')).props.onClick();
  tree = f.render(); assert.match(text(tree), /thrown failure/);
});
test('partial child-source failure stays visibly stale and successful refresh retains dirty draft', async () => {
  const f = fixture(); let tree = f.render();
  const draft = f.states[5]; draft.persona.name = 'unsaved';
  f.refs[4].current = true; // 脏Ref follows scope/overview/action/baseline refs.
  const partial = { ...structuredClone(healthy), ok: true };
  partial.freshness.identity = { ok: false, updatedAt: 1000, checkedAt: 2000, error: 'profile unavailable' };
  partial.freshness.groups = { ok: false, updatedAt: null, checkedAt: 2000, error: 'list unavailable' };
  partial.groups = null;
  let called;
  f.context.get = async path => { called = path; return partial; };
  await nodes(tree).find(n => n.type === 'button' && n.children.includes('刷新')).props.onClick();
  tree = f.render();
  assert.match(called, /refresh=1/);
  assert.match(text(tree), /QQ昵称 账号名 · 123 · 旧值/);
  assert.match(text(tree), /群 未知 · 未知/);
  assert.match(text(tree), /部分数据刷新失败/);
  assert.match(text(tree), /profile unavailable/);
  assert.match(text(tree), /QQ 在线/);
  assert.equal(f.states[5], draft);
  assert.equal(f.states[5].persona.name, 'unsaved');
});
