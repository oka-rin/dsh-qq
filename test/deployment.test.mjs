import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeployment, readDeploymentSelection, DEFAULT_DEPLOY_IMAGE } from '../deployment.js';
const ready = { ready: true, installed: true, stage: 'ready', checks: {} };
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deploy-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const configPath = path.join(dataDir, 'config.json');
  const before = { onebot: { gateway: 'snowluma', httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001/event', accessToken: 'old-private' }, llm: { apiKey: 'preserved-private' }, persona: { name: 'synthetic' }, storage: { dataDir: 'data' } };
  fs.writeFileSync(configPath, JSON.stringify(before));
  let installed = 0, selected = 0;
  const calls = [];
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'ls') return options.existing === false ? '' : 'snowluma\n';
    if (args[0] === 'container' && args[1] === 'inspect') return 'true';
    if (args[0] === 'exec') return JSON.stringify({ networks: { httpServers: [{ port: 3000, accessToken: 'a'.repeat(64) }], wsServers: [{ port: 3001, accessToken: 'b'.repeat(64) }] } });
    throw new Error('secret-should-not-escape');
  };
  const installer = async input => { calls.push(['installer', input]); installed++; return options.existing === false ? { created: true, started: true, id: 'c'.repeat(64) } : { adopted: true, alreadyRunning: true, credentialsChanged: false }; };
  const prerequisites = options.prerequisites || { probe: async () => ready, install: async () => ready };
  const d = createDeployment({ dataDir, configPath, docker, installer, prerequisites, onSelected: async () => { selected++; }, ...options });
  return { d, dataDir, configPath, before, calls, get installed() { return installed; }, get selected() { return selected; } };
}
const consent = { confirm: true, installDocker: false, authorized: true, injectionRisk: true, allowExistingPublicPorts: true };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const freshId = 'c'.repeat(64);
const onebot = () => JSON.stringify({ networks: { httpServers: [{ port: 3000, accessToken: 'a'.repeat(64) }], wsServers: [{ port: 3001, accessToken: 'b'.repeat(64) }] } });
const pendingPath = f => path.join(f.dataDir, 'gateway-deployment-pending.json');
const selectionPath = f => path.join(f.dataDir, 'gateway-deployment.json');
function recoveryDocker(calls, id = freshId) {
  return async args => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'ls') return 'snowluma\n';
    if (args[0] === 'container' && args[1] === 'inspect') return args[3] === '{{.Id}}' ? id : 'true';
    if (args[0] === 'exec') return onebot();
    throw new Error('unexpected Docker operation');
  };
}
test('read-only status never starts or installs; projects host, existing and safe task fields', async t => {
  const f = fixture(t);
  const value = await f.d.status();
  assert.equal(value.host.platform, process.platform); assert.equal(value.docker.ready, true); assert.equal(value.existing.exists, true);
  assert.equal(value.task, null); assert.equal(f.installed, 0); assert.equal(value.defaults.image, DEFAULT_DEPLOY_IMAGE);
  assert.ok(!JSON.stringify(value).includes('private'));
});
test('browser grants fail closed before any installer operation', async t => {
  const f = fixture(t);
  for (const input of [{}, { confirm: false }, { confirm: true, shell: 'sh' }, { confirm: true, installDocker: 1 }, { confirm: true, image: 'other/image:latest' }]) assert.throws(() => f.d.start(input));
  assert.equal(f.installed, 0);
});
test('adopts existing container without overwriting tokens/persona/history/config, and persists selection', async t => {
  const f = fixture(t); const original = fs.readFileSync(f.configPath, 'utf8');
  const task = f.d.start(consent); assert.equal(task.state, 'running');
  assert.throws(() => f.d.start(consent), /busy/);
  const end = await f.d.settled();
  assert.equal(end.state, 'succeeded'); assert.equal(end.result.adopted, true); assert.equal(end.result.credentialsChanged, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  assert.deepEqual(readDeploymentSelection(path.join(f.dataDir, 'gateway-deployment.json')), { backend: 'snowluma', mode: 'docker', container: 'snowluma' });
  const call = f.calls.find(x => x[0] === 'installer')[1]; assert.equal(call.adoptExisting, true); assert.equal(call.pull, undefined);
  assert.equal(f.selected, 1); assert.ok(!JSON.stringify(end).includes('private'));
});
test('fresh Linux deployment uses new private state and preserves unrelated bot config with private backup', async t => {
  const f = fixture(t, { existing: false, platform: 'linux' });
  f.d.start(consent); const end = await f.d.settled(); assert.equal(end.state, 'succeeded'); assert.equal(end.result.manualUpstreamConsentRequired, true);
  const input = f.calls.find(x => x[0] === 'installer')[1]; assert.equal(input.dataDir, undefined); assert.equal(input.namedVolumes, true); assert.equal(input.publicDesktop, false); assert.equal(input.pull, true);
  const config = JSON.parse(fs.readFileSync(f.configPath)); assert.deepEqual(config.llm, f.before.llm); assert.deepEqual(config.persona, f.before.persona); assert.deepEqual(config.storage, f.before.storage);
  assert.equal(config.onebot.accessToken, 'a'.repeat(64)); assert.equal(config.onebot.wsAccessToken, 'b'.repeat(64));
  const backups = fs.readdirSync(f.dataDir).filter(n => n.includes('.before-deploy-')); assert.equal(backups.length, 1); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, backups[0]))), f.before);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
});
test('fresh Windows path delegates named-volume install with no NTFS bind or host chown', async t => {
  const f = fixture(t, { existing: false, platform: 'win32' }); f.d.start(consent); assert.equal((await f.d.settled()).state, 'succeeded');
  const input = f.calls.find(x => x[0] === 'installer')[1]; assert.equal(input.platform, 'win32'); assert.equal(input.dataDir, undefined);
});
test('fresh deployment requires independent upstream authorization and injection-risk grants', async t => {
  const f = fixture(t, { existing: false }); f.d.start({ confirm: true });
  const end = await f.d.settled(); assert.equal(end.state, 'failed'); assert.equal(end.reason, 'fresh-install-consent-required'); assert.equal(f.installed, 0);
});
test('missing Docker is never installed without explicit browser permission', async t => {
  let installCalls = 0;
  const f = fixture(t, { prerequisites: { probe: async () => ({ ready: false, stage: 'cli-missing' }), install: async () => { installCalls++; return ready; } } });
  f.d.start(consent); assert.equal((await f.d.settled()).reason, 'docker-install-permission-required'); assert.equal(installCalls, 0);
});
test('Windows reboot/manual-license task resumes only after new browser confirmation without replaying an install blindly', async t => {
  let isReady = false, installs = 0;
  const f = fixture(t, { platform: 'win32', prerequisites: {
    probe: async () => isReady ? ready : { ready: false, stage: 'cli-missing' },
    install: async input => { assert.deepEqual(input, { confirmed: true, installWsl: true }); installs++; return { ready: false, stage: 'restart-required', reason: 'restart-required', needsRestart: true, needsUserAction: true }; },
  } });
  f.d.start({ ...consent, installDocker: true, installWsl: true }); const wait = await f.d.settled();
  assert.equal(wait.state, 'needs_action'); assert.equal(wait.prerequisite.needsRestart, true); assert.equal(f.installed, 0);
  assert.throws(() => f.d.start(consent), /busy/); assert.throws(() => f.d.resume({ confirm: false }));
  isReady = true; f.d.resume({ confirm: true }); const end = await f.d.settled(); assert.equal(end.state, 'succeeded'); assert.equal(installs, 1);
});
test('raw installer failure text, secrets and paths are redacted; disposing fences late continuation', async t => {
  const f = fixture(t, { installer: async () => { throw new Error('raw-secret:/private/host'); } }); f.d.start(consent);
  const end = await f.d.settled(); assert.equal(end.reason, 'operation-failed'); assert.ok(!JSON.stringify(end).includes('raw-secret'));
  f.d.dispose(); assert.throws(() => f.d.start(consent), /disposed/); await assert.rejects(f.d.status(), /disposed/);
});
test('deployment selection rejects oversized, untrusted shape and symlink files', t => {
  const f = fixture(t); const file = path.join(f.dataDir, 'selection.json');
  fs.writeFileSync(file, JSON.stringify({ backend: 'snowluma', mode: 'docker', container: 'bad;command' })); assert.equal(readDeploymentSelection(file), null);
  fs.writeFileSync(file, 'x'.repeat(5000)); assert.equal(readDeploymentSelection(file), null);
});

