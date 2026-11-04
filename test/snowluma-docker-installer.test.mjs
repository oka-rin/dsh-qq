import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runInstaller, createArgs, freshConfig, main, safeError, verifyExisting, INSPECT_FORMAT, dockerEndpoint } from '../scripts/install-snowluma-docker.mjs';

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
  assert.equal(result.created, true); assert.equal(result.id, ID); assert.equal(result.started, false); assert.equal(result.termsAccepted, false);
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
  assert.equal(dockerEndpoint('linux'), 'unix:///var/run/docker.sock');
  assert.equal(dockerEndpoint('win32'), 'npipe:////./pipe/dockerDesktopLinuxEngine');
  assert.throws(() => dockerEndpoint('darwin'), /unsupported-platform/);
  assert.equal(source.includes("spawn(dockerExecutable(platform), ['--host', endpoint, ...args]"), true);
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

const windowsFresh = (extra = {}) => ({ mode: 'install', platform: 'win32', container: 'snowluma', image: PIN, uid: 59999, gid: 59999, httpPort: 3000, wsPort: 3001, webuiPort: 5099, desktopPort: 6081, confirmInstall: true, authorized: true, injectionRisk: true, ...extra });
function windowsDocker(options, { osType = 'linux', occupied = false, collision = false, wrongVolume = false, badMount = false, failCopy = false, forgedLabel = false } = {}) {
  const calls = [], archives = [], volumes = [];
  let createdState;
  const run = async (args, transport) => {
    assert.equal(transport.platform, options.platform);
    calls.push([...args]);
    if (args[0] === 'info') return osType;
    if (args[0] === 'container' && args[1] === 'ls') return occupied ? options.container : '';
    if (args[0] === 'image') return IMAGE_ID;
    if (args[0] === 'volume' && args[1] === 'ls') return collision ? args[args.indexOf('--filter') + 1].slice(6, -1) : '';
    if (args[0] === 'volume' && args[1] === 'create') {
      volumes.push({ name: args.at(-1), nonce: args[args.indexOf('--label') + 1].split('=')[1] });
      return wrongVolume ? 'wrong-volume' : args.at(-1);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const v = volumes.find(v => v.name === args.at(-1));
      return JSON.stringify({ Name: v.name, Driver: 'local', Scope: 'local', Labels: { 'dev.dsh.snowluma.fresh': forgedLabel ? 'preexisting' : v.nonce }, Options: null });
    }
    if (args[0] === 'create') {
      createdState = state(options);
      createdState.mounts = createdState.mounts.map((m, i) => ({ ...m, Name: volumes[i].name, Source: `/var/lib/docker/volumes/${volumes[i].name}/_data` }));
      if (badMount) createdState.mounts[0] = state().mounts[0];
      return ID;
    }
    if (args[0] === 'container' && args[1] === 'inspect') return inspect(createdState || state());
    if (args[0] === 'cp') {
      assert.ok(Buffer.isBuffer(transport.input));
      archives.push(Buffer.from(transport.input));
      if (failCopy) throw new Error('PRIVATE_UPSTREAM_COPY_ERROR');
      return '';
    }
    if (args[0] === 'start' || args[0] === 'pull') return ID;
    throw new Error('unexpected fake Windows Docker operation');
  };
  return { run, calls, archives, volumes };
}
function tarEntries(archive) {
  const result = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const text = (start, size) => header.subarray(start, start + size).toString().replace(/\0.*$/s, '').trim();
    const size = parseInt(text(124, 12), 8);
    const checksum = parseInt(text(148, 8), 8);
    assert.equal(checksum, [...header].reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0));
    result.push({ name: text(0, 100), uid: parseInt(text(108, 8), 8), gid: parseInt(text(116, 8), 8), mode: parseInt(text(100, 8), 8), content: archive.subarray(offset + 512, offset + 512 + size).toString() });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

