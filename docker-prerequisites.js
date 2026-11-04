import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Docker Desktop may be installed after this Host inherited its PATH. */
export function dockerExecutable({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return 'docker';
  const executable = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe');
  return existsSync(executable) ? executable : 'docker';
}

export const DOCKER_ENDPOINTS = Object.freeze({
  linux: 'unix:///var/run/docker.sock',
  win32: 'npipe:////./pipe/dockerDesktopLinuxEngine',
});
const MAX_OUTPUT = 32768;
const WINDOWS_HOST = `$ErrorActionPreference='Stop'; $o=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_ComputerSystem; $p=@(Get-CimInstance Win32_Processor); [pscustomobject]@{build=[int]$o.BuildNumber;client=($o.ProductType -eq 1);arch=$env:PROCESSOR_ARCHITECTURE;virtualization=([bool]$c.HypervisorPresent -or [bool]($p | Where-Object VirtualizationFirmwareEnabled));reboot=((Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'))} | ConvertTo-Json -Compress`;

/** Bounded, shell-free subprocess adapter. Never return its output to a browser. */
export function runDockerPrerequisiteCommand(command, args, { timeoutMs = 10000, maxOutputBytes = MAX_OUTPUT, env = process.env, windowsHide = true } = {}) {
  timeoutMs = Math.min(Math.max(Number(timeoutMs) || 10000, 100), 900000);
  maxOutputBytes = Math.min(Math.max(Number(maxOutputBytes) || MAX_OUTPUT, 1), MAX_OUTPUT);
  return new Promise(resolve => {
    let child, timer, finished = false, size = 0, stdout = '', stderr = '', timedOut = false, truncated = false;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, truncated, ...result });
    };
    const kill = () => {
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        // Kill the launch tree, not just powershell/winget's waiting parent.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {}); killer.unref();
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    try { child = spawn(command, args, { shell: false, windowsHide, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env }); }
    catch (error) { finish({ errorCode: error.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED' }); return; }
    const collect = name => chunk => {
      const available = Math.max(0, maxOutputBytes - size);
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (available) { if (name === 'stdout') stdout += bytes.subarray(0, available).toString('utf8'); else stderr += bytes.subarray(0, available).toString('utf8'); }
      if (size > maxOutputBytes) { truncated = true; kill(); finish({ errorCode: 'OUTPUT_LIMIT' }); }
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', error => finish({ errorCode: error.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED' }));
    child.on('close', code => finish({ code }));
    timer = setTimeout(() => { timedOut = true; kill(); finish({ errorCode: 'TIMEOUT' }); }, timeoutMs);
  });
}

function versionAtLeast(raw, minimum) {
  const match = String(raw).match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let i = 0; i < minimum.length; i++) { if (parts[i] !== minimum[i]) return parts[i] > minimum[i]; }
  return true;
}
function exitCode(result) { return Number(result.code) >>> 0; }
function rebootExit(code) { return [3010, 1641, 0x80070bc2, 0x80070669].includes(code); }
function failure(result, fallback) {
  if (result.timedOut) return 'command-timeout';
  if (result.truncated) return 'command-output-limit';
  if (result.errorCode === 'ENOENT') return 'command-not-found';
  return fallback;
}

/**
 * Host-OS prerequisite operations, not a model tool. The parent must obtain a
 * browser user-action grant before calling install. `confirmed` is a second
 * fail-closed check, not a substitute for that grant.
 * Inject run(command, args, {timeoutMs,maxOutputBytes,env,windowsHide?}) ->
 * {code,stdout?,stderr?,errorCode?,timedOut?,truncated?} in tests.
 */