test('pending fresh deployment recovers credentials instead of ordinary adoption losing fresh tokens', async t => {
  const calls = [], callbacks = [];
  const f = fixture(t, { docker: recoveryDocker(calls), onSelected: async (...args) => callbacks.push(args) });
  fs.writeFileSync(pendingPath(f), JSON.stringify({ container: 'snowluma', id: freshId }));
  const original = fs.readFileSync(f.configPath, 'utf8');
  f.d.start({ confirm: true }); // Recovery does not require another fresh-install grant.
  const end = await f.d.settled();
  assert.equal(end.state, 'succeeded'); assert.equal(end.result.adopted, true);
  assert.equal(end.result.credentialsChanged, true); assert.equal(end.result.manualUpstreamConsentRequired, true);
  assert.ok(calls.some(args => args[3] === '{{.Id}}'));
  assert.ok(calls.some(args => args[0] === 'exec' && args[1] === freshId));
  const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.equal(config.onebot.accessToken, 'a'.repeat(64)); assert.equal(config.onebot.wsAccessToken, 'b'.repeat(64));
  assert.deepEqual(config.llm, f.before.llm); assert.deepEqual(config.persona, f.before.persona); assert.deepEqual(config.storage, f.before.storage);
  const backups = fs.readdirSync(f.dataDir).filter(name => name.includes('.before-deploy-'));
  assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(f.dataDir, backups[0]), 'utf8'), original);
  assert.deepEqual(callbacks, [[{ backend: 'snowluma', mode: 'docker', container: 'snowluma' }, { fresh: true }]]);
  assert.equal(fs.existsSync(pendingPath(f)), false);
});

