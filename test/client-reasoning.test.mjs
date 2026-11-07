import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped controls and existing save handlers with lightweight hooks.
// This is not a DOM/browser rendering test and makes no live model requests.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('    // Schema selects accept'), source.indexOf('    const KIND_LABEL'));
const ownershipHelpers = source.slice(source.indexOf('    function JsonValueEditor'), source.indexOf('    const 配置字段表'));
const configPanel = source.slice(source.indexOf('    const 配置字段表'), source.indexOf('    const 输入框'));
const section = source.slice(source.indexOf('    function Section()'), source.indexOf('    function apply(ctx)'));
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children || []).flatMap(nodes)];
}
function hooks() {
  const values = [], refs = []; let stateIndex = 0, refIndex = 0;
  return {
    reset() { stateIndex = refIndex = 0; },
    React: {
      useState(initial) {
        const i = stateIndex++;
        if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
        return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }];
      },
      useRef(initial) { const i = refIndex++; return refs[i] ||= { current: initial }; },
      useEffect() {}, useCallback: callback => callback, useId: () => 'synthetic-qq',
    },
  };
}
function fixture(extra = {}) {
  const hook = hooks();
  const posted = [];
  const style = new Proxy({}, { get: (_target, key) => ['btn', 'pill', 'stat', 'num'].includes(key) ? () => ({}) : {} });
  const context = {
    ...hook, h, S: style, T: {}, 输入框: {}, 输入: {}, 说明: {}, 行: {}, 标签: {}, 分组: {}, 组名: {},
    configWrite: { busy: false }, useLifetime: () => ({ live: { current: true }, later() {} }),
    get: async () => ({ ok: true }), post: async (route, body) => { posted.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { ok: true }; },
    ConfigPanel() {}, DailyNewsPanel() {}, SetupPanel() {}, ChatsPanel() {}, OpsPanel() {},
    开关() {}, 数字() {}, 文本() {}, tr: key => key, timeText: String, bytesText: String,
    ...extra,
  };
  const api = vm.runInNewContext(`${helpers}\n${ownershipHelpers}\n${configPanel}\n${section}\n({ selectOptions, ReasoningEffortFields, ConfigPanel, Section })`, context);
  return { ...api, hook, posted };
}

test('reasoning controls show persisted global and purpose selections with readable raw-value labels', () => {
  const { ReasoningEffortFields } = fixture();
  const changes = [];
  const tree = ReasoningEffortFields({ llm: { reasoningEffort: 'high', reasoningEfforts: { chat: 'low', agent: 'none', background: '' } }, onChange: (...args) => changes.push(args) });
  const selects = nodes(tree).filter(node => node.type === 'select');
  assert.deepEqual(selects.map(node => node.props.value), ['high', 'low', 'none', '']);
  const expected = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  for (const select of selects) {
    assert.deepEqual(select.children.map(option => option.props.value), expected);
    for (const option of select.children.slice(1)) assert.match(option.children[0], new RegExp(` · ${option.props.value}$`));
  }
  assert.match(selects[0].children[0].children[0], /不传参数/);
  assert.match(selects[3].children[0].children[0], /继承默认/);
  selects.forEach((select, i) => select.props.onChange({ target: { value: expected[i] } }));
  assert.deepEqual(changes, [
    ['llm.reasoningEffort', ''], ['llm.reasoningEfforts.chat', 'none'],
    ['llm.reasoningEfforts.agent', 'minimal'], ['llm.reasoningEfforts.background', 'low'],
  ]);
  const text = nodes(tree).flatMap(node => node.children).filter(value => typeof value === 'string').join(' ');
  assert.match(text, /不支持的模型或档位可能被接口拒绝/);
  assert.match(text, /更慢、费用更高/);
  assert.match(text, /蒸馏也一样/);
});

test('absent reasoning settings remain blank/inherited rather than defaulting to a paid effort', () => {
  const { ReasoningEffortFields } = fixture();
  const selects = nodes(ReasoningEffortFields({ onChange() {} })).filter(node => node.type === 'select');
  assert.deepEqual(selects.map(node => node.props.value), ['', '', '', '']);
});

test('generic schema select supports labelled option objects and legacy strings, then saves the raw value including empty', async () => {
  const f = fixture();
  const schema = [{ id: 'llm', title: '模型', fields: [
    { path: 'llm.reasoningEffort', label: '思考程度', type: 'select', value: 'high', options: [{ value: '', label: '跟随接口' }, 'none', { value: 'high', label: '高 · high' }] },
  ] }];
  const render = () => { f.hook.reset(); return f.ConfigPanel({ schema }); };
  let tree = render();
  let select = nodes(tree).find(node => node.type === 'select');
  assert.equal(select.props.value, 'high');
  assert.deepEqual(select.children.map(option => [option.props.value, option.children[0]]), [['', '跟随接口'], ['none', 'none'], ['high', '高 · high']]);
  select.props.onChange({ target: { value: '' } });
  tree = render();
  assert.equal(nodes(tree).find(node => node.type === 'select').props.value, '');
  const save = nodes(tree).find(node => node.type === 'button' && node.children.includes('保存并重启'));
  assert.equal(save.props.disabled, false);
  await save.props.onClick();
  assert.deepEqual(f.posted, [{ route: '/config', body: { updates: { 'llm.reasoningEffort': '' } } }]);
});

test('main settings controls use the existing draft and /config save path without touching unrelated settings', async () => {
  const baseline = { llm: { model: 'synthetic-model', reasoningEffort: 'medium', reasoningEfforts: { chat: '', agent: 'low', background: '' } }, agent: {}, chat: {}, share: {}, persona: {} };
  const f = fixture();
  // Seed only the same state/ref slots populated by a successful overview fetch.
  const originalState = f.hook.React.useState;
  let seededIndex = 0;
  f.hook.React.useState = initial => {
    const i = seededIndex++;
    return originalState(i === 0 ? { editable: baseline } : i === 5 ? JSON.parse(JSON.stringify(baseline)) : initial);
  };
  const originalRef = f.hook.React.useRef; let seededRef = 0;
  f.hook.React.useRef = initial => originalRef(seededRef++ === 3 ? JSON.parse(JSON.stringify(baseline)) : initial);
  const render = () => { seededIndex = seededRef = 0; f.hook.reset(); return f.Section(); };
  let tree = render();
  let fields = nodes(tree).find(node => node.type === f.ReasoningEffortFields);
  assert.ok(fields, 'main 模型 group mounts the reasoning controls');
  const controls = nodes(f.ReasoningEffortFields(fields.props)).filter(node => node.type === 'select');
  controls[0].props.onChange({ target: { value: '' } });
  controls[1].props.onChange({ target: { value: 'none' } });
  controls[3].props.onChange({ target: { value: 'minimal' } });
  tree = render();
  fields = nodes(tree).find(node => node.type === f.ReasoningEffortFields);
  assert.equal(fields.props.llm.reasoningEffort, '');
  assert.equal(fields.props.llm.reasoningEfforts.chat, 'none');
  const save = nodes(tree).find(node => node.type === 'button' && node.children.includes('保存并重启机器人'));
  assert.ok(save, 'existing main-settings save button');
  await save.props.onClick();
  assert.deepEqual(f.posted, [{ route: '/config', body: { updates: {
    'llm.reasoningEffort': '', 'llm.reasoningEfforts.chat': 'none', 'llm.reasoningEfforts.background': 'minimal',
  } } }]);
});
