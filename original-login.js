import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { command } from './runtime.js';

const ORIGINAL_PATH = '/vnc.html?autoconnect=1&resize=scale';
const MAX_PAGE_BYTES = 256 * 1024;
const unavailable = () => new Error('原版 SnowLuma noVNC 尚未就绪；请检查所选容器已有的 6081/tcp 发布和原版 VNC 密码配置');
const cancelled = () => new Error('原版 SnowLuma 登录检查已取消');
const passwordUnavailable = () => new Error('无法安全读取并核实原版 VNC 密码；请检查所选容器的 VNC 密码配置');
const MAX_ENV_BYTES = 64 * 1024;

// Credential commands deliberately do not use runtime.command: it combines
// stderr with stdout and includes that content in errors. Never log either pipe.
function credentialCommand(bin, args, { signal, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
    catch { reject(passwordUnavailable()); return; }
    const chunks = [];
    let size = 0, stderrSize = 0, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); for (const chunk of chunks) chunk.fill(0); reject(passwordUnavailable()); }
      else { const output = Buffer.concat(chunks, size); for (const chunk of chunks) chunk.fill(0); resolve(output); }
    };
    const abort = () => finish(passwordUnavailable());
    const timer = setTimeout(abort, timeoutMs); timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      if (settled) { chunk.fill(0); return; }
      size += chunk.length;
      if (size > maxOutputBytes) { chunk.fill(0); finish(passwordUnavailable()); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderrSize += chunk.length; chunk.fill(0); if (stderrSize > 16384) finish(passwordUnavailable()); });
    child.stdout.on('error', abort); child.stderr.on('error', abort);
    child.once('error', abort);
    child.once('close', code => finish(code === 0 && !signal.aborted ? null : passwordUnavailable()));
    if (signal.aborted) abort();
  });
}

function effectivePassword(output) {
  if ((typeof output !== 'string' && !Buffer.isBuffer(output)) || Buffer.byteLength(output) > MAX_ENV_BYTES) throw passwordUnavailable();
  const env = JSON.parse(output.toString());
  if (!Array.isArray(env) || env.some(value => typeof value !== 'string')) throw passwordUnavailable();
  const values = env.filter(value => value.startsWith('VNC_PASSWD='));
  if (values.length > 1) throw passwordUnavailable();
  if (!values.length || values[0] === 'VNC_PASSWD=') return null;
  const value = values[0].slice('VNC_PASSWD='.length);
  // Original VNC authentication uses at most eight bytes. Restrict to printable
  // ASCII so a browser's encoding cannot change their meaning; never invent a default.
  if (!/^[\x20-\x7e]{1,4096}$/.test(value)) throw passwordUnavailable();
  return value.slice(0, 8);
}

function vncKey() {
  // Classic VNC password-file obfuscation uses this public fixed DES key.
  // Triple-DES with the same key three times is single DES, available without
  // enabling OpenSSL's legacy cipher provider. VNC reverses every key byte.
  const key = Buffer.from([23, 82, 107, 6, 35, 78, 88, 7]).map(value => {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (value & 1); value >>>= 1; }
    return reversed;
  });
  return Buffer.concat([key, key, key]);
}

function passwordFromFile(output) {
  if (!Buffer.isBuffer(output) || output.length !== 8) throw passwordUnavailable();
  const decipher = createDecipheriv('des-ede3-ecb', vncKey(), null);
  decipher.setAutoPadding(false);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(output), decipher.final()]);
    const zero = plain.indexOf(0), end = zero < 0 ? 8 : zero;
    if (!end || !plain.subarray(0, end).every(value => value >= 32 && value <= 126) || !plain.subarray(end).every(value => value === 0)) throw passwordUnavailable();
    return plain.subarray(0, end).toString('ascii');
  } finally { plain?.fill(0); }
}

function passwordMatches(password, output) {
  if (!Buffer.isBuffer(output) || output.length !== 8) return false;
  const plain = Buffer.alloc(8); plain.write(password, 'ascii');
  const cipher = createCipheriv('des-ede3-ecb', vncKey(), null);
  cipher.setAutoPadding(false);
  let expected;
  try { expected = Buffer.concat([cipher.update(plain), cipher.final()]); return timingSafeEqual(expected, output); }
  finally { plain.fill(0); expected?.fill(0); }
}
const portNumber = value => /^[0-9]{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : null;

// Race even injected implementations that do not observe AbortSignal; consume late rejection.
function until(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(cancelled());
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', cancel); resolve(value);
    }, error => {
      signal.removeEventListener('abort', cancel); reject(error);
    });
  });
}

function publishedPort(output) {
  if (typeof output !== 'string' && !Buffer.isBuffer(output)) throw unavailable();
  const text = output.toString();
  if (text.length > 32768) throw unavailable();
  const first = text.trim().split(/\r?\n/, 1)[0];
  const binding = /^(\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:.]+):([0-9]{1,5})$/.exec(first);
  if (!binding) throw unavailable();
  const host = binding[1].startsWith('[') ? binding[1].slice(1, -1) : binding[1];
  const port = portNumber(binding[2]);
  if (!isIP(host) || !port) throw unavailable();
  return port;
}