test('pending fresh ID mismatch fails closed before adoption, credential read, or selection', async t => {
  const calls = [];
  const f = fixture(t, { docker: recoveryDocker(calls, 'd'.repeat(64)) });
  const pending = JSON.stringify({ container: 'snowluma', id: freshId });
  fs.writeFileSync(pendingPath(f), pending);
  const original = fs.readFileSync(f.configPath, 'utf8');
  f.d.start(consent); const end = await f.d.settled();
  assert.equal(end.state, 'failed'); assert.equal(end.reason, 'fresh-deployment-recovery-required');
  assert.equal(f.installed, 0); assert.equal(f.selected, 0); assert.equal(fs.existsSync(selectionPath(f)), false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original); assert.equal(fs.readFileSync(pendingPath(f), 'utf8'), pending);
  assert.equal(calls.filter(args => args[0] === 'exec').length, 0);
});

test('ambiguous pending fresh null ID never becomes an ordinary existing adoption', async t => {
  const calls = [];
  const f = fixture(t, { docker: recoveryDocker(calls) });
  const pending = JSON.stringify({ container: 'snowluma', id: null });
  fs.writeFileSync(pendingPath(f), pending);
  const original = fs.readFileSync(f.configPath, 'utf8');
  f.d.start(consent); const end = await f.d.settled();
  assert.equal(end.state, 'failed'); assert.equal(end.reason, 'fresh-deployment-recovery-required');
  assert.equal(f.installed, 0); assert.equal(f.selected, 0); assert.equal(fs.existsSync(selectionPath(f)), false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original); assert.equal(fs.readFileSync(pendingPath(f), 'utf8'), pending);
  assert.equal(calls.filter(args => args[0] === 'exec').length, 0);
});

test('onSelected failure preserves fresh pending identity and a later start restores tokens and retries callback', async t => {
  const calls = [], callbacks = []; let exists = false, callbackAttempts = 0;
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'ls') return exists ? 'snowluma\n' : '';
    if (args[0] === 'container' && args[1] === 'inspect') return args[3] === '{{.Id}}' ? freshId : 'true';
    if (args[0] === 'exec') return onebot();
    throw new Error('unexpected Docker operation');
  };
  const f = fixture(t, { docker, installer: async input => {
    calls.push(['installer', input]);
    if (exists) return { adopted: true, alreadyRunning: true };
    exists = true; return { created: true, started: true, id: freshId };
  }, onSelected: async (...args) => {
    callbacks.push(args); if (++callbackAttempts === 1) throw new Error('private callback failure');
  } });
  f.d.start(consent); const failed = await f.d.settled();
  assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'operation-failed');
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath(f), 'utf8')), { container: 'snowluma', id: freshId });
  // Even if the bot config changes between attempts, pending identity forces
  // authoritative credential recovery rather than a credential-preserving adopt.
  const changed = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  changed.onebot.accessToken = 'intermediate-private'; changed.onebot.wsAccessToken = 'intermediate-private';
  fs.writeFileSync(f.configPath, JSON.stringify(changed));
  f.d.start({ confirm: true }); const end = await f.d.settled();
  assert.equal(end.state, 'succeeded'); assert.equal(end.result.credentialsChanged, true);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).onebot.accessToken, 'a'.repeat(64));
  assert.equal(callbackAttempts, 2); assert.ok(callbacks.every(([, context]) => context.fresh === true));
  assert.equal(calls.filter(args => args[0] === 'exec').length, 2);
  assert.equal(calls.filter(args => args[0] === 'installer')[1][1].adoptExisting, true);
  assert.equal(fs.existsSync(pendingPath(f)), false);
});

