import fs from 'node:fs';
import path from 'node:path';

export const NAPCAT_WEBUI_CONFIG = '/var/lib/napcat/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json';
const UNAVAILABLE = 'NapCat 官方 WebUI 未就绪；请检查已安装的服务和 WebUI 端口';
const TOKEN_ERROR = '无法安全读取 NapCat WebUI token；请检查管理员配置的 WebUI JSON 文件及 token 字段';
export function napcatPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NapCat WebUI 端口必须为 1–65535 的整数');
  return port;
}
export function validNapcatToken(token) {
  return typeof token === 'string' && /^[\x21-\x7e]{16,4096}$/.test(token);
}
/** Fixed same-host HTTP target. No browser-supplied redirect, token, query or path. */
export function napcatRedirect(req, port = 6099) {
  napcatPort(port);
  const host = String(req.headers.host || '');
  if (!host || /[\s\\/@?#]/.test(host)) throw new Error('登录主机无效');
  let url;
  try { url = new URL('http://' + host); } catch { throw new Error('登录主机无效'); }
  if (url.host !== host || url.username || url.password || !url.hostname) throw new Error('登录主机无效');
  url.port = String(port); url.pathname = '/webui/';
  return url.href;
}
/** Browser-only token reader: never register token() as an agent tool or log it. */
export function createNapcatLogin({ port = 6099, configPath = NAPCAT_WEBUI_CONFIG, fetcher = fetch } = {}) {
  napcatPort(port);
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath) || path.extname(configPath) !== '.json') throw new Error('NapCat WebUI 配置必须为绝对 JSON 文件路径');
  let disposed = false;
  async function target({ signal } = {}) {
    try {
      if (disposed || signal?.aborted) throw new Error();
      const deadline = AbortSignal.timeout(5000);
      const response = await fetcher(`http://127.0.0.1:${port}/webui/`, { method: 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline, headers: { accept: 'text/html' } });
      const ok = response.ok;
      await response.body?.cancel();
      if (!ok || disposed || signal?.aborted) throw new Error();
      return { provider: 'napcat', port };
    } catch { throw new Error(UNAVAILABLE); }
  }
  async function token({ signal } = {}) {
    let file, bytes;
    try {
      if (disposed || signal?.aborted) throw new Error();
      file = await fs.promises.open(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw new Error();
      // Bound the actual read too, in case the file grows after stat().
      bytes = Buffer.alloc(65537);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65536) throw new Error();
      const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))?.token;
      if (!validNapcatToken(value) || disposed || signal?.aborted) throw new Error();
      return { ok: true, token: value };
    } catch { throw new Error(TOKEN_ERROR); }
    finally { bytes?.fill(0); await file?.close().catch(() => {}); }
  }
  return { target, token, redirect: req => napcatRedirect(req, port), dispose() { disposed = true; } };
}