async function probe(fetcher, port, signal) {
  // The destination is never configurable and redirects are never followed.
  const response = await until(Promise.resolve().then(() => fetcher(`http://127.0.0.1:${port}/vnc.html`, {
    method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
    headers: { accept: 'text/html' },
  })), signal);
  let reader;
  try {
    if (!response?.ok || response.redirected) throw unavailable();
    const length = response.headers?.get('content-length');
    if (length !== null && length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_PAGE_BYTES)) throw unavailable();
    const type = response.headers?.get('content-type');
    if (type && !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(type)) throw unavailable();
    if (!response.body?.getReader) throw unavailable();
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await until(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) throw unavailable();
      chunks.push(Buffer.from(value));
    }
    const page = Buffer.concat(chunks, size).toString('utf8');
    if (!/<(?:html|head|title|script|div)\b/i.test(page) || !/\bnoVNC(?:\b|_)/i.test(page)) throw unavailable();
  } finally {
    // Do not wait on a broken/oversized peer to acknowledge cancellation.
    try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}

/**
 * Discover only the ORIGINAL, already-published Docker noVNC service. This does not
 * start a service, publish ports, or replace its separate VNC authentication.
 * password() is a separate user-only credential operation; never call it from
 * status, discovery, redirect construction, logs, or a model tool.
 */
export function createOriginalLogin({ mode, container, run, fetcher = fetch }) {
  const targetRun = run || command;
  const passwordRun = run || credentialCommand;
  if (mode === 'docker' && (typeof container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container))) throw new Error('原版登录的容器名无效');
  const lifetime = new AbortController();
  async function target({ signal } = {}) {
    if (mode !== 'docker') return null;
    const active = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    if (active.aborted) throw cancelled();
    let timer;
    try {
      const commandTimeout = new AbortController();
      timer = setTimeout(() => commandTimeout.abort(), 8000);
      const commandSignal = AbortSignal.any([active, commandTimeout.signal]);
      const output = await until(Promise.resolve().then(() => targetRun('docker', ['port', container, '6081/tcp'], { timeoutMs: 8000, signal: commandSignal })), commandSignal);
      clearTimeout(timer);
      const port = publishedPort(output);
      const probeTimeout = new AbortController();
      timer = setTimeout(() => probeTimeout.abort(), 4000);
      const probeSignal = AbortSignal.any([active, probeTimeout.signal]);
      await probe(fetcher, port, probeSignal);
      if (active.aborted) throw cancelled();
      return { port, path: ORIGINAL_PATH };
    } catch {
      if (active.aborted) throw cancelled();
      throw unavailable();
    } finally { clearTimeout(timer); }
  }
  async function password({ signal } = {}) {
    const active = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    if (active.aborted) throw cancelled();
    if (mode !== 'docker') throw passwordUnavailable();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 8000);
    const commandSignal = AbortSignal.any([active, timeout.signal]);
    let environment, stored;
    try {
      environment = await until(Promise.resolve().then(() => passwordRun('docker',
        ['inspect', '--format', '{{json .Config.Env}}', container],
        { timeoutMs: 8000, maxOutputBytes: MAX_ENV_BYTES, signal: commandSignal })), commandSignal);
      const configured = effectivePassword(environment);
      if (Buffer.isBuffer(environment)) environment.fill(0);
      environment = null;
      if (commandSignal.aborted) throw cancelled();
      // Fixed path and bounded binary output only; no shell, host path, arbitrary
      // file reader, environment dump, or remote service configuration is exposed.
      stored = await until(Promise.resolve().then(() => passwordRun('docker',
        ['exec', container, 'head', '-c', '8', '/root/.vnc/passwd'],
        { timeoutMs: 8000, maxOutputBytes: 8, signal: commandSignal })), commandSignal);
      if (commandSignal.aborted) throw cancelled();
      // Some original images generate the effective password file when the env
      // is unset/empty. Read that actual fixed source, never derive a default.
      const value = configured ?? passwordFromFile(stored);
      if (!passwordMatches(value, stored)) throw passwordUnavailable();
      return { ok: true, password: value };
    } catch {
      if (active.aborted) throw cancelled();
      throw passwordUnavailable();
    } finally {
      clearTimeout(timer);
      if (Buffer.isBuffer(environment)) environment.fill(0);
      if (Buffer.isBuffer(stored)) stored.fill(0);
    }
  }
  return { target, password, dispose() { lifetime.abort(); } };
}

/** Pure redirect construction; the parent must call trusted Connection first. */
export function originalRedirect(req, target) {
  const host = req?.headers?.host;
  const match = typeof host === 'string' && host.length <= 320 && /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(host);
  if (!match || (match[2] !== undefined && !portNumber(match[2]))) throw new Error('原版登录请求 Host 无效');
  const name = match[1];
  if (name.startsWith('[')) {
    if (isIP(name.slice(1, -1)) !== 6) throw new Error('原版登录请求 Host 无效');
  } else {
    const labels = name.replace(/\.$/, '').split('.');
    if (name.length > 254 || labels.some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) throw new Error('原版登录请求 Host 无效');
  }
  if (!target || !Number.isInteger(target.port) || !portNumber(String(target.port)) || target.path !== ORIGINAL_PATH) throw new Error('原版登录目标无效');
  let url;
  try { url = new URL(`${req.socket?.encrypted ? 'https' : 'http'}://${host}`); }
  catch { throw new Error('原版登录请求 Host 无效'); }
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('原版登录请求 Host 无效');
  url.port = String(target.port);
  url.pathname = '/vnc.html';
  url.search = '?autoconnect=1&resize=scale';
  return url.href;
}