test('process-global lease survives dispose/recreate and prevents a replacement manager overlapping installer', async t => {
  const entered = deferred(), finish = deferred(); let secondInstalls = 0, callbacks = 0;
  const f = fixture(t, { installer: async () => { entered.resolve(); await finish.promise; return { adopted: true }; }, onSelected: async () => { callbacks++; } });
  const first = f.d.start(consent); await entered.promise; f.d.dispose();
  const next = createDeployment({ dataDir: f.dataDir, configPath: f.configPath, docker: recoveryDocker([]), prerequisites: { probe: async () => ready }, installer: async () => { secondInstalls++; return { adopted: true }; } });
  t.after(() => next.dispose());
  const observed = await next.status(); assert.equal(observed.task.id, first.id); assert.equal(observed.task.state, 'running');
  assert.throws(() => next.start(consent), /deployment-busy/);
  assert.equal(secondInstalls, 0); assert.equal(callbacks, 0);
  finish.resolve(); const stopped = await f.d.settled(); assert.equal(stopped.reason, 'deployment-disposed');
  assert.equal(fs.existsSync(selectionPath(f)), false); assert.equal(callbacks, 0);
  next.start(consent); assert.equal((await next.settled()).state, 'succeeded'); assert.equal(secondInstalls, 1);
});

test('disposed in-flight fresh installer journals verified ID only, then a reloaded coordinator recovers credentials', async t => {
  const entered = deferred(), finish = deferred(), calls = []; let exists = false, oldCallbacks = 0, newCallbacks = 0;
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'ls') return exists ? 'snowluma\n' : '';
    if (args[0] === 'container' && args[1] === 'inspect') return args[3] === '{{.Id}}' ? freshId : 'true';
    if (args[0] === 'exec') return onebot();
    throw new Error('unexpected Docker operation');
  };
  const f = fixture(t, { docker, installer: async () => {
    entered.resolve(); await finish.promise; exists = true; return { created: true, started: true, id: freshId };
  }, onSelected: async () => { oldCallbacks++; } });
  const original = fs.readFileSync(f.configPath, 'utf8');
  f.d.start(consent); await entered.promise;
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath(f), 'utf8')), { container: 'snowluma', id: null });
  f.d.dispose();
  // A distinct module instance models plugin HMR, not just another factory call.
  const reloaded = await import('../deployment.js?fresh-reload-recovery-test');
  const replacement = reloaded.createDeployment({ dataDir: f.dataDir, configPath: f.configPath, docker, prerequisites: { probe: async () => ready }, installer: async options => {
    assert.equal(options.adoptExisting, true); return { adopted: true, alreadyRunning: true };
  }, onSelected: async (_selection, context) => { assert.equal(context.fresh, true); newCallbacks++; } });
  t.after(() => replacement.dispose());
  assert.throws(() => replacement.start(consent), /deployment-busy/);
  finish.resolve(); const disposed = await f.d.settled();
  assert.equal(disposed.state, 'failed'); assert.equal(disposed.reason, 'deployment-disposed');
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath(f), 'utf8')), { container: 'snowluma', id: freshId });
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original); assert.equal(fs.existsSync(selectionPath(f)), false);
  assert.equal(oldCallbacks, 0); assert.equal(newCallbacks, 0);
  assert.equal(calls.filter(args => args[0] === 'exec').length, 0);
  assert.equal(fs.readdirSync(f.dataDir).filter(name => name.includes('.before-deploy-')).length, 0);
  replacement.start({ confirm: true }); const recovered = await replacement.settled();
  assert.equal(recovered.state, 'succeeded'); assert.equal(recovered.result.credentialsChanged, true);
  const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.equal(config.onebot.accessToken, 'a'.repeat(64)); assert.equal(config.onebot.wsAccessToken, 'b'.repeat(64));
  assert.equal(oldCallbacks, 0); assert.equal(newCallbacks, 1); assert.equal(fs.existsSync(pendingPath(f)), false);
});

