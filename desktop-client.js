import RFB from '@novnc/novnc/lib/rfb.js';

const status = document.getElementById('status');
const screen = document.getElementById('screen');
const closeButton = document.getElementById('close');
const warning = document.getElementById('transport-warning');
// Resolve from the actual viewer URL, preserving a reverse proxy's /dsh/ mount.
const returnUrl = new URL('../../../', location.href);
let rfb, closing = false, failed = false;
function message(value) { status.textContent = value; }
function failure(value) { failed = true; message(value); }
function reason(error) { return error?.message || '浏览器未提供错误详情'; }
if (location.protocol === 'https:') warning.hidden = true;

async function closeAndReturn() {
  if (closing) return;
  closing = true;
  closeButton.disabled = true;
  rfb?.disconnect();
  message('正在关闭 QQ 登录窗口…');
  try {
    const response = await fetch('./close', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`关闭接口返回无法读取的响应（HTTP ${response.status}）`); }
    if (!response.ok || !result.ok) throw new Error(result.error || `关闭失败（HTTP ${response.status}）`);
    location.assign(returnUrl.href);
  } catch (error) {
    closing = false;
    closeButton.disabled = false;
    failure(`关闭失败：${reason(error)}。请重试；窗口仍受原有到期时间限制。`);
  }
}
closeButton.addEventListener('click', closeAndReturn);

async function start() {
  const response = await fetch('./info', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  let info;
  try { info = await response.json(); }
  catch { throw new Error(`登录接口返回无法读取的响应（HTTP ${response.status}）；请检查代理或 DSH 登录状态`); }
  if (!response.ok || !info.ok) throw new Error(info.error || `登录接口请求失败（HTTP ${response.status}）`);
  if (info.wsPath !== '/dsh-qq/login/desktop/ws' || !Array.isArray(info.protocols)) throw new Error('登录接口返回无效的连接配置');
  if (closing) return;
  const url = new URL('./ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  rfb = new RFB(screen, url.href, { wsProtocols: info.protocols });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.clipViewport = false;
  rfb.addEventListener('connect', () => {
    if (!closing) message('已连接原版 QQ 窗口，请直接操作；密码不会进入聊天。完成后请点击“关闭登录窗口并返回 QQ 设置”。');
  });
  rfb.addEventListener('disconnect', event => {
    rfb = null;
    if (closing || failed) return;
    failure(event.detail?.clean
      ? '连接已关闭。请返回 QQ 设置重新打开；不要刷新本页（连接只能使用一次）。'
      : 'QQ 窗口连接中断或握手失败：请检查网络、反向代理的 WebSocket 转发和 DSH 登录状态；连接也可能已使用或超过 10 分钟。请返回 QQ 设置重新打开，不要刷新本页。');
  });
  rfb.addEventListener('credentialsrequired', () => {
    failure('后端要求额外 VNC 认证，已关闭；请检查部署。');
    rfb?.disconnect();
  });
  rfb.addEventListener('securityfailure', event => {
    failure(`QQ 窗口安全握手失败：${event.detail?.reason || '服务端拒绝连接'}。请检查后端部署后返回 QQ 设置重新打开。`);
  });
  rfb.addEventListener('clipboard', () => {}); // No clipboard sync in either direction.
}
window.addEventListener('pagehide', () => rfb?.disconnect(), { once: true });
start().catch(error => failure(`无法连接 QQ 登录窗口：${reason(error)}。请返回 QQ 设置检查后重新打开。`));