test('Linux named-volumes plan is offline; fresh CLI retains gates and rejects ambiguous storage', async () => {
  const plan = parseArgs(['--named-volumes']); let calls = 0;
  const result = await runInstaller(plan, async () => { calls++; throw new Error('never'); });
  assert.equal(result.offline, true); assert.equal(calls, 0);
  const args = ['--install', '--confirm-install', '--confirm-authorized-deployment', '--allow-qq-injection-risk', '--named-volumes', '--image', PIN];
  assert.equal(parseArgs(args).namedVolumes, true);
  assert.equal(parseArgs(args).dataDir, undefined);
  assert.throws(() => parseArgs([...args, '--data-dir', '/srv/new-state']), /named-volumes-conflict-with-data-dir/);
  for (const flag of ['--confirm-install', '--confirm-authorized-deployment', '--allow-qq-injection-risk']) {
    assert.throws(() => parseArgs(args.filter(arg => arg !== flag)));
  }
  await assert.rejects(runInstaller(windowsFresh({ platform: 'linux', namedVolumes: 'true' })), /invalid-named-volumes-option/);
});

test('Linux opt-in named volumes seed private Linux-owned state without host bind/chown', async () => {
  const options = windowsFresh({ platform: 'linux', namedVolumes: true, start: true });
  const docker = windowsDocker(options), result = await runInstaller(options, docker.run);
  assert.equal(result.id, ID); assert.equal(result.created, true); assert.equal(result.started, true);
  assert.deepEqual(docker.calls[0], ['info', '--format', '{{.OSType}}']);
  const create = docker.calls.find(c => c[0] === 'create').join(' ');
  assert.equal(create.includes('type=bind'), false); assert.equal(create.includes('volume-nocopy'), true);
  assert.equal(docker.volumes.length, 3); assert.equal(docker.archives.length, 3);
  for (const archive of docker.archives) for (const entry of tarEntries(archive)) {
    assert.equal(entry.uid, 59999); assert.equal(entry.gid, 59999);
    assert.equal(entry.mode, entry.name.endsWith('.json') || entry.name.endsWith('vnc-password') ? 0o600 : 0o700);
  }
  assert.deepEqual(docker.calls.at(-1), ['start', ID]);
  const invalidEngine = windowsDocker(options, { osType: 'windows' });
  await assert.rejects(runInstaller(options, invalidEngine.run), /linux-container-engine-required/);
  assert.equal(invalidEngine.calls.length, 1);
  for (const failure of [{ collision: true }, { forgedLabel: true }, { badMount: true }, { failCopy: true }]) {
    const failed = windowsDocker(options, failure);
    await assert.rejects(runInstaller(options, failed.run));
    assert.equal(failed.calls.some(c => c[0] === 'start' || c.includes('rm') || c.includes('prune')), false);
  }
});

test('Linux named-volumes preference does not rewrite or reject safe existing binds', async t => {
  const root = await TEMP(t), options = { ...parseArgs(['--check', '--adopt-existing', '--image', PIN, '--named-volumes']), platform: 'linux' };
  for (const name of ['data', 'qq-config', 'qq-share']) await fs.mkdir(path.join(root, name));
  const docker = fakeDocker(options, { customState: state(options, root) });
  const result = await runInstaller(options, docker.run);
  assert.equal(result.adopted, true); assert.equal(result.readOnly, true); assert.equal(result.configurationChanged, false);
  assert.deepEqual(docker.calls.map(c => c[0]), ['image', 'container']);
});

test('Windows plan stays offline and validates platform without CLI platform override', async () => {
  let calls = 0;
  const result = await runInstaller({ ...parseArgs([]), platform: 'win32' }, async () => { calls++; });
  assert.equal(result.offline, true); assert.equal(calls, 0);
  await assert.rejects(runInstaller({ ...windowsFresh(), platform: 'darwin' }), /unsupported-platform/);
  await assert.rejects(runInstaller(windowsFresh({ dataDir: 'C:\\unsafe' })), /windows-requires-named-volumes/);
  assert.throws(() => parseArgs(['--platform', 'win32']), /unknown-option/);
  for (const flag of ['confirmInstall', 'authorized', 'injectionRisk']) {
    await assert.rejects(runInstaller(windowsFresh({ [flag]: false }), async () => { throw new Error('never'); }));
  }
});