for (const pauseAt of ['probe', 'install', 'existing', 'installer', 'fresh-credentials']) test(`dispose fences post-await ${pauseAt} continuation before configuration write or callback`, async t => {
  const entered = deferred(), finish = deferred(); let callbacks = 0, installCalls = 0;
  const pause = async value => { entered.resolve(); await finish.promise; return value; };
  const calls = [];
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'ls') {
      const names = pauseAt === 'fresh-credentials' ? '' : 'snowluma\n';
      return pauseAt === 'existing' ? pause(names) : names;
    }
    if (args[0] === 'container' && args[1] === 'inspect') return 'true';
    if (args[0] === 'exec') return pause(onebot());
    throw new Error('unexpected Docker operation');
  };
  const f = fixture(t, { docker, prerequisites: {
    probe: async () => pauseAt === 'probe' ? pause(ready) : pauseAt === 'install' ? { ready: false, installed: false, stage: 'cli-missing' } : ready,
    install: async () => { installCalls++; return pause(ready); },
  }, installer: async () => {
    const result = pauseAt === 'fresh-credentials' ? { created: true, started: true, id: freshId } : { adopted: true };
    return pauseAt === 'installer' ? pause(result) : result;
  }, onSelected: async () => { callbacks++; } });
  const original = fs.readFileSync(f.configPath, 'utf8');
  f.d.start({ ...consent, installDocker: pauseAt === 'install' }); await entered.promise;
  f.d.dispose(); finish.resolve();
  const end = await f.d.settled(); assert.equal(end.state, 'failed'); assert.equal(end.reason, 'deployment-disposed');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original); assert.equal(fs.existsSync(selectionPath(f)), false); assert.equal(callbacks, 0);
  assert.equal(fs.readdirSync(f.dataDir).filter(name => name.includes('.before-deploy-')).length, 0);
  assert.equal(installCalls, pauseAt === 'install' ? 1 : 0);
});

test('installed Docker engine not ready needs manual action without installation permission and resumes without install', async t => {
  let isReady = false, installs = 0;
  const f = fixture(t, { prerequisites: {
    probe: async () => isReady ? ready : { ready: false, installed: true, packageInstalled: true, stage: 'daemon-not-ready', reason: 'start-docker-manually' },
    install: async () => { installs++; return ready; },
  } });
  f.d.start(consent); const end = await f.d.settled();
  assert.equal(end.state, 'needs_action'); assert.equal(end.reason, 'start-docker-manually'); assert.equal(end.prerequisite.needsUserAction, true);
  assert.equal(installs, 0); assert.equal(f.installed, 0); assert.equal(f.selected, 0);
  assert.throws(() => f.d.start(consent), /deployment-busy/);
  isReady = true; f.d.resume({ confirm: true }); assert.equal((await f.d.settled()).state, 'succeeded'); assert.equal(installs, 0);
});

test('missing WSL permission fails retryably so a new start can grant installWsl', async t => {
  const installs = [];
  const f = fixture(t, { platform: 'win32', prerequisites: {
    probe: async () => ({ ready: false, installed: true, packageInstalled: true, stage: 'wsl-missing' }),
    install: async input => { installs.push(input); return input.installWsl ? ready : { ready: false, installed: true, stage: 'wsl-install-approval-required', reason: 'wsl-install-approval-required' }; },
  } });
  f.d.start({ ...consent, installDocker: true, installWsl: false }); const denied = await f.d.settled();
  assert.equal(denied.state, 'failed'); assert.equal(denied.reason, 'wsl-install-approval-required');
  assert.equal(f.installed, 0); assert.throws(() => f.d.resume({ confirm: true }), /deployment-not-resumable/);
  f.d.start({ ...consent, installDocker: true, installWsl: true }); const end = await f.d.settled();
  assert.equal(end.state, 'succeeded'); assert.deepEqual(installs, [{ confirmed: true, installWsl: false }, { confirmed: true, installWsl: true }]);
});
