import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDockerPrerequisites } from './docker-prerequisites.js';
import { runInstaller, dockerCommand, safeError } from './scripts/install-snowluma-docker.mjs';

export const DEFAULT_DEPLOY_IMAGE = 'motricseven7/snowluma@sha256:34b4ec03738a698231cbad39c5650747330f5a96d953494fb6c12e1273974c0b';
const PIN = /^motricseven7\/snowluma@sha256:[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const booleanFields = ['installDocker', 'installWsl', 'authorized', 'injectionRisk', 'publicDesktop', 'allowExistingPublicPorts'];
const safe = value => JSON.parse(JSON.stringify(value));
const issue = code => { throw new Error(code); };
// Plugin reload does not cancel an elevated installer. Retain a process-wide
// lease so a replacement coordinator cannot overlap that operation.
const LEASES = Symbol.for('dsh-qq.deployment.leases');
const leases = globalThis[LEASES] ||= new Map();
const messages = {
  checking: '正在检查宿主 Docker 和所选容器；不会重建已有数据',
  prerequisites: '正在安装或启动 Docker 前置依赖；可能需要管理员/UAC 操作',
  deploying: '正在校验并启动已有容器，或拉取固定镜像创建独立新实例',
  connecting: '正在保存本地接入信息；保留模型、人设、聊天和档案配置',
  done: '部署步骤完成；容器运行不代表 QQ 已登录，请打开对应登录窗口',
  action: '需要宿主机人工操作后继续；不会自动接受 Docker Desktop 或上游许可',
  failed: '部署未完成；现有容器和数据未被删除。新建状态保留供管理员检查',
};

export function readDeploymentSelection(file) {
  try {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 4096) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.backend === 'snowluma' && value.mode === 'docker' && NAME.test(value.container) ? { backend: 'snowluma', mode: 'docker', container: value.container } : null;
  } catch { return null; }
}
function atomicPrivate(file, value) {
  const temp = file + '.tmp-' + randomBytes(8).toString('hex');
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
/** Browser-owned operation coordinator. Never expose start/resume as model tools. */
export function createDeployment({ dataDir, configPath, container = 'snowluma', selected = () => ({ backend: 'snowluma', mode: 'native', container }), platform = process.platform, arch = process.arch,
  prerequisites = createDockerPrerequisites({ platform }), installer = runInstaller, docker: injectedDocker, onSelected = async () => {}, now = Date.now } = {}) {
  if (!NAME.test(container)) issue('invalid-container-name');
  const docker = injectedDocker || ((args, transport = {}) => dockerCommand(args, { ...transport, platform }));
  let task = null, savedInput = null, running = null, disposed = false, statusFlight = null;
  const leaseKey = `${platform}:${path.resolve(dataDir)}`;
  const owner = Symbol('deployment-owner');
  const selectionFile = path.join(dataDir, 'gateway-deployment.json');
  const pendingFile = path.join(dataDir, 'gateway-deployment-pending.json');
  function pendingFresh() {
    try {
      const s = fs.lstatSync(pendingFile);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 4096) issue('fresh-deployment-recovery-required');
      const p = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      if (p.container !== container || (p.id !== null && !/^[a-f0-9]{64}$/.test(p.id))) issue('fresh-deployment-recovery-required');
      return p;
    } catch (error) { if (error.code === 'ENOENT') return null; issue('fresh-deployment-recovery-required'); }
  }
  const snapshot = () => task ? safe({ ...task, elapsedMs: (task.finishedAt || now()) - task.startedAt }) : null;
  function stage(value, message = messages[value] || value) {
    if (disposed) issue('deployment-disposed');
    task.stage = value; task.message = message;
    task.steps.push({ stage: value, message, at: now() });
    if (task.steps.length > 40) task.steps.shift();
  }
  async function existing() {
    const names = await docker(['container', 'ls', '--all', '--format', '{{.Names}}']);
    if (!String(names).split(/\r?\n/).includes(container)) return { exists: false, running: false, container };
    const text = await docker(['container', 'inspect', '--format', '{{json .State.Running}}', container]);
    if (!['true', 'false'].includes(String(text).trim())) issue('invalid-container-inspection');
    return { exists: true, running: String(text).trim() === 'true', container };
  }
  async function status() {
    if (disposed) issue('deployment-disposed');
    if (!statusFlight) statusFlight = (async () => {
      const p = await prerequisites.probe();
      let found = { exists: null, running: false, container };
      if (p.ready) { try { found = await existing(); } catch { found = { ...found, error: 'container-inspection-failed' }; } }
      return { ok: true, host: { platform, arch }, docker: { ...p, state: p.stage, requiresAdmin: p.stage === 'permission-denied' || p.checks?.admin === false }, existing: found,
        defaults: { image: DEFAULT_DEPLOY_IMAGE, container, publicDesktop: false }, selected: selected(), warnings: ['部署目标是运行 DSH 的宿主机，不是浏览器所在电脑', 'HTTP 桌面不加密；Docker Desktop、WSL 与 QQ 扫码可能需要人工操作'] };
    })().finally(() => { statusFlight = null; });
    return { ...await statusFlight, task: leases.get(leaseKey)?.snapshot() || snapshot() };
  }
  function validate(input, resume = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.confirm !== true) issue('browser-confirmation-required');
    const allowed = resume ? ['confirm'] : ['confirm', ...booleanFields, 'image'];
    if (Object.keys(input).some(k => !allowed.includes(k)) || booleanFields.some(k => input[k] !== undefined && typeof input[k] !== 'boolean')) issue('invalid-deployment-request');
    if (!resume && input.image !== undefined && !PIN.test(input.image)) issue('official-image-digest-pin-required');
  }
  async function saveFreshConnection(id) {
    // The official gateway has not logged in yet. Store only its configured local
    // endpoints/tokens, without claiming that HTTP/WS or QQ login were verified.
    const text = await docker(['exec', id, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/app/data/config/onebot.json','utf8'))"]);
    if (disposed) issue('deployment-disposed');
    if (Buffer.byteLength(text) > 65536) issue('invalid-onebot-configuration');
    let onebot; try { onebot = JSON.parse(text); } catch { issue('invalid-onebot-configuration'); }
    const httpServers = onebot.networks?.httpServers, wsServers = onebot.networks?.wsServers;
    if (!Array.isArray(httpServers) || !Array.isArray(wsServers) || httpServers.length !== 1 || wsServers.length !== 1 || httpServers[0].port !== 3000 || wsServers[0].port !== 3001) issue('invalid-onebot-configuration');
    const httpToken = httpServers[0].accessToken, wsToken = wsServers[0].accessToken;
    if (typeof httpToken !== 'string' || typeof wsToken !== 'string' || !/^[a-f0-9]{64}$/.test(httpToken) || !/^[a-f0-9]{64}$/.test(wsToken)) issue('invalid-onebot-configuration');
    const original = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(original);
    config.onebot = { ...config.onebot, gateway: 'snowluma', httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001/event', accessToken: httpToken, wsAccessToken: wsToken };
    if (fs.readFileSync(configPath, 'utf8') !== original) issue('configuration-changed');
    fs.writeFileSync(configPath + '.before-deploy-' + randomBytes(8).toString('hex'), original, { mode: 0o600, flag: 'wx' });
    atomicPrivate(configPath, config);
  }
  async function perform(input) {
    try {
      stage('checking');
      let p = await prerequisites.probe();
      if (!p.ready) {
        if (input.installDocker === true) {
          stage('prerequisites');
          p = await prerequisites.install({ confirmed: true, installWsl: input.installWsl === true });
        } else if (!p.installed && !p.packageInstalled) issue('docker-install-permission-required');
        if (!p.ready) {
          // An omitted WSL grant must be retryable with new explicit consent,
          // not trapped in confirm-only resume with the old false permission.
          if (p.reason === 'wsl-install-approval-required' || p.stage === 'wsl-install-approval-required') issue('wsl-install-approval-required');
          task.state = 'needs_action'; task.reason = p.reason || p.stage; task.prerequisite = { stage: p.stage, reason: p.reason, needsRestart: Boolean(p.needsRestart), needsUserAction: true };
          stage('action'); return;
        }
      }
      if (disposed) issue('deployment-disposed');
      const found = await existing();
      if (disposed) issue('deployment-disposed');
      let recovery = pendingFresh();
      if (recovery && found.exists) {
        if (!recovery.id) issue('fresh-deployment-recovery-required');
        const actualId = String(await docker(['container', 'inspect', '--format', '{{.Id}}', container])).trim();
        if (disposed) issue('deployment-disposed');
        if (actualId !== recovery.id) issue('fresh-deployment-recovery-required');
      } else if (recovery && !found.exists) recovery = null;
      if (!found.exists && (!input.authorized || !input.injectionRisk)) issue('fresh-install-consent-required');
      const options = { mode: 'install', platform, container, image: input.image || DEFAULT_DEPLOY_IMAGE, uid: 59999, gid: 59999,
        httpPort: 3000, wsPort: 3001, webuiPort: 5099, desktopPort: 6081, confirmInstall: true, start: true,
        ...(found.exists ? { adoptExisting: true, allowExistingPublicPorts: input.allowExistingPublicPorts === true } : {
          authorized: true, injectionRisk: true, pull: true, publicDesktop: input.publicDesktop === true, namedVolumes: true,
        }) };
      stage('deploying');
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      // Mark intent before creation. A partially seeded/failed new container must
      // never later masquerade as an ordinary pre-existing successful adoption.
      if (!found.exists) atomicPrivate(pendingFile, { container, id: null });
      const result = await installer(options, docker);
      if (result.created) {
        if (!/^[a-f0-9]{64}$/.test(result.id)) issue('fresh-deployment-recovery-required');
        recovery = { container, id: result.id };
        // An already-running installer survives plugin disposal. Journal only its
        // verified identity before releasing the cross-reload lease, so a new
        // coordinator can recover without writing bot config in the old one.
        atomicPrivate(pendingFile, recovery);
      }
      if (disposed) issue('deployment-disposed');
      stage('connecting');
      if (recovery) await saveFreshConnection(recovery.id);
      if (disposed) issue('deployment-disposed');
      const selection = { backend: 'snowluma', mode: 'docker', container };
      atomicPrivate(selectionFile, selection);
      await onSelected(selection, { fresh: Boolean(recovery) });
      if (disposed) issue('deployment-disposed');
      if (recovery) fs.unlinkSync(pendingFile);
      task.result = { adopted: result.adopted === true, created: result.created === true, started: result.started === true, alreadyRunning: result.alreadyRunning === true, credentialsChanged: Boolean(recovery),
        loginReadyVerified: false, manualUpstreamConsentRequired: Boolean(recovery), container };
      task.state = 'succeeded'; stage('done');
    } catch (error) {
      task.state = 'failed'; task.reason = ['docker-install-permission-required', 'wsl-install-approval-required', 'fresh-install-consent-required', 'configuration-changed', 'fresh-deployment-recovery-required', 'invalid-onebot-configuration', 'deployment-disposed'].includes(error?.message) ? error.message : safeError(error);
      // No upstream stdout/stderr, filesystem paths or credentials cross this boundary.
      if (!disposed) stage('failed');
    } finally { if (task.state !== 'running') task.finishedAt = now(); running = null; if (leases.get(leaseKey)?.owner === owner) leases.delete(leaseKey); }
  }
  function launch(input) {
    task = { id: randomBytes(16).toString('hex'), state: 'running', stage: 'checking', message: messages.checking, startedAt: now(), finishedAt: null, steps: [] };
    savedInput = safe(input);
    leases.set(leaseKey, { owner, snapshot });
    running = Promise.resolve().then(() => perform(savedInput));
    return snapshot();
  }
  return {
    status,
    start(input) { validate(input); if (disposed) issue('deployment-disposed'); if (leases.has(leaseKey) || running || task?.state === 'needs_action') issue('deployment-busy'); return launch(input); },
    resume(input) { validate(input, true); if (disposed || leases.has(leaseKey) || running || task?.state !== 'needs_action' || !savedInput) issue('deployment-not-resumable'); return launch(savedInput); },
    async settled() { await running; return snapshot(); },
    dispose() { disposed = true; savedInput = null; },
  };
}