export function createDockerPrerequisites({ platform = process.platform, run = runDockerPrerequisiteCommand, env = process.env, getuid = () => process.getuid?.() } = {}) {
  const endpoint = DOCKER_ENDPOINTS[platform] || null;
  // Do not honor remote contexts, injected TLS endpoints, or config credential helpers.
  const commandEnv = { ...env };
  for (const key of Object.keys(commandEnv)) if (/^DOCKER_/i.test(key)) delete commandEnv[key];
  if (endpoint) commandEnv.DOCKER_HOST = endpoint;
  let busy = false;
  let docker = dockerExecutable({ platform, env });
  async function exec(command, args, timeoutMs = 10000, options = {}) {
    try {
      const result = await run(command, args, { timeoutMs, maxOutputBytes: MAX_OUTPUT, env: commandEnv, ...options });
      if (!result || typeof result !== 'object') return { code: null, errorCode: 'INVALID_RESULT', stdout: '', stderr: '' };
      const rawStdout = String(result.stdout || ''), rawStderr = String(result.stderr || '');
      const stdout = rawStdout.slice(0, MAX_OUTPUT), stderr = rawStderr.slice(0, MAX_OUTPUT - stdout.length);
      return { ...result, stdout, stderr, truncated: result.truncated || rawStdout.length + rawStderr.length > MAX_OUTPUT };
    } catch (error) { return { code: null, errorCode: error?.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED', stdout: '', stderr: '' }; }
  }
  const ok = result => result.code === 0 && !result.timedOut && !result.truncated;
  const powershell = (script, timeoutMs, options) => exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], timeoutMs, options);
  const base = () => ({ platform, endpoint, installed: false, packageInstalled: false, ready: false, stage: 'unsupported', reason: 'unsupported-platform', needsRestart: false, needsUserAction: true, canInstall: false, checks: { cli: false, daemon: false, permissions: null, linuxEngine: false } });
  const state = (previous, stage, reason, extra = {}) => ({ ...previous, stage, reason, needsUserAction: stage !== 'ready', ...extra });

  async function probe() {
    let result = base();
    if (!endpoint) return result;
    let cli = await exec(docker, ['--version']);
    if (platform === 'win32' && cli.errorCode === 'ENOENT') {
      docker = `${env.ProgramFiles || 'C:\\Program Files'}\\Docker\\Docker\\resources\\bin\\docker.exe`;
      cli = await exec(docker, ['--version']);
    }
    result.installed = ok(cli) && /Docker version\s+\d+\./i.test(cli.stdout);
    result.packageInstalled = result.installed;
    result.checks.cli = result.installed;
    let engineFailure = 'docker-cli-missing';
    if (result.installed) {
      const info = await exec(docker, ['--host', endpoint, 'info', '--format', '{{json .}}']);
      if (ok(info)) {
        try {
          const data = JSON.parse(info.stdout);
          if (data && typeof data === 'object' && typeof data.OSType === 'string') {
            result.checks.daemon = true; result.checks.permissions = true;
            result.checks.linuxEngine = data.OSType === 'linux';
            if (result.checks.linuxEngine) return state(result, 'ready', null, { ready: true, needsUserAction: false });
            return state(result, 'wrong-container-os', 'linux-containers-required');
          }
        } catch {}
        engineFailure = 'invalid-engine-response';
      } else {
        const permission = /permission denied|access is denied|access denied|EACCES/i.test(info.stderr);
        result.checks.permissions = permission ? false : null;
        engineFailure = permission ? 'docker-permission-denied' : failure(info, 'docker-daemon-unavailable');
      }
    } else if (cli.errorCode !== 'ENOENT') engineFailure = failure(cli, 'docker-cli-unusable');

    if (platform === 'linux') {
      const release = await exec('/usr/bin/cat', ['/etc/os-release']);
      const distro = ok(release) ? release.stdout.match(/^ID=["']?([a-z0-9_-]+)["']?\s*$/m)?.[1] : null;
      result.checks.distro = ['debian', 'ubuntu'].includes(distro) ? distro : 'unsupported';
      result.canInstall = result.checks.distro !== 'unsupported';
      if (!result.canInstall && !result.installed) return state(result, 'unsupported', 'unsupported-linux-distribution');
      return state(result, !result.installed ? 'cli-missing' : result.checks.permissions === false ? 'permission-denied' : 'daemon-unavailable', engineFailure);
    }

    const host = await powershell(WINDOWS_HOST);
    let details;
    try { if (ok(host)) details = JSON.parse(host.stdout.replace(/^\uFEFF/, '')); } catch {}
    if (!details || typeof details.build !== 'number' || typeof details.virtualization !== 'boolean' || typeof details.reboot !== 'boolean') return state(result, 'user-action-required', failure(host, 'windows-host-check-unavailable'));
    result.checks.windowsBuild = details.build;
    result.checks.virtualization = details.virtualization;
    result.checks.pendingReboot = details.reboot;
    result.needsRestart = details.reboot;
    if (!details.client || details.build < 19045 || (details.build >= 22000 && details.build < 22631) || !['AMD64', 'ARM64'].includes(details.arch) || (details.arch === 'ARM64' && details.build < 26100)) return state(result, 'unsupported', 'unsupported-windows-version');
    result.checks.arch = details.arch;
    const winget = await exec('winget.exe', ['--version']);
    result.checks.winget = ok(winget) && /^v?\d+\.\d+/i.test(winget.stdout.trim());
    const wsl = await exec('wsl.exe', ['--version']);
    const wslStatus = await exec('wsl.exe', ['--status']);
    result.checks.wsl2 = ok(wsl) && versionAtLeast(wsl.stdout.replace(/\0/g, ''), [2, 1, 5]) && ok(wslStatus);
    result.canInstall = result.checks.winget && details.virtualization;
    if (details.reboot) return state(result, 'restart-required', 'windows-reboot-pending');
    if (!details.virtualization) return state(result, 'prerequisite-required', 'enable-firmware-virtualization');
    if (!result.checks.winget) return state(result, 'prerequisite-required', 'install-windows-app-installer');
    if (!result.checks.wsl2) return state(result, 'prerequisite-required', 'wsl2-2.1.5-required');
    return state(result, !result.installed ? 'cli-missing' : result.checks.permissions === false ? 'permission-denied' : 'installed-awaiting-start', engineFailure);
  }

  async function elevatedWindows(command, args) {
    // All arguments here are constants. No browser strings are interpolated.
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath ${quote(command)} -ArgumentList @(${args.map(quote).join(',')}) -Verb RunAs -WindowStyle Normal -Wait -PassThru; exit $p.ExitCode } catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 1603 }`;
    // The elevated child gets its own visible console for winget agreements and
    // installer UI. Its stdin/stdout are not piped back into browser responses.
    return powershell(script, 900000, { windowsHide: false });
  }

  async function install(input = {}) {
    if (input.confirmed !== true) return state(base(), 'confirmation-required', 'browser-approval-required');
    if (busy) return state(base(), 'busy', 'installation-in-progress');
    busy = true;
    try {
      const before = await probe();
      if (before.ready || before.stage === 'unsupported' || before.needsRestart) return before;
      if (platform === 'linux') {
        if (!before.canInstall) return state(before, 'unsupported', 'unsupported-linux-distribution');
        let prefix = [];
        if (getuid() !== 0) {
          const sudo = await exec('sudo', ['-n', 'true']);
          if (!ok(sudo)) return state(before, 'user-action-required', 'administrator-noninteractive-sudo-required');
          prefix = ['sudo', '-n'];
        }
        const admin = (command, args, timeoutMs) => prefix.length ? exec(prefix[0], [...prefix.slice(1), command, ...args], timeoutMs) : exec(command, args, timeoutMs);
        if (before.stage === 'permission-denied') return before;
        if (before.stage === 'wrong-container-os') return before;
        if (!before.installed) {
          const update = await admin('apt-get', ['-qq', 'update'], 300000);
          if (!ok(update)) return state(before, 'install-failed', failure(update, 'apt-update-failed'));
          const packages = await admin('env', ['DEBIAN_FRONTEND=noninteractive', 'apt-get', '-qq', '-o', 'Dpkg::Use-Pty=0', 'install', '-y', 'docker.io'], 900000);
          if (!ok(packages)) return state(before, 'install-failed', failure(packages, 'apt-install-failed'));
        }
        // No group membership grants: the Host identity must have socket access.
        const start = await admin('systemctl', ['enable', '--now', 'docker.service'], 60000);
        const after = await probe();
        if (after.ready || after.stage === 'permission-denied') return after;
        if (!ok(start)) return state(after, 'user-action-required', failure(start, 'docker-service-start-failed'));
        return after;
      }
      if (platform !== 'win32') return before;
      if (!before.checks.virtualization || !before.checks.winget) return before;
      if (!before.checks.wsl2) {
        if (input.installWsl !== true) return state(before, 'user-action-required', 'wsl-install-approval-required');
        // --no-distribution installs no Linux distribution and accepts no distro EULA.
        const wsl = await elevatedWindows('wsl.exe', ['--install', '--no-distribution', '--no-launch']);
        const code = exitCode(wsl);
        if (code === 1223 || code === 0x800704c7) return state(before, 'user-action-required', 'uac-cancelled');
        if (rebootExit(code)) return state(before, 'restart-required', 'wsl-restart-required', { needsRestart: true });
        if (!ok(wsl)) return state(before, 'user-action-required', failure(wsl, 'wsl-install-needs-user-action'));
        // Even exit 0 is not proof that WSL features/firmware are active.
        const after = await probe();
        if (after.ready) return after;
        if (!after.checks.wsl2) return state(after, 'user-action-required', 'wsl-restart-or-manual-setup-required');
        if (after.needsRestart) return after;
      }
      if (!before.installed) {
        const installResult = await elevatedWindows('winget.exe', ['install', '--id', 'Docker.DockerDesktop', '--exact', '--source', 'winget', '--interactive']);
        const code = exitCode(installResult);
        if (code === 1223 || code === 0x800704c7 || code === 0x8a150027) return state(before, 'user-action-required', 'uac-cancelled');
        if (rebootExit(code)) return state(before, 'restart-required', 'docker-desktop-restart-required', { packageInstalled: true, needsRestart: true });
        if (!ok(installResult)) return state(before, 'user-action-required', failure(installResult, 'winget-install-needs-user-action'));
      }
      const after = await probe();
      if (after.ready || after.needsRestart) return after;
      // Docker Desktop's own UI owns its terms, first-run setup and engine switch.
      return state(after, 'installed-awaiting-start', 'open-docker-desktop-accept-terms-start-linux-engine', { packageInstalled: true });
    } finally { busy = false; }
  }
  return { probe, install };
}
