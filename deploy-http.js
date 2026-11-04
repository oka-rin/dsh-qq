import { assertLoginRequest } from './login.js';

const ROOT = '/dsh-qq/deploy';
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const BOOLEAN_FIELDS = new Set(['confirm', 'installDocker', 'installWsl', 'authorized', 'injectionRisk', 'publicDesktop', 'allowExistingPublicPorts']);

// Only errors created by this transport are safe to expose. Backend failures may
// contain subprocess output, credentials or private host paths.
class RequestError extends Error {}
const cancelled = () => new RequestError('部署请求已取消；宿主任务状态请刷新核查');

function until(promise, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(cancelled()); };
    // Observe late rejections even when the request was cancelled before waiting.
    const pending = Promise.resolve(promise);
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { reject(cancelled()); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Independent from any general-purpose body reader: 4 KiB and ten seconds even
// for chunked/slow uploads. This signal belongs to request IO, not deployment.
function readBody(req, signal) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', abort);
      signal.removeEventListener('abort', abort);
      chunks.length = 0;
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const fail = () => finish(new RequestError('无法读取部署请求'));
    const abort = () => finish(cancelled());
    const data = chunk => {
      size += chunk.length;
      if (size > 4096) finish(new RequestError('部署请求体过大')); else chunks.push(chunk);
    };
    const end = () => {
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { finish(new RequestError('请求体必须是有效 JSON')); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) finish(new RequestError('部署请求必须是 JSON 对象'));
      else finish(null, value);
    };
    const timer = setTimeout(() => finish(new RequestError('读取部署请求超时')), 10_000);
    timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || req.aborted) abort();
  });
}

function validate(input, resume) {
  for (const [key, value] of Object.entries(input)) {
    if (resume ? key !== 'confirm' : !BOOLEAN_FIELDS.has(key) && key !== 'image') throw new RequestError('部署请求包含不支持的字段');
    if (key === 'image') {
      if (typeof value !== 'string' || value.length > 200) throw new RequestError('部署镜像必须是不超过 200 字符的字符串');
    } else if (typeof value !== 'boolean') throw new RequestError('部署确认选项必须是布尔值');
  }
  if (input.confirm !== true) throw new RequestError('部署操作需要明确确认');
  return input;
}

/** Browser-only consent surface. Never register deployment as a model tool. */
export function registerDeploymentHttp({ ctx, deployment }) {
  let disposed = false;
  const requests = new Set(), unregister = [];
  const send = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    const json = JSON.stringify(value);
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(json);
  };
  function rejection(req) {
    try {
      if (!ctx.connection) return 403;
      const result = ctx.connection.requestRejection(req);
      return result === undefined ? undefined : result === 401 ? 401 : 403;
    } catch { return 403; }
  }
  function mutation(req) {
    // Connection has already checked authentication and this Host/Origin pair.
    // The trusted override supports HTTPS proxies without trusting forwarded data.
    try { assertLoginRequest(req, { trustedOrigin: req.headers.origin }); }
    catch { throw new RequestError('部署操作只接受浏览器同源 POST JSON 请求'); }
  }
  function exact(path, handler) {
    ctx.effect(() => {
      const remove = ctx.webServer.register({ kind: 'exact', path: ROOT + path, handler: async (req, res) => {
        const denied = rejection(req);
        if (denied) { send(res, denied, { ok: false, error: '需要已认证的 DSH 浏览器会话' }); return; }
        if (disposed || (req.url || '').includes('?')) { send(res, 400, { ok: false, error: '部署入口不可用或请求路径无效' }); return; }
        if (requests.size >= 8) { send(res, 429, { ok: false, error: '部署请求过多，请稍后重试' }); return; }
        const ctrl = new AbortController(); requests.add(ctrl);
        const abort = () => { if (!res.writableEnded) ctrl.abort(); };
        const timer = setTimeout(() => ctrl.abort(), 60_000); timer.unref?.();
        res.once('close', abort);
        try {
          await until(Promise.resolve().then(() => {
            if (disposed || ctrl.signal.aborted) throw cancelled();
            return handler(req, res, ctrl.signal);
          }), ctrl.signal);
        } catch (error) {
          if (!res.headersSent) send(res, 400, { ok: false, error: error instanceof RequestError ? error.message : '部署请求失败；请刷新状态核查宿主任务' });
          else if (!res.writableEnded) res.end();
        } finally { clearTimeout(timer); res.off('close', abort); requests.delete(ctrl); }
      } });
      let removed = false;
      const once = () => { if (!removed) { removed = true; remove(); } };
      unregister.push(once);
      return once;
    });
  }
  exact('/status', async (req, res, signal) => {
    if (req.method !== 'GET') throw new RequestError('只接受 GET');
    // The manager owns status projection and lifecycle; reads never start work.
    const value = await until(deployment.status(), signal);
    if (!signal.aborted && !disposed) send(res, 200, value);
  });
  for (const action of ['start', 'resume']) exact('/' + action, async (req, res, signal) => {
    mutation(req);
    const input = validate(await readBody(req, signal), action === 'resume');
    if (signal.aborted || disposed || res.destroyed) throw cancelled();
    // Never forward an HTTP signal or call deployment.dispose(): losing a tab
    // cancels its IO only. The parent manager owns ongoing host operations.
    const task = await until(deployment[action](input), signal);
    if (!signal.aborted && !disposed) send(res, 200, { ok: true, task });
  });
  return { dispose() {
    if (disposed) return;
    disposed = true;
    for (const ctrl of requests) ctrl.abort();
    for (const remove of unregister) remove();
  } };
}
