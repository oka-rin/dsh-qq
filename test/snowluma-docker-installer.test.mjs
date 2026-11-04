import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runInstaller, createArgs, freshConfig, main, safeError, verifyExisting, INSPECT_FORMAT } from '../scripts/install-snowluma-docker.mjs';

// Every command is injected. These tests must NEVER call a real Docker daemon.
const PIN = 'motricseven7/snowluma@sha256:' + 'a'.repeat(64);
const IMAGE_ID = 'sha256:' + 'b'.repeat(64);
const ID = 'c'.repeat(64);
const TEMP = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snowluma-installer-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(root).startsWith('snowluma-installer-test-'), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
};
const fresh = dir => parseArgs(['--install', '--confirm-install', '--confirm-authorized-deployment', '--allow-qq-injection-risk', '--image', PIN, '--data-dir', dir, '--uid', String(process.getuid?.() || 59999), '--gid', String(process.getgid?.() || 59999)]);
const adopt = (...extra) => parseArgs(['--install', '--confirm-install', '--adopt-existing', '--image', PIN, ...extra]);
function state(options = {}, dataDir) {
  const o = { httpPort: 3000, wsPort: 3001, webuiPort: 5099, desktopPort: 6081, ...options };
  return {
    imageId: IMAGE_ID, id: ID, running: false, privileged: false, networkMode: 'bridge',
    mounts: ['/app/data', '/app/.config', '/app/.local/share'].map((Destination, i) => ({ Destination, Type: dataDir ? 'bind' : 'volume', Source: dataDir ? path.join(dataDir, ['data', 'qq-config', 'qq-share'][i]) : `/var/lib/docker/volumes/test-volume-${i}/_data`, ...(dataDir ? {} : { Name: `test-volume-${i}` }), RW: true })),
    ports: Object.fromEntries(Object.entries({ httpPort: 3000, wsPort: 3001, webuiPort: 5099, desktopPort: 6081 }).map(([key, inside]) => [`${inside}/tcp`, [{ HostIp: key === 'desktopPort' && o.publicDesktop ? '0.0.0.0' : '127.0.0.1', HostPort: String(o[key]) }]])),
  };
}
const inspect = s => [s.imageId, s.mounts, s.ports, s.running, s.privileged, s.id, s.networkMode].map(x => JSON.stringify(x)).join('\n');
function fakeDocker(options, { existing = false, customState, error } = {}) {
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (error) throw new Error(error);
    if (args[0] === 'container' && args[1] === 'ls') return existing ? options.container + '\n' : '';
    if (args[0] === 'image') return IMAGE_ID;
    if (args[0] === 'container' && args[1] === 'inspect') return inspect(customState || state(options, options.dataDir));
    if (args[0] === 'create') return ID;
    if (args[0] === 'pull' || args[0] === 'start') return ID;
    throw new Error('unexpected fake Docker operation');
  };
  return { calls, run };
}

test('default plan is offline/read-only and emits no local identifiers', async () => {
  let calls = 0;
  const result = await runInstaller(parseArgs([]), async () => { calls++; throw new Error('must not run'); });
  assert.equal(calls, 0); assert.equal(result.offline, true); assert.equal(result.mutation, false);
  assert.equal(JSON.stringify(result).includes('/root'), false);
});

test('strict gates reject unsafe images, names, paths and accidental install flags', () => {
  for (const args of [
    ['--install'], ['--install', '--confirm-install'], ['--pull'], ['--start'], ['--confirm-install'],
    ['--plan', '--install'], ['--check'], ['--check', '--adopt-existing'], ['--container', '--bad'],
    ['--container', '../bad'], ['--image', 'motricseven7/snowluma:latest'], ['--image', 'attacker/snowluma@sha256:' + 'a'.repeat(64)],
    ['--image', 'motricseven7/snowluma@sha256:short'], ['--data-dir', './relative'], ['--data-dir', '/tmp/../state'],
    ['--data-dir', '/tmp/contains,comma'], ['--uid', '0'], ['--gid', '-1'], ['--desktop-port', '65536'],
    ['--desktop-port', '3000'], ['--container', 'x', '--container', 'y'], ['--wat'],
    ['--install', '--confirm-install', '--image', PIN, '--data-dir', '/some/new', '--allow-qq-injection-risk'],
    ['--install', '--confirm-install', '--confirm-authorized-deployment', '--image', PIN, '--data-dir', '/some/new'],
  ]) assert.throws(() => parseArgs(args), `should reject ${args[0]}`);
});

