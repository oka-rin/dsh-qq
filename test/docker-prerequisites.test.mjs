import test from 'node:test';
import assert from 'node:assert/strict';
import { createDockerPrerequisites, DOCKER_ENDPOINTS, dockerExecutable, runDockerPrerequisiteCommand } from '../docker-prerequisites.js';

const success = stdout => ({ code: 0, stdout, stderr: '' });
const missing = () => ({ code: null, errorCode: 'ENOENT', stdout: '', stderr: '' });
function fixture(options = {}) {
  const calls = [];
  const config = { platform: 'linux', cli: true, engine: 'linux', distro: 'ubuntu', admin: true, installedByApt: false, windows: { build: 22631, client: true, arch: 'AMD64', virtualization: true, reboot: false }, wsl: '2.1.5', wslStatus: true, winget: true, ...options };
  const run = async (command, args, limits) => {
    calls.push({ command, args, limits });
    const override = await config.override?.(command, args, config);
    if (override) return override;
    if (command === '/usr/bin/cat') return success(`NAME=Test\nID=${config.distro}\n`);
    if (command === 'sudo' && args[1] === 'true') return config.admin ? success('') : { code: 1, stderr: 'password required SECRET' };
    if (command === 'sudo') { command = args[1]; args = args.slice(2); }
    if (command === 'docker' || command.endsWith('docker.exe')) {
      if (!config.cli) return missing();
      if (args[0] === '--version') return success('Docker version 27.5.1, build test');
      if (config.engine === 'permission') return { code: 1, stderr: 'permission denied SECRET' };
      if (!config.engine) return { code: 1, stderr: 'Cannot connect to the Docker daemon SECRET' };
      return success(JSON.stringify({ OSType: config.engine }));
    }
    if (command === 'powershell.exe') {
      if (args.at(-1).includes('Get-CimInstance')) return success(JSON.stringify(config.windows));
      config.cli = true;
      return success('');
    }
    if (command === 'winget.exe') return config.winget ? success('v1.9.1') : missing();
    if (command === 'wsl.exe') return args[0] === '--version' ? (config.wsl ? success(`WSL version: ${config.wsl}`) : missing()) : { code: config.wslStatus ? 0 : 1, stdout: '' };
    if (command === 'apt-get' || command === 'env') { if (command === 'env') config.cli = true; return success(''); }
    if (command === 'systemctl') { config.engine = 'linux'; return success(''); }
    throw new Error(`Unexpected command ${command}`);
  };
  const prerequisites = createDockerPrerequisites({ platform: config.platform, run, env: { PATH: '/bin', ProgramFiles: 'C:\\Program Files', DOCKER_CONTEXT: 'evil', DOCKER_HOST: 'tcp://evil:2375', DOCKER_TLS_VERIFY: '1', DOCKER_CONFIG: '/private' }, getuid: () => config.root === false ? 1000 : 0 });
  return { ...prerequisites, calls, config };
}
function assertSafe(value) { assert.doesNotMatch(JSON.stringify(value), /SECRET|tcp:\/\/evil|Cannot connect|password required/); }

test('shared executable helper leaves POSIX and missing Desktop installs on PATH fallback', () => {
  assert.equal(dockerExecutable({ platform: 'linux' }), 'docker');
  assert.equal(dockerExecutable({ platform: 'win32', env: { ProgramFiles: 'Z:\\dsh-qq-nonexistent' } }), 'docker');
});

test('Linux probes local Linux engine without executing installation or saved contexts', async () => {
  const f = fixture(); const result = await f.probe();
  assert.equal(result.ready, true); assert.equal(result.installed, true); assert.equal(result.stage, 'ready');
  assert.equal(result.needsUserAction, false); assert.equal(f.calls.length, 2);
  const info = f.calls[1];
  assert.deepEqual(info.args, ['--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{json .}}']);
  assert.equal(info.limits.env.DOCKER_HOST, DOCKER_ENDPOINTS.linux);
  assert.equal(info.limits.env.DOCKER_CONFIG, undefined); assert.equal(info.limits.env.DOCKER_CONTEXT, undefined);
  assert.equal(info.limits.maxOutputBytes, 32768); assert.equal(info.limits.timeoutMs, 10000);
});

test('missing CLI, stopped daemon, socket permission and Windows-container engine differ', async () => {
  for (const [config, stage, reason] of [
    [{ cli: false }, 'cli-missing', 'docker-cli-missing'],
    [{ engine: null }, 'daemon-unavailable', 'docker-daemon-unavailable'],
    [{ engine: 'permission' }, 'permission-denied', 'docker-permission-denied'],
    [{ engine: 'windows' }, 'wrong-container-os', 'linux-containers-required'],
  ]) {
    const result = await fixture(config).probe(); assert.equal(result.stage, stage); assert.equal(result.reason, reason); assert.equal(result.ready, false); assertSafe(result);
  }
});

