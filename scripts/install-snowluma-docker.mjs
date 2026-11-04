#!/usr/bin/env node
// Node >=22, dependency-free. Default execution is offline and read-only.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PIN = /^motricseven7\/snowluma@sha256:[a-f0-9]{64}$/;
const TARGETS = ['/app/data', '/app/.config', '/app/.local/share'];
const PORTS = { httpPort: 3000, wsPort: 3001, webuiPort: 5099, desktopPort: 6081 };
const fail = code => { throw new Error(code); };
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const HELP = `SnowLuma Docker preparation (Node >=22; no dependencies)
Default --plan: offline, read-only; does not contact Docker or fetch anything.
--check --adopt-existing --image DIGEST  explicitly inspect Docker read-only;
  requires matching image/mounts/ports; cannot pull, create, modify or start.
--install --confirm-install  authorize explicit machine changes
--confirm-authorized-deployment  assert you independently obtained required written
  authorization for automated deployment; NOT acceptance of upstream agreements
--image motricseven7/snowluma@sha256:<64 lowercase hex>  required install pin
--container NAME            default snowluma; existing containers never replaced
--data-dir /absolute/new-dir  Linux default: fresh independent state (three bind dirs)
--named-volumes             Linux: use fresh private Docker volumes, no --data-dir
  Windows: always named volumes; omit --data-dir. No host chown is needed.
--uid N --gid N             dedicated fresh-state IDs, default 59999
--allow-qq-injection-risk   fresh-only explicit SYS_PTRACE + seccomp=unconfined
--pull                     explicitly permit pull; otherwise cached image only
--start                    explicitly start; default only create/verify
--adopt-existing           verify existing image/mounts/ports; NEVER recreate,
  rewrite configuration, change password, restart policy, ownership or mounts
--allow-existing-public-ports  explicitly acknowledge an adopted public binding
--public-desktop           fresh noVNC 6081 on 0.0.0.0 (unencrypted HTTP risk)
--http-port N --ws-port N --webui-port N --desktop-port N  host ports, defaults
  3000/3001/5099/6081; inside ports unchanged; all loopback except explicit desktop
Fresh: official entrypoint, log-driver none, no password/token env/console, strong
private token/password files. Autoload disabled; no consent file or EULA bypass.
Existing data/containers/services are never stopped/deleted/replaced. Failures
retain new state for manual review. Installation/start does not prove login ready.
Local endpoints only: Linux unix:///var/run/docker.sock; Windows Docker Desktop
  npipe:////./pipe/dockerDesktopLinuxEngine (Linux containers only; no contexts).
Read the upstream EULA, privacy policy, QQ terms and image documentation first.
`;