test('Windows fresh seed uses private in-memory tar, random independent named volumes and Linux engine', async () => {
  const options = windowsFresh({ start: true }), docker = windowsDocker(options);
  const result = await runInstaller(options, docker.run);
  assert.equal(result.created, true); assert.equal(result.id, ID); assert.equal(result.started, true); assert.equal(result.termsAccepted, false);
  assert.deepEqual(docker.calls[0], ['info', '--format', '{{.OSType}}']);
  assert.equal(docker.volumes.length, 3); assert.equal(new Set(docker.volumes.map(v => v.name)).size, 3);
  for (const v of docker.volumes) assert.match(v.name, /^snowluma-[a-f0-9]{32}-(data|qq-config|qq-share)$/);
  const create = docker.calls.find(c => c[0] === 'create').join(' ');
  assert.equal(create.includes('type=bind'), false); assert.equal(create.includes('volume-nocopy'), true);
  assert.equal(create.includes('--log-driver none'), true); assert.equal(create.includes('SNOWLUMA_HOOK_AUTOLOAD=0'), true);
  assert.equal(docker.calls.some(c => ['exec', 'run', 'rm'].includes(c[0])), false);
  assert.equal(docker.archives.length, 3);
  const entries = tarEntries(docker.archives[0]);
  assert.deepEqual(entries.map(e => e.name), ['data', 'data/config', 'data/config/onebot.json', 'data/config/runtime.json', 'data/config/vnc-password']);
  for (const entry of entries) {
    assert.equal(entry.uid, 59999); assert.equal(entry.gid, 59999);
    assert.equal(entry.mode, entry.name === 'data' || entry.name === 'data/config' ? 0o700 : 0o600);
  }
  const cfg = JSON.parse(entries.find(e => e.name.endsWith('onebot.json')).content);
  const runtime = JSON.parse(entries.find(e => e.name.endsWith('runtime.json')).content);
  assert.equal(runtime.hookAutoLoad, false);
  const tokens = [cfg.networks.httpServers[0].accessToken, cfg.networks.wsServers[0].accessToken];
  assert.notEqual(tokens[0], tokens[1]);
  for (const secret of [...tokens, entries.at(-1).content.trim()]) {
    assert.equal(JSON.stringify(docker.calls).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(tarEntries(docker.archives[1]).map(e => e.name), ['.config']);
  assert.deepEqual(tarEntries(docker.archives[2]).map(e => e.name), ['share']);
  const lastCopies = docker.calls.filter(c => c[0] === 'cp');
  assert.deepEqual(lastCopies, ['/app', '/app', '/app/.local'].map(target => ['cp', '--archive', '-', `${ID}:${target}`]));
  assert.deepEqual(docker.calls.at(-1), ['start', ID]);
  const again = windowsDocker(options); await runInstaller(options, again.run);
  assert.notEqual(docker.volumes[0].nonce, again.volumes[0].nonce);
});

test('Windows refuses Windows containers before inspection, pull or mutation', async () => {
  const options = windowsFresh({ pull: true, start: true }), docker = windowsDocker(options, { osType: 'windows' });
  await assert.rejects(runInstaller(options, docker.run), /linux-container-engine-required/);
  assert.equal(docker.calls.length, 1);
});

test('Windows volume attestation/copy/postcreate failures retain state and never start', async () => {
  for (const failure of [{ collision: true }, { wrongVolume: true }, { forgedLabel: true }, { badMount: true }, { failCopy: true }]) {
    const options = windowsFresh({ start: true }), docker = windowsDocker(options, failure);
    await assert.rejects(runInstaller(options, docker.run));
    assert.equal(docker.calls.some(c => c[0] === 'start'), false);
    assert.equal(docker.calls.some(c => c.includes('rm') || c.includes('prune') || c.includes('--force')), false);
  }
  const options = windowsFresh({ pull: true }), docker = windowsDocker(options, { occupied: true });
  await assert.rejects(runInstaller(options, docker.run), /container-already-exists/);
  assert.equal(docker.calls.some(c => ['pull', 'create', 'volume'].includes(c[0])), false);
});

test('Windows named-volume adoption stays read-only, rejects daemon bind sources', async () => {
  const options = { ...parseArgs(['--check', '--adopt-existing', '--image', PIN]), platform: 'win32' };
  const docker = windowsDocker(options); const result = await runInstaller(options, docker.run);
  assert.equal(result.readOnly, true);
  assert.deepEqual(docker.calls.map(c => c[0]), ['info', 'image', 'container']);
  const bind = { ...state(), mounts: state().mounts.map(m => ({ ...m, Type: 'bind', Source: '/srv/dedicated' })) };
  await assert.rejects(runInstaller(options, async args => args[0] === 'info' ? 'linux' : args[0] === 'image' ? IMAGE_ID : inspect(bind)), /windows-requires-named-volumes/);
});
