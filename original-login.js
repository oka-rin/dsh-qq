import { isIP } from 'node:net';
import { command } from './runtime.js';

const ORIGINAL_PATH = '/vnc.html?autoconnect=1&resize=scale';
const MAX_PAGE_BYTES = 256 * 1024;
const unavailable = () => new Error('原版 SnowLuma noVNC 尚未就绪；请检查所选容器已有的 6081/tcp 发布和原版 VNC 密码配置');
const cancelled = () => new Error('原版 SnowLuma 登录检查已取消');
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
 * start a service, publish ports, read passwords, or replace its separate VNC
 * password authentication. The caller must authenticate/authorize the redirect.
 */
export function createOriginalLogin({ mode, container, run = command, fetcher = fetch }) {
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
      const output = await until(Promise.resolve().then(() => run('docker', ['port', container, '6081/tcp'], { timeoutMs: 8000, signal: commandSignal })), commandSignal);
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
  return { target, dispose() { lifetime.abort(); } };
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
