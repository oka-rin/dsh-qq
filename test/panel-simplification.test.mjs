import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CONFIG_SCHEMA } from '../bot/src/schema.mjs';

// Run only isolated client render/helpers. No browser, network, QQ action or restart.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const ownership = source.slice(source.indexOf('    function JsonValueEditor'), source.indexOf('    const 配置字段表'));
const section = source.slice(source.indexOf('    function Section()'), source.indexOf('    function apply(ctx)'));
const news = source.slice(source.indexOf('    function DailyNewsPanel('), source.indexOf('    // 「全部配置」'));
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children || []).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => node.children).filter(value => typeof value === 'string').join(' ');
const plain = value => JSON.parse(JSON.stringify(value));
const baseline = {
  agent: { targets: ['group:999', 'private:888'] }, llm: {}, chat: {},
  share: { sources: ['custom-source'], interests: ['comma,inside'] },
  persona: { likes: ['custom、value'] },
  dailyNews: { sources: ['custom-news'], sourceTimes: { 'custom-news': '17:23' }, time: '10:00', timeZone: 'Asia/Shanghai', sourceGapMs: 123 },
};
function fixture({ sectionState = false } = {}) {
  const states = [], refs = [], posted = [];
  let stateIndex = 0, refIndex = 0;
  const style = new Proxy({}, { get: (_target, key) => ['btn', 'pill', 'stat', 'num', 'chip'].includes(key) ? () => ({}) : {} });
  const context = {
    h, S: style, T: {}, 输入框: {}, 输入: {}, 说明: {}, 行: {}, 标签: {}, 分组: {}, 组名: {},
    React: {
      Fragment: Symbol('Fragment'),
      useState(initial) {
        const i = stateIndex++;
        if (!(i in states)) states[i] = sectionState && i === 0 ? { editable: plain(baseline), configSchema: CONFIG_SCHEMA }
          : sectionState && i === 5 ? plain(baseline) : typeof initial === 'function' ? initial() : initial;
        return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
      },
      useRef(initial) { const i = refIndex++; return refs[i] ||= { current: sectionState && i === 3 ? plain(baseline) : initial }; },
      useEffect() {}, useCallback: callback => callback, useId: () => 'qq-simplification',
    },
    configWrite: { busy: false }, useLifetime: () => ({ live: { current: true }, later() {} }),
    get: async () => ({ ok: true }), post: async (route, body) => { posted.push({ route, body: plain(body) }); return { ok: true }; },
    ConfigPanel() {}, ReasoningEffortFields() {}, SetupPanel() {}, ChatsPanel() {}, OpsPanel() {},
    开关: (value, onChange, label) => h('switch', { value, onChange, label }),
    数字: (value, onChange, options) => h('number', { value, onChange, ...options }),
    文本: (value, onChange, options) => h('text', { value, onChange, ...options }),
    tr: key => key, timeText: String, bytesText: String,
    NEWS_CATALOG: [['known-news', 'Known news', '10:00']],
    newsTime: (cfg, id, fallback) => cfg.sourceTimes?.[id] || cfg.time || fallback,
    newsRecordTime: String, newsName: String, NEWS_STATUS: {},
  };
  const api = vm.runInNewContext(`${ownership}\n${news}\n${section}\n({ JsonValueEditor, 常用配置路径, 高级配置组, DailyNewsPanel, Section })`, context);
  return { ...api, states, posted, render(fn = api.Section) { stateIndex = refIndex = 0; return fn(); } };
}

test('every schema path has exactly one common or advanced owner without changing backend schema', () => {
  const f = fixture();
  const original = plain(CONFIG_SCHEMA);
  const advanced = f.高级配置组(CONFIG_SCHEMA);
  const advancedPaths = advanced.flatMap(group => group.fields.map(field => field.path));
  assert.equal(new Set(advancedPaths).size, advancedPaths.length);
  const allPaths = CONFIG_SCHEMA.flatMap(group => group.fields.map(field => field.path));
  for (const path of allPaths) {
    assert.equal(Number(f.常用配置路径.has(path)) + advancedPaths.filter(candidate => candidate === path).length, 1, path);
  }
  for (const path of f.常用配置路径) assert.ok(allPaths.includes(path), `stale common owner: ${path}`);
  assert.ok(advanced.every(group => group.fields.length), 'omit empty group tabs');
  assert.deepEqual(CONFIG_SCHEMA, original, 'filtering does not mutate schema groups or fields');
});

test('advanced filtering retains every secret and unknown future fields even inside common groups', () => {
  const f = fixture();
  const secretPaths = CONFIG_SCHEMA.flatMap(group => group.fields.filter(field => field.type === 'secret').map(field => field.path));
  const advancedPaths = f.高级配置组(CONFIG_SCHEMA).flatMap(group => group.fields.map(field => field.path));
  for (const path of secretPaths) assert.ok(advancedPaths.includes(path), `secret remains editable: ${path}`);
  const future = [
    { id: 'agent', fields: [{ path: 'agent.enabled', type: 'bool' }, { path: 'agent.futureLimit', type: 'number' }] },
    { id: 'daily-news', fields: [{ path: 'dailyNews.futureExtras', type: 'json' }] },
    { id: 'future', fields: [{ path: 'future.credential', type: 'secret' }] },
  ];
  assert.deepEqual(plain(f.高级配置组(future)).flatMap(group => group.fields.map(field => field.path)), ['agent.futureLimit', 'dailyNews.futureExtras', 'future.credential']);
  assert.deepEqual(plain(f.高级配置组(undefined)), []);
});