test('no confirmation is fail-closed and unsupported OS/distributions do not install', async () => {
  const f = fixture({ cli: false }); assert.equal((await f.install()).stage, 'confirmation-required'); assert.equal(f.calls.length, 0);
  const mac = fixture({ platform: 'darwin' }); assert.equal((await mac.install({ confirmed: true })).stage, 'unsupported'); assert.equal(mac.calls.length, 0);
  const fedora = fixture({ cli: false, distro: 'fedora' }); assert.equal((await fedora.install({ confirmed: true })).reason, 'unsupported-linux-distribution');
  assert.ok(!fedora.calls.some(c => c.command === 'apt-get'));
});

test('confirmed Debian/Ubuntu root install uses distro packages and starts service, then reprobes', async () => {
  const f = fixture({ cli: false }); const result = await f.install({ confirmed: true });
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(c => c.command === 'apt-get' && c.args.includes('update')));
  assert.ok(f.calls.some(c => c.command === 'env' && c.args.includes('docker.io') && c.args.includes('DEBIAN_FRONTEND=noninteractive')));
  assert.ok(f.calls.some(c => c.command === 'systemctl' && c.args.join(' ') === 'enable --now docker.service'));
  assert.doesNotMatch(JSON.stringify(f.calls), /curl|chmod|usermod|bash/);
});

test('non-root only uses sudo -n, missing sudo privileges never prompt browser password', async () => {
  const denied = fixture({ cli: false, root: false, admin: false }); const result = await denied.install({ confirmed: true });
  assert.equal(result.reason, 'administrator-noninteractive-sudo-required'); assertSafe(result);
  assert.deepEqual(denied.calls.at(-1).args, ['-n', 'true']);
  const granted = fixture({ cli: false, root: false }); assert.equal((await granted.install({ confirmed: true })).ready, true);
  const privileged = granted.calls.filter(c => c.command === 'sudo'); assert.ok(privileged.length >= 4); assert.ok(privileged.every(c => c.args[0] === '-n'));
});

test('daemon-only repair does not reinstall and permission failure is not fixed with socket chmod', async () => {
  const stopped = fixture({ engine: null }); assert.equal((await stopped.install({ confirmed: true })).ready, true);
  assert.ok(!stopped.calls.some(c => c.command === 'apt-get'));
  const denied = fixture({ engine: 'permission', override: (command) => command === 'systemctl' ? success('') : null });
  assert.equal((await denied.install({ confirmed: true })).stage, 'permission-denied');
});

test('apt errors, timeouts and injected runner exceptions return only allowlisted reason codes', async () => {
  for (const failure of [{ code: 1, stderr: 'SECRET' }, { code: null, timedOut: true, stderr: 'SECRET' }, { code: null, truncated: true, stderr: 'SECRET' }]) {
    const f = fixture({ cli: false, override: command => command === 'apt-get' ? failure : null });
    const result = await f.install({ confirmed: true }); assert.equal(result.stage, 'install-failed'); assertSafe(result);
  }
  const p = createDockerPrerequisites({ platform: 'linux', run: async () => { throw new Error('SECRET'); } }); assertSafe(await p.probe());
});

test('Windows ready probe pins Desktop Linux named pipe and works before prerequisite checks', async () => {
  const f = fixture({ platform: 'win32' }); const result = await f.probe();
  assert.equal(result.ready, true); assert.equal(f.calls[1].args[1], DOCKER_ENDPOINTS.win32);
  assert.ok(!f.calls.some(c => c.command === 'powershell.exe'));
});

