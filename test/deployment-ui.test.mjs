import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the shipped pure status/body/session helpers. No React/DOM mock,
// renderer, host operation, Docker installation or user consent is simulated.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('    function deploymentText('), source.indexOf('    function DeploymentPanel('));
const { deploymentText, deploymentTask, deploymentStatus, deploymentActionHint, deploymentBody, createDeploymentSession } = vm.runInNewContext(
  `${helpers}\n({ deploymentText, deploymentTask, deploymentStatus, deploymentActionHint, deploymentBody, createDeploymentSession })`,
  { tr: key => key, AbortController, setTimeout, clearTimeout });
const task = state => ({ id: 'task-1', state, stage: 'pull', message: 'Pulling image', elapsedMs: 3210, steps: [{ stage: 'inspect', message: 'Checked named container', at: 'now' }] });
const status = (overrides = {}) => ({ ok: true, host: { platform: 'linux', arch: 'x64' },
  docker: { installed: true, ready: true, canInstall: true, state: 'ready' }, task: null,
  defaults: { image: 'official/image:latest', container: 'configured', publicDesktop: false },
  selected: { backend: 'snowluma', mode: 'native', container: 'configured' }, warnings: [], ...overrides });
const consent = { authorized: true, injectionRisk: true };
const plain = value => JSON.parse(JSON.stringify(value));
function fixture({ initial = status(), confirm = true, get, post } = {}) {
  let latest = {}, nextTimer = 0;
  const timers = new Map(), calls = [], updates = [];
  const api = createDeploymentSession({
    getStatus: async signal => { calls.push(['get', signal]); return get ? get(signal) : initial; },
    postTask: async (path, body, signal) => { calls.push(['post', path, body, signal]); return post ? post(path, body, signal) : { ok: true, task: task('running') }; },
    confirm: text => { calls.push(['confirm', text]); return confirm; },
    update: patch => { latest = { ...latest, ...patch }; updates.push(patch); },
    schedule: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    cancel: id => timers.delete(id),
  });
  return { api, calls, timers, updates, view: () => latest,
    tick: async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); await timer.fn(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('mount-independent session is read-only until explicit refresh and user action', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  await f.api.refresh(); assert.deepEqual(f.calls.map(c => c[0]), ['get']); assert.equal(f.timers.size, 0);
  assert.equal(f.view().status.selected.mode, 'native');
  f.api.close();
});

test('status projection is bounded and discards raw output, results and credential fields', () => {
  const result = deploymentStatus(status({ task: { ...task('failed'), rawLogs: 'private', result: { token: 'private' }, message: 'password=private token="private value" Bearer abc', steps: Array.from({ length: 40 }, () => ({ message: 'data:image/png;base64,private' })) }, password: 'private' }));
  assert.equal(result.task.steps.length, 24); assert.doesNotMatch(JSON.stringify(result), /private value|Bearer abc|rawLogs|"result"|"password"/);
  assert.equal(deploymentText('x'.repeat(1000)).length, 700);
  assert.doesNotMatch(deploymentText('http://name:secret@host'), /name:secret/);
  assert.doesNotMatch(deploymentText('{"password":"do-not-display", "api_key":"do-not-display"}'), /do-not-display/);
  assert.equal(result.task.elapsedMs, 3210);
  for (const invalid of [{}, status({ task: { state: 'done' } }), { ...status(), ok: false, error: 'no admin permission' }]) assert.throws(() => deploymentStatus(invalid));
  assert.throws(() => deploymentTask(null));
});

test('start payload is allowlisted, default-private, host-platform based, and requires explicit fresh-deployment consent', () => {
  const s = deploymentStatus(status());
  const body = deploymentBody(s, { ...consent, container: 'evil', command: 'rm -rf', installWsl: true });
  assert.deepEqual(plain(body), { confirm: true, installDocker: false, installWsl: false, authorized: true, injectionRisk: true, publicDesktop: false, allowExistingPublicPorts: false, image: 'official/image:latest' });
  assert.throws(() => deploymentBody(s, {}), /deployConsent/);
  assert.throws(() => deploymentBody(deploymentStatus(status({ docker: { installed: false } })), consent), /deployConsent/);
  assert.throws(() => deploymentBody(deploymentStatus(status({ host: { platform: 'darwin' } })), consent), /deployUnsupported/);
  const windows = deploymentStatus(status({ host: { platform: 'win32', arch: 'arm64' }, docker: { installed: false, canInstall: true } }));
  assert.equal(deploymentBody(windows, { ...consent, installDocker: true }).installWsl, false);
  assert.equal(deploymentBody(windows, { ...consent, installDocker: true, installWsl: true }).installWsl, true);
});

test('Windows approval failure maps to checkbox/new-start guidance and installed engine maps to manual Desktop steps', () => {
  const failed = deploymentStatus(status({ host: { platform: 'win32' }, task: { ...task('failed'), reason: 'wsl-install-approval-required' } }));
  assert.equal(failed.task.reason, 'wsl-install-approval-required');
  assert.equal(deploymentActionHint(failed), 'deployWslApproval');
  assert.equal(deploymentActionHint(deploymentStatus(status({ host: { platform: 'win32' }, docker: { installed: true, ready: false } }))), 'deployWindowsInstalled');
  assert.equal(deploymentActionHint(deploymentStatus(status())), '');
  assert.ok(source.includes('resume cannot add new permissions'));
  assert.ok(source.includes('check the WSL2 permission above'));
});

test('WSL approval failure permits a fresh start with newly checked permission, never resume mutation', async () => {
  const f = fixture({ initial: status({ host: { platform: 'win32' }, task: { ...task('failed'), reason: 'wsl-install-approval-required' } }) });
  await f.api.refresh();
  assert.equal(await f.api.run({}, true), false);
  assert.equal(await f.api.run({ ...consent, installWsl: true }), true);
  const call = f.calls.find(c => c[0] === 'post'); assert.equal(call[1], '/deploy/start'); assert.equal(call[2].installWsl, true);
  f.api.close();
});

test('browser rejection and missing checkboxes cannot submit a write', async () => {
  const f = fixture({ confirm: false }); await f.api.refresh();
  assert.equal(await f.api.run({}), false); assert.equal(await f.api.run(consent), false);
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'confirm').length, 1); f.api.close();
});