test('common cards retain full JSON extras editors for scopes, sources, interests and persona lists', () => {
  const f = fixture({ sectionState: true });
  const tree = f.render();
  const editors = nodes(tree).filter(node => node.type === f.JsonValueEditor);
  for (const [path, value] of [
    ['agent.targets', baseline.agent.targets], ['share.sources', baseline.share.sources],
    ['share.interests', baseline.share.interests], ['persona.likes', baseline.persona.likes],
  ]) {
    const editor = editors.find(node => JSON.stringify(node.props.value) === JSON.stringify(value));
    assert.ok(editor, `dedicated raw editor: ${path}`);
    assert.equal(typeof editor.props.onChange, 'function', path);
    assert.ok(f.常用配置路径.has(path));
  }
  const newsNode = nodes(tree).find(node => node.type === f.DailyNewsPanel);
  assert.ok(newsNode, 'news remains mounted with the shared common draft');
  const newsTree = f.DailyNewsPanel(newsNode.props);
  const newsEditors = nodes(newsTree).filter(node => node.type === f.JsonValueEditor);
  for (const [path, value] of [['dailyNews.sources', baseline.dailyNews.sources], ['dailyNews.sourceTimes', baseline.dailyNews.sourceTimes]]) {
    assert.ok(newsEditors.find(node => JSON.stringify(node.props.value) === JSON.stringify(value)), `dedicated raw editor: ${path}`);
  }
});

test('common and news settings have one shared save button; advanced settings start collapsed', () => {
  const f = fixture({ sectionState: true });
  let tree = f.render();
  const editor = nodes(tree).find(node => node.type === f.JsonValueEditor);
  editor.props.onChange(['offline-custom-entry']);
  tree = f.render();
  const newsNode = nodes(tree).find(node => node.type === f.DailyNewsPanel);
  const commonButtons = [...nodes(tree), ...nodes(f.DailyNewsPanel(newsNode.props))].filter(node => node.type === 'button' && /保存.*重启/.test(text(node)));
  assert.equal(commonButtons.length, 1, 'one common+news save button, not one on each card');
  assert.equal(commonButtons[0].props.disabled, false);
  const advancedDetails = nodes(tree).find(node => node.type === 'details' && node.children.some(child => child?.type === 'summary' && /高级设置/.test(text(child))));
  assert.ok(advancedDetails, 'advanced settings have a disclosure');
  assert.notEqual(advancedDetails.props.open, true, 'advanced disclosure defaults closed');
  const configPanel = nodes(advancedDetails).find(node => typeof node.type === 'function');
  assert.ok(configPanel, 'schema editor remains reachable inside advanced disclosure');
  const renderedPaths = configPanel.props.schema.flatMap(group => group.fields.map(field => field.path));
  assert.ok(renderedPaths.every(path => !f.常用配置路径.has(path)));
});

test('raw extras feed the shared draft and save exactly their changed paths', async () => {
  const f = fixture({ sectionState: true });
  let tree = f.render();
  const targets = nodes(tree).find(node => node.type === f.JsonValueEditor && JSON.stringify(node.props.value) === JSON.stringify(baseline.agent.targets));
  assert.ok(targets);
  targets.props.onChange(['group:123456789', 'private:987654321']);
  const newsNode = nodes(tree).find(node => node.type === f.DailyNewsPanel);
  const times = nodes(f.DailyNewsPanel(newsNode.props)).find(node => node.type === f.JsonValueEditor && JSON.stringify(node.props.value) === JSON.stringify(baseline.dailyNews.sourceTimes));
  assert.ok(times);
  // Remove an existing mapping too: a leaf-only object diff silently resurrects it.
  times.props.onChange({ 'future-news': '22:01' });
  tree = f.render();
  await nodes(tree).find(node => node.type === 'button' && node.children.includes('保存并重启机器人')).props.onClick();
  assert.deepEqual(f.posted, [{ route: '/config', body: { updates: {
    'agent.targets': ['group:123456789', 'private:987654321'], 'dailyNews.sourceTimes': { 'future-news': '22:01' },
  } } }]);
});

test('raw JSON editor accepts arbitrary extras and rejects malformed or wrongly typed values without applying them', () => {
  for (const [value, next] of [
    [['old'], ['group:999999', 'private:888888', 'custom,source、name']],
    [{ known: '10:00' }, { known: '10:00', 'future-source': '17:23' }],
  ]) {
    const f = fixture(); const changes = [];
    const render = () => f.render(() => f.JsonValueEditor({ value, label: 'JSON extras', onChange: result => changes.push(plain(result)) }));
    let tree = render();
    nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: JSON.stringify(next) } });
    assert.deepEqual(changes, [next]);
    for (const invalid of ['{', 'null', '123', Array.isArray(value) ? '[1]' : '{"extra":1}']) {
      tree = render();
      nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: invalid } });
      tree = render();
      assert.ok(nodes(tree).some(node => node.props.role === 'alert'));
      assert.deepEqual(changes, [next], `invalid ${invalid} never applied`);
    }
  }
});