test('Windows Docker CLI fallback uses known ProgramFiles path after PATH miss', async () => {
  const f = fixture({ platform: 'win32', override: command => command === 'docker' ? missing() : null });
  assert.equal((await f.probe()).ready, true);
  assert.ok(f.calls.some(c => c.command === 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'));
});

test('Windows missing App Installer, firmware virtualization, supported build and reboot are explicit', async () => {
  for (const [config, reason] of [
    [{ winget: false }, 'install-windows-app-installer'],
    [{ windows: { build: 22631, client: true, arch: 'AMD64', virtualization: false, reboot: false } }, 'enable-firmware-virtualization'],
    [{ windows: { build: 19044, client: true, arch: 'AMD64', virtualization: true, reboot: false } }, 'unsupported-windows-version'],
    [{ windows: { build: 22621, client: true, arch: 'AMD64', virtualization: true, reboot: false } }, 'unsupported-windows-version'],
    [{ windows: { build: 22631, client: false, arch: 'AMD64', virtualization: true, reboot: false } }, 'unsupported-windows-version'],
    [{ windows: { build: 22631, client: true, arch: 'AMD64', virtualization: true, reboot: true } }, 'windows-reboot-pending'],
  ]) {
    const f = fixture({ platform: 'win32', cli: false, ...config });
    const result = await f.install({ confirmed: true }); assert.equal(result.reason, reason); assert.equal(result.ready, false);
    assert.ok(!f.calls.some(c => c.command === 'powershell.exe' && c.args.at(-1).includes('Start-Process')));
  }
});

test('WSL version check rejects old/unparseable versions and requires separate WSL installation approval', async () => {
  for (const wsl of ['1.2.5', '2.1.4', 'unparseable', null]) {
    const f = fixture({ platform: 'win32', cli: false, wsl });
    assert.equal((await f.probe()).reason, 'wsl2-2.1.5-required');
    assert.equal((await f.install({ confirmed: true })).reason, 'wsl-install-approval-required');
    assert.ok(!f.calls.some(c => c.command === 'powershell.exe' && c.args.at(-1).includes('Start-Process')));
  }
  const f = fixture({ platform: 'win32', cli: false, wsl: '2.10.0' }); assert.equal((await f.probe()).stage, 'cli-missing');
});

test('Windows confirmed install elevates official winget package, never accepts package/source/Desktop terms', async () => {
  const f = fixture({ platform: 'win32', cli: false, engine: null });
  const result = await f.install({ confirmed: true }); assert.equal(result.stage, 'installed-awaiting-start'); assert.equal(result.packageInstalled, true); assert.equal(result.ready, false);
  const elevated = f.calls.find(c => c.command === 'powershell.exe' && c.args.at(-1).includes('Start-Process'));
  const script = elevated.args.at(-1);
  assert.equal(elevated.limits.windowsHide, false); assert.equal(elevated.limits.timeoutMs, 900000);
  assert.match(script, /-Verb RunAs -WindowStyle Normal/); assert.match(script, /'winget.exe'/); assert.match(script, /Docker\.DockerDesktop/); assert.match(script, /'--source','winget'/); assert.match(script, /'--interactive'/);
  assert.doesNotMatch(script, /accept-package-agreements|accept-source-agreements|accept-license|--silent|--disable-interactivity/);
});

test('Windows UAC cancellation, unsigned HRESULT and installer reboot codes do not fake readiness', async () => {
  for (const [code, stage] of [[1223, 'user-action-required'], [-2147023673, 'user-action-required'], [3010, 'restart-required'], [1641, 'restart-required'], [-2147021886, 'restart-required']]) {
    const f = fixture({ platform: 'win32', cli: false, override: (command, args) => command === 'powershell.exe' && args.at(-1).includes('Start-Process') ? { code, stderr: 'SECRET' } : null });
    const result = await f.install({ confirmed: true }); assert.equal(result.stage, stage); assert.equal(result.ready, false); assert.equal(result.needsRestart, stage === 'restart-required'); assertSafe(result);
  }
});

test('WSL installation never installs a distro, reports reboot and never proceeds to Desktop prematurely', async () => {
  const f = fixture({ platform: 'win32', cli: false, wsl: null, override: (command, args) => command === 'powershell.exe' && args.at(-1).includes('Start-Process') ? { code: 3010 } : null });
  const result = await f.install({ confirmed: true, installWsl: true }); assert.equal(result.needsRestart, true); assert.equal(result.ready, false);
  const install = f.calls.filter(c => c.command === 'powershell.exe' && c.args.at(-1).includes('Start-Process'));
  assert.equal(install.length, 1); assert.match(install[0].args.at(-1), /--no-distribution/); assert.doesNotMatch(install[0].args.at(-1), /DockerDesktop|--distribution|Ubuntu/);
});

test('zero WSL exit is rechecked and unresolved setup remains restart/manual action, not ready', async () => {
  const f = fixture({ platform: 'win32', cli: false, engine: null, wsl: null });
  const result = await f.install({ confirmed: true, installWsl: true });
  assert.equal(result.stage, 'user-action-required'); assert.equal(result.ready, false); assert.equal(result.needsRestart, false);
  assert.equal(f.calls.filter(c => c.command === 'powershell.exe' && c.args.at(-1).includes('Start-Process')).length, 1);
});

test('concurrent installs reject duplicate operation instead of launching multiple package managers', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ override: async command => { if (command === 'docker') await gate; } });
  const first = f.install({ confirmed: true }); assert.equal((await f.install({ confirmed: true })).stage, 'busy'); release(); await first;
});

test('default dependency-free runner bounds output, timeout, missing binaries and succeeds shell-free', async () => {
  const successResult = await runDockerPrerequisiteCommand(process.execPath, ['-e', 'process.stdout.write("ok")']); assert.equal(successResult.code, 0); assert.equal(successResult.stdout, 'ok');
  const absent = await runDockerPrerequisiteCommand('dsh-qq-no-such-binary-test', []); assert.equal(absent.errorCode, 'ENOENT');
  const huge = await runDockerPrerequisiteCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxOutputBytes: 100 }); assert.equal(huge.truncated, true); assert.ok(Buffer.byteLength(huge.stdout) <= 100);
  const slow = await runDockerPrerequisiteCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }); assert.equal(slow.timedOut, true);
});