export function parseArgs(args) {
  const options = { mode: 'plan', container: 'snowluma', uid: 59999, gid: 59999, ...PORTS };
  const values = { '--image': 'image', '--container': 'container', '--data-dir': 'dataDir', '--uid': 'uid', '--gid': 'gid', '--http-port': 'httpPort', '--ws-port': 'wsPort', '--webui-port': 'webuiPort', '--desktop-port': 'desktopPort' };
  const flags = { '--named-volumes': 'namedVolumes', '--confirm-install': 'confirmInstall', '--confirm-authorized-deployment': 'authorized', '--allow-qq-injection-risk': 'injectionRisk', '--pull': 'pull', '--start': 'start', '--adopt-existing': 'adoptExisting', '--allow-existing-public-ports': 'allowExistingPublicPorts', '--public-desktop': 'publicDesktop', '--help': 'help' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail('duplicate-option');
    seen.add(arg);
    if (['--plan', '--install', '--check'].includes(arg)) {
      if (['--plan', '--install', '--check'].some(mode => mode !== arg && seen.has(mode))) fail('conflicting-mode');
      options.mode = arg.slice(2);
    } else if (values[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail('missing-option-value');
      options[values[arg]] = args[++i];
    } else if (flags[arg]) options[flags[arg]] = true;
    else fail('unknown-option');
  }
  return validateOptions(options);
}
export function dockerEndpoint(platform = process.platform) {
  if (platform === 'linux') return 'unix:///var/run/docker.sock';
  if (platform === 'win32') return 'npipe:////./pipe/dockerDesktopLinuxEngine';
  fail('unsupported-platform');
}
const usesNamedVolumes = options => options.platform === 'win32' || options.namedVolumes === true;
function validateOptions(options) {
  if (options.help) return options;
  options.platform ??= process.platform;
  dockerEndpoint(options.platform);
  if (options.platform === 'win32' && options.dataDir) fail('windows-requires-named-volumes');
  if (options.namedVolumes !== undefined && typeof options.namedVolumes !== 'boolean') fail('invalid-named-volumes-option');
  if (options.namedVolumes && options.dataDir) fail('named-volumes-conflict-with-data-dir');
  if (!['plan', 'install', 'check'].includes(options.mode)) fail('invalid-mode');
  if (options.mode === 'check' && (!options.adoptExisting || !PIN.test(options.image || ''))) fail('check-requires-adoption-and-pin');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(options.container || '')) fail('invalid-container-name');
  if (options.image && !PIN.test(options.image)) fail('official-image-digest-pin-required');
  if (options.dataDir && (!path.isAbsolute(options.dataDir) || path.normalize(options.dataDir) !== options.dataDir || options.dataDir === '/' || /[\x00-\x1f,:]/.test(options.dataDir))) fail('invalid-data-path');
  for (const key of ['uid', 'gid', ...Object.keys(PORTS)]) {
    if (!/^[1-9]\d{0,8}$/.test(String(options[key]))) fail('invalid-numeric-option');
    options[key] = Number(options[key]);
    if (options[key] > (key === 'uid' || key === 'gid' ? 2147483647 : 65535)) fail('invalid-numeric-option');
  }
  if (new Set(Object.keys(PORTS).map(key => options[key])).size !== 4) fail('host-port-collision');
  if (options.adoptExisting && (options.dataDir || options.pull || options.injectionRisk || options.publicDesktop)) fail('incompatible-adoption-option');
  if (!options.adoptExisting && options.allowExistingPublicPorts) fail('adoption-option-without-adoption');
  if (options.mode === 'install') {
    if (!options.confirmInstall) fail('explicit-confirm-install-required');
    if (!options.adoptExisting && !options.authorized) fail('written-deployment-authorization-required');
    if (!PIN.test(options.image || '')) fail('official-image-digest-pin-required');
    if (!options.adoptExisting && ((!usesNamedVolumes(options) && !options.dataDir) || !options.injectionRisk)) fail('fresh-data-and-injection-risk-required');
  } else if (options.start || options.pull || options.confirmInstall || options.authorized || options.injectionRisk) fail('install-only-option-in-plan');
  return options;
}
async function pathExists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export async function validateDataPath(dir) {
  if (!dir) return;
  if (await pathExists(dir)) fail('data-directory-already-exists');
  const parent = path.dirname(dir);
  const uid = process.getuid?.();
  let current = path.parse(dir).root;
  for (const component of parent.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== uid)) fail('unsafe-data-parent');
    // /tmp traversal is safe only through a sticky, root-owned directory and
    // only with a separate trusted private parent below it. Never create at /tmp.
    const stickyTmp = current === '/tmp' && current !== parent && st.uid === 0 && Boolean(st.mode & 0o1000);
    if ((st.mode & 0o022) && !stickyTmp) fail('unsafe-data-parent');
  }
}
export function freshConfig(token, websocketToken = randomBytes(32).toString('hex')) {
  const base = { host: '0.0.0.0', path: '/', accessToken: token, messageFormat: 'array', reportSelfMessage: false };
  return { networks: { httpServers: [{ ...base, name: 'http-default', port: 3000 }], wsServers: [{ ...base, name: 'ws-default', port: 3001, role: 'Universal', accessToken: websocketToken }], httpClients: [], wsClients: [] } };
}
export function createArgs(options) {
  const args = ['create', '--name', options.container, '--restart', 'unless-stopped', '--log-driver', 'none', '--shm-size', '1g', '--ulimit', 'nofile=65536:1048576', '--cap-add', 'SYS_PTRACE', '--security-opt', 'seccomp=unconfined'];
  for (const value of [`SNOWLUMA_UID=${options.uid}`, `SNOWLUMA_GID=${options.gid}`, 'SNOWLUMA_ONEBOT_HOST=0.0.0.0', 'SNOWLUMA_WEBUI_HOST=0.0.0.0', 'SNOWLUMA_WEBUI_PORT=5099', 'SNOWLUMA_HOOK_AUTOLOAD=0', 'SNOWLUMA_LOG_LEVEL=error', 'SNOWLUMA_QQ_FLAGS=--disable-gpu --disable-software-rasterizer --disable-gpu-compositing']) args.push('--env', value);
  for (const [key, inside] of Object.entries(PORTS)) args.push('--publish', `${key === 'desktopPort' && options.publicDesktop ? '0.0.0.0' : '127.0.0.1'}:${options[key]}:${inside}`);
  for (const [i, name] of ['data', 'qq-config', 'qq-share'].entries()) {
    if (usesNamedVolumes(options)) {
      if (!Array.isArray(options.volumes) || options.volumes.length !== 3 || new Set(options.volumes).size !== 3 || !options.volumes.every(v => /^snowluma-[a-f0-9]{32}-(data|qq-config|qq-share)$/.test(v))) fail('invalid-fresh-volumes');
      args.push('--mount', `type=volume,src=${options.volumes[i]},dst=${TARGETS[i]},volume-nocopy`);
    } else args.push('--mount', `type=bind,src=${path.join(options.dataDir, name)},dst=${TARGETS[i]}`);
  }
  args.push(options.image);
  return args;
}
export const INSPECT_FORMAT = '{{json .Image}}\n{{json .Mounts}}\n{{json .HostConfig.PortBindings}}\n{{json .State.Running}}\n{{json .HostConfig.Privileged}}\n{{json .Id}}\n{{json .HostConfig.NetworkMode}}';
function parseInspection(text) {
  try {
    const lines = text.trim().split('\n');
    if (lines.length !== 7) fail('invalid-container-inspection');
    const [imageId, mounts, ports, running, privileged, id, networkMode] = lines.map(x => JSON.parse(x));
    return { imageId, mounts, ports, running, privileged, id, networkMode };
  } catch { fail('invalid-container-inspection'); }
}
const SENSITIVE_BIND_ROOTS = new Set(['/', '/root', '/home', '/var', '/var/lib', '/var/log', '/var/cache', '/opt', '/srv', '/mnt', '/media', '/usr', '/usr/local']);
const SENSITIVE_BIND_TREES = ['/etc', '/proc', '/sys', '/dev', '/run', '/var/run', '/boot', '/bin', '/sbin', '/lib', '/lib64', '/var/lib/docker'];
const nestedIn = (child, parent) => child === parent || child.startsWith(parent + '/');
function validateMountSource(mount) {
  const source = mount.Source;
  // These paths belong to the Linux daemon, even when the CLI runs on Windows.
  if (typeof source !== 'string' || !path.posix.isAbsolute(source) || path.posix.resolve(source) !== source || /[\x00-\x1f,:]/.test(source)) fail('unsafe-existing-mount');
  if (mount.Type === 'volume') {
    if (typeof mount.Name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(mount.Name) || !source.endsWith(`/volumes/${mount.Name}/_data`)) fail('unsafe-existing-mount');
  } else if (SENSITIVE_BIND_ROOTS.has(source) || SENSITIVE_BIND_TREES.some(root => nestedIn(source, root))) fail('unsafe-existing-mount');
}
export function verifyExisting(state, options, imageId) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || state.imageId !== imageId) fail('existing-image-mismatch');
  if (!/^[a-f0-9]{64}$/.test(state.id) || typeof state.running !== 'boolean' || state.privileged !== false) fail('unsafe-existing-container');
  if (typeof state.networkMode !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(state.networkMode) || ['host', 'none'].includes(state.networkMode)) fail('unsafe-existing-network-mode');
  if (!Array.isArray(state.mounts) || state.mounts.length !== 3) fail('existing-mounts-mismatch');
  const sources = new Set();
  for (const target of TARGETS) {
    const matches = state.mounts.filter(m => isObject(m) && m.Destination === target);
    if (matches.length !== 1) fail('existing-mounts-mismatch');
    const m = matches[0];
    if (!['volume', 'bind'].includes(m.Type) || m.RW !== true) fail('unsafe-existing-mount');
    validateMountSource(m);
    if ([...sources].some(source => nestedIn(m.Source, source) || nestedIn(source, m.Source))) fail('existing-mounts-not-independent');
    sources.add(m.Source);
  }
  if (!isObject(state.ports) || Object.keys(state.ports).length !== 4) fail('existing-ports-mismatch');
  let publicPorts = false;
  for (const [key, inside] of Object.entries(PORTS)) {
    const mappings = state.ports[`${inside}/tcp`];
    if (!Array.isArray(mappings) || mappings.length < 1 || mappings.length > 2) fail('existing-ports-mismatch');
    for (const binding of mappings) {
      if (!isObject(binding) || binding.HostPort !== String(options[key]) || !['127.0.0.1', '::1', '0.0.0.0', '::', ''].includes(binding.HostIp)) fail('existing-ports-mismatch');
      if (!['127.0.0.1', '::1'].includes(binding.HostIp)) publicPorts = true;
    }
  }
  if (publicPorts && !options.allowExistingPublicPorts) fail('existing-public-ports-require-explicit-risk');
  return { publicPorts, running: state.running, id: state.id };
}
// Kept standalone so this dependency-free CLI can be used without the plugin.
// Desktop may have just been installed after the Host inherited its PATH.
export function dockerExecutable(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'docker';
  const executable = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe');
  return existsSync(executable) ? executable : 'docker';
}
// Bound both pipes, never forward upstream error/output. No shell or command env overrides.
export function dockerCommand(args, { platform = process.platform, input } = {}) {
  const endpoint = dockerEndpoint(platform);
  return new Promise((resolve, reject) => {
    let child, bytes = 0, output = '', settled = false;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(new Error('docker-command-failed')) : resolve(output); };
    const timer = setTimeout(() => { child?.kill('SIGKILL'); finish(true); }, args[0] === 'pull' ? 600000 : 30000);
    // No inherited DOCKER_HOST/CONTEXT/TLS/CONFIG or container credentials. Windows
    // needs SystemRoot to resolve its local CLI and named-pipe transport.
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/' };
    if (platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    try { child = spawn(dockerExecutable(platform), ['--host', endpoint, ...args], { shell: false, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env }); }
    catch { finish(true); return; }
    const consume = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill('SIGKILL'); finish(true); }
      else if (stdout) output += chunk.toString();
    };
    child.stdout.on('data', b => consume(b, true)); child.stderr.on('data', b => consume(b, false));
    child.stdout.on('error', () => finish(true)); child.stderr.on('error', () => finish(true));
    child.on('error', () => finish(true)); child.on('close', code => finish(code !== 0));
    if (input) { child.stdin.on('error', () => finish(true)); child.stdin.end(input); }
  });
}
function configEntries() {
  return [['onebot.json', JSON.stringify(freshConfig(randomBytes(32).toString('hex')), null, 2)], ['runtime.json', JSON.stringify({ webuiHost: '0.0.0.0', webuiPort: 5099, hookAutoLoad: false, trustProxy: '', webuiTls: { enabled: false } }, null, 2)], ['vnc-password', randomBytes(24).toString('base64url')]];
}
// Minimal, bounded USTAR generated only from fixed paths and fresh random secrets.
// docker cp --archive preserves these Linux modes/IDs without NTFS files or chown.
function seedArchive(options, index) {
  const root = ['data', '.config', 'share'][index];
  const blocks = [];
  const append = (name, content, directory = false) => {
    const body = Buffer.from(content || ''), header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    const numeric = (value, offset, size) => {
      const octal = value.toString(8);
      if (octal.length < size) header.write(octal.padStart(size - 1, '0') + '\0', offset, size, 'ascii');
      else { header.writeBigUInt64BE(BigInt(value), offset); header[offset] |= 0x80; }
    };
    numeric(directory ? 0o700 : 0o600, 100, 8);
    numeric(options.uid, 108, 8); numeric(options.gid, 116, 8);
    numeric(body.length, 124, 12); numeric(0, 136, 12);
    header.fill(0x20, 148, 156); header[156] = directory ? 0x35 : 0x30;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  };
  // Extract at the parent: Moby intentionally skips '.' tar headers, so an
  // explicit mount-directory header is required to set its owner/private mode.
  append(root, '', true);
  if (index === 0) {
    append(`${root}/config`, '', true);
    for (const [name, content] of configEntries()) append(`${root}/config/${name}`, content + '\n');
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
async function prepareVolumes(options, docker) {
  const nonce = randomBytes(16).toString('hex');
  options.volumes = ['data', 'qq-config', 'qq-share'].map(name => `snowluma-${nonce}-${name}`);
  // Listing errors are not interpreted as absence. Creation is idempotent in Docker,
  // so check collisions and attest a fresh unpredictable ownership label afterwards.
  for (const name of options.volumes) {
    // Docker name filters are regexes; names are generated from a closed alphabet.
    if ((await docker(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'])).trim()) fail('volume-already-exists');
    const label = `dev.dsh.snowluma.fresh=${nonce}`;
    if ((await docker(['volume', 'create', '--driver', 'local', '--label', label, name])).trim() !== name) fail('invalid-created-volume');
    let volume;
    try { volume = JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .}}', name])); } catch { fail('invalid-created-volume'); }
    if (!isObject(volume) || volume.Name !== name || volume.Driver !== 'local' || volume.Scope !== 'local' || !isObject(volume.Labels) || volume.Labels['dev.dsh.snowluma.fresh'] !== nonce || (volume.Options !== null && (!isObject(volume.Options) || Object.keys(volume.Options).length))) fail('unsafe-created-volume');
  }
}
async function prepareState(options) {
  await fs.mkdir(options.dataDir, { mode: 0o700 });
  for (const name of ['data', 'qq-config', 'qq-share']) await fs.mkdir(path.join(options.dataDir, name), { mode: 0o700 });
  const config = path.join(options.dataDir, 'data', 'config');
  await fs.mkdir(config, { mode: 0o700 });
  const entries = configEntries();
  for (const [name, content] of entries) await fs.writeFile(path.join(config, name), content + '\n', { mode: 0o600, flag: 'wx' });
  // Keep the top-level private directory owned by the installing user. The
  // dedicated runtime UID must not be able to replace bind-mount children.
  // Only known, newly created entries are chowned; never recursively traverse
  // a runtime-owned tree. Ownership is transferred last, files before parents.
  for (const [name] of entries) await fs.chown(path.join(config, name), options.uid, options.gid);
  await fs.chown(config, options.uid, options.gid);
  for (const name of ['data', 'qq-config', 'qq-share']) await fs.chown(path.join(options.dataDir, name), options.uid, options.gid);
}
export async function runInstaller(input, command = dockerCommand) {
  const options = validateOptions({ ...input });
  const docker = (args, transport = {}) => command(args, { ...transport, platform: options.platform });
  await validateDataPath(options.dataDir);
  if (options.mode === 'plan') return { mode: 'plan', offline: true, mutation: false, operation: options.adoptExisting ? 'verify-existing-on-install' : 'prepare-new-on-install', imagePinned: Boolean(options.image), publicDesktop: Boolean(options.publicDesktop), requiresWrittenAuthorization: !options.adoptExisting, termsAccepted: false };
  if ((options.platform === 'win32' || (options.namedVolumes && !options.adoptExisting)) && (await docker(['info', '--format', '{{.OSType}}'])).trim() !== 'linux') fail('linux-container-engine-required');
  const imageOutput = async () => {
    const value = (await docker(['image', 'inspect', options.image, '--format', '{{.Id}}'])).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail('invalid-image-inspection');
    return value;
  };
  if (options.adoptExisting) {
    const imageId = await imageOutput();
    const state = parseInspection(await docker(['container', 'inspect', '--format', INSPECT_FORMAT, options.container]));
    // Validate structure first, then require local bind sources to be their own
    // real paths. Lexical independence alone misses symlinked ancestors/aliases.
    // Named volumes are Docker-managed and keep their existing validation.
    if (!Array.isArray(state.mounts)) fail('existing-mounts-mismatch');
    for (const mount of state.mounts) {
      if (mount?.Type !== 'bind') continue;
      // Windows cannot attest daemon-VM bind sources with host realpath. Never
      // weaken Linux canonical-path checks to support Desktop adoption.
      if (options.platform === 'win32') fail('windows-requires-named-volumes');
      validateMountSource(mount);
      let real;
      try { real = await fs.realpath(mount.Source); } catch { fail('unsafe-existing-mount'); }
      if (real !== mount.Source) fail('unsafe-existing-mount');
    }
    const verified = verifyExisting(state, options, imageId);
    if (options.start && !verified.running) await docker(['start', verified.id]);
    return { mode: options.mode, readOnly: options.mode === 'check', adopted: true, started: Boolean(options.start && !verified.running), alreadyRunning: verified.running, publicPorts: verified.publicPorts, configurationChanged: false, credentialsChanged: false, loginReadyVerified: false };
  }
  const names = await docker(['container', 'ls', '--all', '--format', '{{.Names}}']);
  if (names.split(/\r?\n/).includes(options.container)) fail('container-already-exists');
  if (options.pull) await docker(['pull', options.image]);
  const imageId = await imageOutput();
  // Recheck after Docker/network work; mkdir without recursive never reuses state.
  await validateDataPath(options.dataDir);
  if (usesNamedVolumes(options)) await prepareVolumes(options, docker);
  else await prepareState(options);
  const id = (await docker(createArgs(options))).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) fail('invalid-created-container-id');
  // Verify Docker's created object before the only possible start operation.
  const state = parseInspection(await docker(['container', 'inspect', '--format', INSPECT_FORMAT, id]));
  const verified = verifyExisting(state, { ...options, allowExistingPublicPorts: Boolean(options.publicDesktop) }, imageId);
  if (verified.id !== id || verified.running) fail('unexpected-created-container-state');
  for (const [key, inside] of Object.entries(PORTS)) {
    const bindings = state.ports[`${inside}/tcp`];
    const expectedHost = key === 'desktopPort' && options.publicDesktop ? '0.0.0.0' : '127.0.0.1';
    if (bindings.length !== 1 || bindings[0].HostIp !== expectedHost) fail('created-ports-mismatch');
  }
  for (const [index, name] of ['data', 'qq-config', 'qq-share'].entries()) {
    const m = state.mounts.find(x => x.Destination === TARGETS[index]);
    if (usesNamedVolumes(options)) {
      if (m.Type !== 'volume' || m.Name !== options.volumes[index]) fail('created-mounts-mismatch');
    } else if (m.Type !== 'bind' || m.Source !== path.join(options.dataDir, name)) fail('created-mounts-mismatch');
  }
  if (usesNamedVolumes(options)) {
    for (const [index, target] of TARGETS.entries()) {
      const archive = seedArchive(options, index);
      try { await docker(['cp', '--archive', '-', `${id}:${path.posix.dirname(target)}`], { input: archive }); }
      finally { archive.fill(0); }
    }
  }
  if (options.start) await docker(['start', id]);
  return { mode: 'install', created: true, id, started: Boolean(options.start), imagePinned: true, publicDesktop: Boolean(options.publicDesktop), hookAutoload: false, termsAccepted: false, loginReadyVerified: false };
}
const SAFE_ERRORS = new Set(['invalid-named-volumes-option', 'named-volumes-conflict-with-data-dir', 'unsupported-platform', 'windows-requires-named-volumes', 'linux-container-engine-required', 'invalid-fresh-volumes', 'volume-already-exists', 'invalid-created-volume', 'unsafe-created-volume', 'unsafe-existing-network-mode', 'check-requires-adoption-and-pin', 'duplicate-option', 'conflicting-mode', 'missing-option-value', 'unknown-option', 'invalid-mode', 'invalid-container-name', 'official-image-digest-pin-required', 'invalid-data-path', 'invalid-numeric-option', 'host-port-collision', 'incompatible-adoption-option', 'adoption-option-without-adoption', 'explicit-confirm-install-required', 'written-deployment-authorization-required', 'fresh-data-and-injection-risk-required', 'install-only-option-in-plan', 'data-directory-already-exists', 'unsafe-data-parent', 'invalid-container-inspection', 'existing-image-mismatch', 'unsafe-existing-container', 'existing-mounts-mismatch', 'unsafe-existing-mount', 'existing-mounts-not-independent', 'existing-ports-mismatch', 'existing-public-ports-require-explicit-risk', 'docker-command-failed', 'unsafe-created-state', 'invalid-image-inspection', 'container-already-exists', 'invalid-created-container-id', 'unexpected-created-container-state', 'created-mounts-mismatch', 'created-ports-mismatch', 'node-22-required']);
export function safeError(error) { return SAFE_ERRORS.has(error?.message) ? error.message : 'operation-failed'; }
export async function main(args = process.argv.slice(2), docker = dockerCommand, output = process.stdout, errors = process.stderr) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) fail('node-22-required');
    const options = parseArgs(args);
    if (options.help) { output.write(HELP); return 0; }
    const result = await runInstaller(options, docker);
    output.write(JSON.stringify(result) + '\n');
    if (result.publicPorts || result.publicDesktop) output.write('WARNING: unencrypted public HTTP/desktop bindings; use a trusted network or TLS/SSH tunnel. Existing ports were not changed.\n');
    return 0;
  } catch (error) {
    errors.write(`SnowLuma installer: ${safeError(error)}. No existing service/data was replaced or deleted; an explicitly requested start may have taken effect. Any new state/container is retained for manual review. No credentials are printed.\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