test('submission serializes GET and POST and never overlaps a second click', async () => {
  let release;
  const f = fixture({ post: () => new Promise(resolve => { release = resolve; }) });
  await f.api.refresh(); const pending = f.api.run(consent);
  assert.equal(await f.api.run(consent), false); assert.equal(await f.api.refresh(), false);
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 1);
  assert.equal(f.calls.at(-2)[0], 'confirm'); assert.equal(f.calls.at(-1)[1], '/deploy/start');
  release({ ok: true, task: task('running') }); assert.equal(await pending, true);
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].ms, 0); f.api.close();
});

test('running tasks poll only every 2s and stop at terminal or needs_action states', async () => {
  let next = status({ task: task('running') });
  const f = fixture({ get: () => next }); await f.api.refresh();
  assert.equal([...f.timers.values()][0].ms, 2000);
  next = status({ task: task('needs_action') }); await f.tick(); assert.equal(f.timers.size, 0);
  next = status({ task: task('succeeded') }); await f.api.refresh(); assert.equal(f.timers.size, 0);
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 0); f.api.close();
});

test('resume is available only for needs_action and sends exactly confirm:true', async () => {
  const f = fixture({ initial: status({ task: task('needs_action') }) }); await f.api.refresh();
  assert.equal(await f.api.run(consent), false);
  assert.equal(await f.api.run({}, true), true);
  const call = f.calls.find(c => c[0] === 'post'); assert.equal(call[1], '/deploy/resume');
  assert.deepEqual(plain(call[2]), { confirm: true }); f.api.close();
  const idle = fixture(); await idle.api.refresh(); assert.equal(await idle.api.run({}, true), false);
  assert.equal(idle.calls.filter(c => c[0] === 'confirm').length, 0); idle.api.close();
});

test('failed/ambiguous POST requires successful reconciliation before another submission; error remains visible', async () => {
  const f = fixture({ post: async () => { throw new Error('permission denied password=secret'); } }); await f.api.refresh();
  assert.equal(await f.api.run(consent), false);
  assert.equal(await f.api.run(consent), false);
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 1);
  assert.match(f.view().error, /permission denied/); assert.doesNotMatch(f.view().error, /secret/);
  await f.tick(); assert.match(f.view().error, /permission denied/); assert.equal(f.view().busy, false);
  assert.equal(await f.api.run(consent), false); assert.equal(f.calls.filter(c => c[0] === 'post').length, 2); f.api.close();
});

