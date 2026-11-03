import RFB from '@novnc/novnc/lib/rfb.js';

const status = document.getElementById('status');
const screen = document.getElementById('screen');
let rfb;
function message(value) { status.textContent = value; }
async function start() {
  if (!window.isSecureContext && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('请在 HTTPS 或本机地址打开登录窗口');
  const response = await fetch('./info', { credentials: 'same-origin', cache: 'no-store' });
  const info = await response.json();
  if (!response.ok || !info.ok || info.wsPath !== '/dsh-qq/login/desktop/ws' || !Array.isArray(info.protocols)) throw new Error('登录窗口已过期，请关闭后重新打开');
  const url = new URL('./ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  rfb = new RFB(screen, url.href, { wsProtocols: info.protocols });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.clipViewport = false;
  rfb.addEventListener('connect', () => message('直接在原版 QQ 窗口操作；密码不会进入聊天。关闭面板会断开。'));
  rfb.addEventListener('disconnect', () => { rfb = null; message('连接已关闭，请返回面板重新打开。'); });
  rfb.addEventListener('credentialsrequired', () => { rfb.disconnect(); message('后端要求额外 VNC 认证，已关闭；请检查部署。'); });
  rfb.addEventListener('securityfailure', () => message('QQ 窗口连接失败，请检查后端。'));
  rfb.addEventListener('clipboard', () => {}); // No clipboard sync in either direction.
}
window.addEventListener('pagehide', () => rfb?.disconnect(), { once: true });
start().catch(() => message('无法连接 QQ 登录窗口，请返回面板检查部署并重试。'));