test('path validation rejects existing state and symlink ancestors without Docker', async t => {
  const root = await TEMP(t);
  const old = path.join(root, 'old'); await fs.mkdir(old); await fs.writeFile(path.join(old, 'retain'), 'old data');
  const link = path.join(root, 'link'); await fs.symlink(old, link);
  let calls = 0; const docker = async () => { calls++; throw new Error('never'); };
  await assert.rejects(runInstaller(parseArgs(['--data-dir', old]), docker), /already-exists/);
  await assert.rejects(runInstaller(parseArgs(['--data-dir', path.join(link, 'new')]), docker), /unsafe-data-parent/);
  assert.equal(calls, 0); assert.equal(await fs.readFile(path.join(old, 'retain'), 'utf8'), 'old data');
});

test('fresh create requires cached image, uses private files and never starts/pulls implicitly', async t => {
  const root = await TEMP(t), dir = path.join(root, 'new');
  const options = fresh(dir), docker = fakeDocker(options);
  const result = await runInstaller(options, docker.run);
  assert.equal(result.created, true); assert.equal(result.started, false); assert.equal(result.termsAccepted, false);
  assert.deepEqual(docker.calls.map(c => c[0]), ['container', 'image', 'create', 'container']);
  const cfg = JSON.parse(await fs.readFile(path.join(dir, 'data/config/onebot.json'), 'utf8'));
  const http = cfg.networks.httpServers[0], ws = cfg.networks.wsServers[0];
  assert.match(http.accessToken, /^[a-f0-9]{64}$/); assert.match(ws.accessToken, /^[a-f0-9]{64}$/);
  assert.notEqual(http.accessToken, ws.accessToken); assert.equal(http.host, '0.0.0.0'); assert.equal(ws.port, 3001);
  assert.equal((await fs.stat(path.join(dir, 'data/config/onebot.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dir, 'data/config/vnc-password'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.readFile(path.join(dir, 'data/config/vnc-password'), 'utf8')).trim().length, 32);
  assert.equal(await fs.stat(path.join(dir, 'data/config/consent.json')).catch(() => null), null);
  const args = createArgs(options), joined = args.join(' ');
  for (const secret of [http.accessToken, ws.accessToken]) assert.equal(joined.includes(secret), false);
  for (const unsafe of ['VNC_PASSWD', 'ACCEPT_EULA', 'ACCEPT_PRIVACY', '--privileged', 'cap_drop', 'no-new-privileges']) assert.equal(joined.includes(unsafe), false);
  assert.equal(joined.includes('SNOWLUMA_HOOK_AUTOLOAD=0'), true); assert.equal(joined.includes('--log-driver none'), true);
  assert.equal(args.at(-1), PIN); assert.equal(joined.includes('SYS_PTRACE'), true);
  for (const port of [3000, 3001, 5099, 6081]) assert.equal(joined.includes(`127.0.0.1:${port}:${port}`), true);
});

test('explicit pull/start only occurs in reviewed sequence', async t => {
  const root = await TEMP(t), options = { ...fresh(path.join(root, 'new')), pull: true, start: true };
  const docker = fakeDocker(options); await runInstaller(options, docker.run);
  assert.deepEqual(docker.calls.map(c => c[0]), ['container', 'pull', 'image', 'create', 'container', 'start']);
  assert.deepEqual(docker.calls.at(-1), ['start', ID]);
});

test('stopped existing container prevents fresh data creation and pull', async t => {
  const root = await TEMP(t), options = { ...fresh(path.join(root, 'new')), pull: true };
  const docker = fakeDocker(options, { existing: true });
  await assert.rejects(runInstaller(options, docker.run), /container-already-exists/);
  assert.equal(docker.calls.length, 1); assert.equal(await fs.stat(options.dataDir).catch(() => null), null);
});

test('adopt check is explicitly online read-only without authorization claim', async () => {
  const options = parseArgs(['--check', '--adopt-existing', '--image', PIN]);
  const docker = fakeDocker(options); const result = await runInstaller(options, docker.run);
  assert.equal(result.readOnly, true); assert.equal(result.configurationChanged, false); assert.equal(result.credentialsChanged, false);
  assert.equal(result.adopted, true); assert.equal(result.started, false);
  assert.equal(docker.calls.length, 2); assert.deepEqual(docker.calls[1], ['container', 'inspect', '--format', INSPECT_FORMAT, 'snowluma']);
});

test('adopt explicitly starts only stopped, verified container without recreation', async () => {
  const options = adopt('--start'), docker = fakeDocker(options);
  await runInstaller(options, docker.run);
  assert.deepEqual(docker.calls.map(c => c[0]), ['image', 'container', 'start']);
  const running = fakeDocker(options, { customState: { ...state(), running: true } });
  const result = await runInstaller(options, running.run);
  assert.equal(result.alreadyRunning, true); assert.equal(running.calls.some(c => c[0] === 'start'), false);
});

test('adoption rejects wrong image, missing/unsafe mounts, hidden ports and public mappings', () => {
  const options = adopt();
  const cases = [
    { ...state(), imageId: 'sha256:' + 'd'.repeat(64) }, { ...state(), mounts: [] }, { ...state(), privileged: true },
    { ...state(), ports: { ...state().ports, '5900/tcp': [{ HostIp: '0.0.0.0', HostPort: '5900' }] } },
    { ...state(), mounts: state().mounts.map((m, i) => i ? m : { ...m, Source: '/' }) },
    { ...state(), mounts: state().mounts.map((m, i) => i ? m : { ...m, RW: false }) },
    { ...state(), ports: { ...state().ports, '6081/tcp': [{ HostIp: '0.0.0.0', HostPort: '6081' }] } },
    { ...state(), ports: { ...state().ports, '6081/tcp': [{ HostIp: '127.0.0.1', HostPort: '16081' }] } },
  ];
  for (const s of cases) assert.throws(() => verifyExisting(s, options, IMAGE_ID));
  assert.equal(verifyExisting(cases[6], { ...options, allowExistingPublicPorts: true }, IMAGE_ID).publicPorts, true);
});

test('fresh state uses dedicated IDs, keeps mode 0600, and never creates consent', { skip: process.getuid?.() !== 0 }, async t => {
  const root = await TEMP(t), options = { ...fresh(path.join(root, 'new')), uid: 59999, gid: 59999 };
  await runInstaller(options, fakeDocker(options).run);
  const file = await fs.stat(path.join(options.dataDir, 'data/config/onebot.json'));
  assert.equal(file.uid, 59999); assert.equal(file.gid, 59999); assert.equal(file.mode & 0o777, 0o600);
  assert.equal((await fs.stat(options.dataDir)).uid, process.getuid());
  assert.equal((await fs.stat(path.join(options.dataDir, 'data'))).uid, 59999);
  assert.equal(await fs.stat(path.join(options.dataDir, 'data/config/consent.json')).catch(() => null), null);
});

test('public desktop does not authorize fresh public OneBot ports', async t => {
  const root = await TEMP(t), options = { ...fresh(path.join(root, 'new')), publicDesktop: true, start: true };
  const malicious = state(options, options.dataDir);
  malicious.ports['3000/tcp'][0].HostIp = '0.0.0.0';
  const docker = fakeDocker(options, { customState: malicious });
  await assert.rejects(runInstaller(options, docker.run), /created-ports-mismatch/);
  assert.equal(docker.calls.some(c => c[0] === 'start'), false);
});

test('adoption validates canonical independent mount roots and allows real named volumes', () => {
  const options = adopt(), base = state();
  assert.doesNotThrow(() => verifyExisting(base, options, IMAGE_ID));
  for (const Source of ['/', '/etc', '/etc/ssh', '/root', '/home', '/var', '/var/lib', '/var/lib/docker', '/var/lib/docker/volumes/x/_data', '/run/docker.sock', '/proc', '/srv/state/../other', '/srv//state', '/srv/state/', 'relative']) {
    const bad = { ...base, mounts: base.mounts.map((m, i) => i ? m : { ...m, Type: 'bind', Source }) };
    assert.throws(() => verifyExisting(bad, options, IMAGE_ID), /unsafe-existing-mount/);
  }
  const bind = { ...base, mounts: base.mounts.map((m, i) => ({ ...m, Type: 'bind', Source: `/srv/dedicated-${i}` })) };
  assert.doesNotThrow(() => verifyExisting(bind, options, IMAGE_ID));
  for (const sources of [['/srv/state', '/srv/state/child', '/srv/other'], ['/srv/state/child', '/srv/state', '/srv/other'], ['/srv/same', '/srv/same', '/srv/other']]) {
    assert.throws(() => verifyExisting({ ...bind, mounts: bind.mounts.map((m, i) => ({ ...m, Source: sources[i] })) }, options, IMAGE_ID), /not-independent/);
  }
  assert.throws(() => verifyExisting({ ...base, mounts: base.mounts.map((m, i) => i ? m : { ...m, Source: '/var/lib/docker/volumes/wrong/_data' }) }, options, IMAGE_ID), /unsafe-existing-mount/);
});

test('online adoption accepts real bind directories and rejects symlink aliases/ancestors', async t => {
  const root = await TEMP(t), dirs = ['data', 'config', 'share'].map(name => path.join(root, name));
  for (const dir of dirs) await fs.mkdir(dir, { mode: 0o700 });
  const options = parseArgs(['--check', '--adopt-existing', '--image', PIN]);
  const good = { ...state(), mounts: state().mounts.map((m, i) => ({ ...m, Type: 'bind', Source: dirs[i] })) };
  await assert.doesNotReject(runInstaller(options, fakeDocker(options, { customState: good }).run));
  await fs.symlink(dirs[0], path.join(root, 'alias'));
  await fs.symlink(root, path.join(root, 'parent-alias'));
  await fs.symlink('/etc', path.join(root, 'system-alias'));
  for (const Source of [path.join(root, 'alias'), path.join(root, 'parent-alias', 'data'), path.join(root, 'system-alias'), path.join(root, 'missing')]) {
    const bad = { ...good, mounts: good.mounts.map((m, i) => i ? m : { ...m, Source }) };
    const docker = fakeDocker(options, { customState: bad });
    await assert.rejects(runInstaller(options, docker.run), /unsafe-existing-mount/);
    assert.equal(docker.calls.some(c => c[0] === 'start'), false);
  }
});

test('adoption rejects host and joined-container networking, accepts bridge names', () => {
  for (const networkMode of ['host', 'none', 'container:' + ID, '', undefined]) assert.throws(() => verifyExisting({ ...state(), networkMode }, adopt(), IMAGE_ID), /network-mode/);
  for (const networkMode of ['bridge', 'default', 'snowluma_default']) assert.doesNotThrow(() => verifyExisting({ ...state(), networkMode }, adopt(), IMAGE_ID));
});

test('fresh path requires trusted non-writable ancestors and private parent below tmp', async t => {
  const root = await TEMP(t), parent = path.join(root, 'parent'); await fs.mkdir(parent, { mode: 0o700 });
  const offline = async () => { throw new Error('Docker must not run'); };
  await fs.chmod(parent, 0o777);
  await assert.rejects(runInstaller(parseArgs(['--data-dir', path.join(parent, 'new')]), offline), /unsafe-data-parent/);
  await fs.chmod(parent, 0o770);
  await assert.rejects(runInstaller(parseArgs(['--data-dir', path.join(parent, 'new')]), offline), /unsafe-data-parent/);
  await fs.chmod(parent, 0o700);
  await assert.doesNotReject(runInstaller(parseArgs(['--data-dir', path.join(parent, 'new')]), offline));
  if (process.getuid?.() === 0) {
    await fs.chown(parent, 59998, 59998);
    await assert.rejects(runInstaller(parseArgs(['--data-dir', path.join(parent, 'new')]), offline), /unsafe-data-parent/);
    await fs.chown(parent, 0, 0);
  }
  await assert.rejects(runInstaller(parseArgs(['--data-dir', path.join('/tmp', `snowluma-unsafe-${path.basename(root)}`)]), offline), /unsafe-data-parent/);
});

test('Docker wrapper pins local Unix socket independent of user Docker context', async () => {
  // Source inspection deliberately avoids starting even a fake CLI process.
  const source = await fs.readFile(new URL('../scripts/install-snowluma-docker.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes("spawn('docker', ['--host', 'unix:///var/run/docker.sock', ...args]"), true);
  assert.equal(source.includes('DOCKER_HOST:'), false);
  assert.equal(source.includes('DOCKER_CONTEXT:'), false);
});

test('postcreate verification failure never starts and retains new data', async t => {
  const root = await TEMP(t), options = { ...fresh(path.join(root, 'new')), start: true };
  const docker = fakeDocker(options, { customState: { ...state(options, options.dataDir), imageId: 'sha256:' + 'e'.repeat(64) } });
  await assert.rejects(runInstaller(options, docker.run), /image-mismatch/);
  assert.equal(docker.calls.some(c => c[0] === 'start'), false);
  assert.equal((await fs.stat(options.dataDir)).isDirectory(), true);
});

test('errors/output never disclose upstream credentials, paths or supplied argv', async () => {
  const secret = 'SENSITIVE_TOKEN_NEVER_PRINT'; let out = '', err = '';
  const output = { write: s => { out += s; } }, errors = { write: s => { err += s; } };
  const code = await main(['--check', '--adopt-existing', '--image', PIN], async () => { throw new Error(secret); }, output, errors);
  assert.equal(code, 1); assert.equal((out + err).includes(secret), false); assert.equal(err.includes('operation-failed'), true);
  await main(['--image', secret], async () => { throw new Error('never'); }, output, errors);
  assert.equal((out + err).includes(secret), false);
  assert.equal(safeError(new Error('secret upstream stderr')), 'operation-failed');
  const cfg = freshConfig('http-test-token', 'ws-test-token');
  assert.equal(cfg.networks.wsServers[0].accessToken, 'ws-test-token');
});