test('in-flight initial read blocks writes and failed reads release controls with a visible error', async () => {
  let rejectRead;
  const f = fixture({ get: () => new Promise((_resolve, reject) => { rejectRead = reject; }) });
  const pending = f.api.refresh(); assert.equal(await f.api.run(consent), false);
  rejectRead(new Error('status permission denied')); assert.equal(await pending, false);
  assert.equal(f.view().checking, false); assert.match(f.view().error, /permission denied/);
  assert.equal(f.timers.size, 0); f.api.close();
});

test('unmount aborts in-flight reads, cancels timers and suppresses late updates', async () => {
  let release, signal;
  const f = fixture({ get: value => { signal = value; return new Promise(resolve => { release = resolve; }); } });
  const pending = f.api.refresh(), before = f.updates.length;
  f.api.close(); assert.equal(signal.aborted, true); release(status({ task: task('running') })); await pending;
  assert.equal(f.updates.length, before); assert.equal(f.timers.size, 0); assert.equal(await f.api.run(consent), false);
  const running = fixture({ initial: status({ task: task('running') }) }); await running.api.refresh(); running.api.close(); assert.equal(running.timers.size, 0);
});

test('closing during POST aborts viewing only and never requests host task cancellation', async () => {
  let release, signal;
  const f = fixture({ post: (_path, _body, value) => { signal = value; return new Promise(resolve => { release = resolve; }); } });
  await f.api.refresh(); const pending = f.api.run(consent), before = f.updates.length;
  f.api.close(); assert.equal(signal.aborted, true); release({ ok: true, task: task('running') }); await pending;
  assert.equal(f.updates.length, before); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls.filter(c => c[0] === 'post').map(c => c[1]), ['/deploy/start']);
});

test('panel preserves mount-aware transport, slot registration and login/password separation', () => {
  const panel = source.slice(source.indexOf('    function DeploymentPanel('), source.indexOf('    // 运维：机器人进程'));
  const setup = source.slice(source.indexOf('    function SetupPanel('), source.indexOf('    // Deployment helpers'));
  assert.match(setup, /active && info\?\.backend !== 'napcat' \? h\(DeploymentPanel/);
  assert.ok(setup.indexOf('h(DeploymentPanel') < setup.indexOf('h(LoginPanel'));
  assert.match(panel, /get\('\/deploy\/status', \{ signal \}\)/);
  assert.match(panel, /post\(path, body, \{ signal \}\)/);
  assert.match(panel, /confirm: text => window\.confirm\(text\)/);
  assert.match(panel, /current\.close\(\)/);
  assert.doesNotMatch(panel + helpers, /localStorage|sessionStorage|console\.|setInterval|type: 'password'|navigator\.|rawLogs|fetch\(/);
  assert.match(source, /ctx\.slots\.register\(\{ name: 'settings.section', id: 'dsh-qq', order: 54, label: tr\('title'\) \}, Section\)/);
  for (const text of ['一键部署 SnowLuma', 'Deploy SnowLuma', 'SYS_PTRACE / ptrace', 'HTTP', 'UAC', 'WSL2', 'license/subscription', '宿主任务会继续', 'host task continues', 'wsl --install --no-distribution']) assert.ok(source.includes(text), text);
  assert.match(panel, /publicDesktop: false, allowExistingPublicPorts: false/);
});

test('shared mount-aware transport propagates component abort without losing same-origin protection', async () => {
  const transport = source.slice(source.indexOf('    const request = async'), source.indexOf('    const configWrite'));
  let captured;
  const { get } = vm.runInNewContext(`${transport}\n({ get })`, { B: '/mount/dsh-qq', AbortController, setTimeout, clearTimeout,
    fetch: async (url, init) => { captured = { url, init }; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true })); } });
  const controller = new AbortController(); const pending = get('/deploy/status', { signal: controller.signal }); controller.abort();
  assert.equal((await pending).ok, false); assert.equal(captured.url, '/mount/dsh-qq/deploy/status');
  assert.equal(captured.init.credentials, 'same-origin'); assert.equal(captured.init.cache, 'no-store'); assert.equal(captured.init.signal.aborted, true);
});
