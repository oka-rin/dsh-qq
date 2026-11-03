import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const WS_PATH = '/dsh-qq/login/desktop/ws';
const NONCE_TTL = 120_000;
const SESSION_TTL = 600_000;
const MAX_FRAME = 256 * 1024;
const MAX_QUEUE = 4 * 1024 * 1024;

// x11vnc inetd uses FD0 as ONE bidirectional socket, not separate stdin/stdout.
// Python's stdlib socketpair makes that contract work through docker exec -i
// as well. Fixed program only; no shell, TCP listener, user input or secrets in
// argv. Both relay queues are bounded; EOF/SIGTERM always reaps the owned child.
export const DESKTOP_SOCKET_RELAY = `import os, select, signal, socket, subprocess, sys
limit = 4194304
parent, child = socket.socketpair()
proc = None
def stop(signum, frame):
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    proc = subprocess.Popen(sys.argv[1:], stdin=child, stdout=child, stderr=subprocess.DEVNULL, close_fds=True)
    child.close()
    parent.setblocking(False)
    os.set_blocking(0, False)
    os.set_blocking(1, False)
    inbound = bytearray()
    outbound = bytearray()
    while proc.poll() is None:
        reads = ([0] if len(inbound) < limit else []) + ([parent] if len(outbound) < limit else [])
        writes = ([parent] if inbound else []) + ([1] if outbound else [])
        ready_r, ready_w, _ = select.select(reads, writes, [], 1)
        for source in ready_r:
            room = limit - len(inbound if source == 0 else outbound)
            try:
                data = os.read(0, min(65536, room)) if source == 0 else parent.recv(min(65536, room))
            except BlockingIOError:
                continue
            if not data:
                raise SystemExit(0)
            (inbound if source == 0 else outbound).extend(data)
        for target in ready_w:
            queue = inbound if target is parent else outbound
            try:
                count = parent.send(queue) if target is parent else os.write(1, queue)
            except BlockingIOError:
                continue
            del queue[:count]
finally:
    parent.close()
    child.close()
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
`;

/** Bounded metadata/help execution. Never surface child output in an error. */
export function desktopCommand(bin, args, { env = process.env, timeoutMs = 8000, maxBytes = 256 * 1024, allowExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = nodeSpawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(new Error('无法检查 QQ 桌面依赖')); return; }
    const chunks = []; let size = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', data => {
      size += data.length;
      if (size > maxBytes) { failed = true; child.kill('SIGKILL'); }
      else chunks.push(data);
    });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error('缺少 QQ 桌面依赖或无执行权限')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || !allowExitCodes.includes(code)) reject(new Error('无法检查 QQ 桌面依赖或窗口归属'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** Discovery candidates only. Ownership is rechecked immediately before capture. */
export function desktopWindows(tree) {
  return [...String(tree).matchAll(/^\s*(0x[0-9a-f]+)\s+"(?:QQ|QQ登录|QQ 登录)":\s*\("qq"\s+"qq"\)\s+(\d+)x(\d+)/gim)]
    .map(m => ({ id: String(parseInt(m[1], 16)), width: Number(m[2]), height: Number(m[3]) }))
    .filter(validWindow);
}

function validWindow(window) {
  return window && /^[1-9]\d{0,9}$/.test(String(window.id)) && Number(window.id) <= 0xffffffff &&
    Number.isInteger(window.width) && Number.isInteger(window.height) &&
    window.width >= 240 && window.width <= 2048 && window.height >= 240 && window.height <= 2048;
}

function sameNonce(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rejectUpgrade(socket, status = 403) {
  if (socket.destroyed) return;
  // Never echo paths, headers, subprotocols, or exception text.
  socket.end(`HTTP/1.1 ${status} ${status === 409 ? 'Conflict' : 'Forbidden'}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * HUMAN-ONLY entry point. Parent owns start/stop CSRF + auth, authenticated
 * upgrade registration, no-store responses, and noVNC assets. Do not register
 * start(), capability info, or RFB frames as model tools/logs/persistent state.
 *
 * start() returns {wsPath, protocols, expiresAt, sessionExpiresAt, window}.
 * Pass protocols to noVNC RFB's wsProtocols; no nonce in URL/cookie required by
 * this module. Parent MUST call connection.requestRejection before upgrade().
 * One session and one connection; start replaces the previous session.
 *
 * x11vnc -id is window capture, not an X11 security sandbox: use the dedicated
 * QQ Xvfb display. Separate top-level dialogs can be clipped; never fall back
 * to -sid/root/full desktop. No clipboard/file transfer or automatic clicks.
 */
export function createDesktop({
  mode = 'native', container = 'snowluma', display = mode === 'docker' ? ':1' : ':99',
  xauthority = mode === 'docker' ? '' : '/var/lib/snowluma/.Xauthority',
  discoverWindow, run = desktopCommand, spawn = nodeSpawn, now = Date.now,
  webSocketServerFactory = options => new WebSocketServer(options),
  killGroup = (pid, signal) => process.kill(-pid, signal),
} = {}) {
  if (!['native', 'docker', 'external'].includes(mode)) throw new Error('不支持的 QQ 桌面模式');
  if (!/^:[0-9]{1,4}(?:\.[0-9])?$/.test(display)) throw new Error('QQ 桌面必须使用本机 X11 显示编号');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw new Error('QQ 桌面容器名无效');
  if (xauthority && (!path.isAbsolute(xauthority) || /[\r\n\0]/.test(xauthority))) throw new Error('Xauthority 必须是本机绝对路径');

  let disposed = false, busy = false, session = null, generation = 0;
  const env = { ...process.env, DISPLAY: display };
  if (xauthority) env.XAUTHORITY = xauthority;
  // Options must be fixed server-side, never accepted from start/upgrade input.
  const command = async (bin, args, options = {}) => {
    try {
      return await (mode === 'docker'
        ? run('docker', ['exec', '-e', `DISPLAY=${display}`, ...(xauthority ? ['-e', `XAUTHORITY=${xauthority}`] : []), container, 'timeout', '--signal=KILL', '8s', bin, ...args], { ...options, timeoutMs: 9000 })
        : run(bin, args, { ...options, env }));
    } catch { throw new Error('无法检查 QQ 桌面依赖或窗口归属'); }
  };
  const wss = webSocketServerFactory({
    noServer: true, clientTracking: false, perMessageDeflate: false,
    maxPayload: MAX_FRAME,
    handleProtocols: protocols => protocols.has('binary') ? 'binary' : false,
  });
  wss.on('error', () => { if (session) finish(session); });

  function killChild(s) {
    const child = s.child;
    if (!child || s.killed) return;
    s.killed = true;
    // Closing stdin lets inetd x11vnc exit even inside docker exec. GNU timeout
    // INSIDE the container independently bounds any abandoned process to 10m.
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    const kill = signal => {
      try {
        if (mode === 'native' && Number.isInteger(child.pid) && child.pid > 1) killGroup(child.pid, signal);
        else child.kill(signal);
      } catch { try { child.kill(signal); } catch {} }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 2000);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  }
  function finish(s, closeCode = 1000) {
    if (s.closed) return;
    s.closed = true;
    clearTimeout(s.timer);
    if (session === s) session = null;
    s.nonce = null;
    killChild(s);
    if (s.ws && s.ws.readyState < 2) {
      try { s.ws.close(closeCode, 'QQ desktop session closed'); } catch { s.ws.terminate(); }
      // A peer which never completes close must not retain a live socket.
      const timer = setTimeout(() => s.ws.terminate(), 1000);
      timer.unref?.();
      s.ws.once('close', () => clearTimeout(timer));
    }
  }
  async function verifiedWindow() {
    let window;
    if (discoverWindow) {
      try { window = await discoverWindow(); } catch { throw new Error('无法核实 QQ 窗口；未打开桌面'); }
    } else {
      const tree = await command('xwininfo', ['-root', '-tree']);
      const windows = desktopWindows(tree.toString('utf8'));
      if (windows.length !== 1) throw new Error('必须只保留一个可核实的 QQ 窗口；未打开桌面');
      [window] = windows;
    }
    if (!validWindow(window)) throw new Error('QQ 窗口编号或尺寸无效；未打开桌面');
    const id = String(window.id);
    const props = (await command('xprop', ['-id', id, '_NET_WM_PID', 'WM_CLASS'], { maxBytes: 8192 })).toString('utf8');
    const pid = props.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*([1-9][0-9]{0,9})\b/);
    if (!pid || !/WM_CLASS\(STRING\)\s*=\s*"qq",\s*"qq"\s*(?:\n|$)/i.test(props)) throw new Error('无法核实 QQ 窗口归属；未打开桌面');
    const exe = (await command('readlink', ['-f', `/proc/${pid[1]}/exe`], { maxBytes: 4096 })).toString('utf8').trim();
    if (!['/opt/QQ/qq', '/opt/snowluma/qq/qq'].includes(exe)) throw new Error('窗口进程不是受支持的 QQ；未打开桌面');
    return { id, width: window.width, height: window.height };
  }

  async function start() {
    if (disposed) throw new Error('QQ 桌面已卸载');
    if (mode === 'external') throw new Error('外部网关不支持本机 QQ 桌面');
    if (busy) throw new Error('QQ 桌面正在准备，请稍后重试');
    busy = true;
    const version = ++generation;
    if (session) finish(session);
    try {
      // Help/version only: these do not start capture, a service, or login.
      const help = (await command('x11vnc', ['-norc', '-help'], { maxBytes: 512 * 1024, allowExitCodes: [0, 1] })).toString('utf8');
      if (!/(?:^|\n)-inetd\s/.test(help) || !/(?:^|\n)-id\s/.test(help)) throw new Error('x11vnc 不支持仅窗口 stdio 桌面；未打开桌面');
      const timeoutHelp = (await command('timeout', ['--help'], { maxBytes: 32768 })).toString('utf8');
      if (!timeoutHelp.includes('--kill-after')) throw new Error('需要支持 --kill-after 的 timeout；未打开桌面');
      await command('python3', ['-I', '-c', 'import os, select, signal, socket, subprocess, sys; a,b=socket.socketpair(); a.close(); b.close()'], { maxBytes: 1024 });
      const window = await verifiedWindow();
      if (disposed || version !== generation) throw new Error('QQ 桌面准备已取消');
      const createdAt = now();
      const s = { window, nonce: randomBytes(32).toString('base64url'), expiresAt: createdAt + NONCE_TTL,
        sessionExpiresAt: createdAt + SESSION_TTL, closed: false, used: false };
      session = s;
      s.timer = setTimeout(() => finish(s), NONCE_TTL);
      s.timer.unref?.();
      return { ok: true, source: 'qq-window', wsPath: WS_PATH,
        protocols: ['binary', `dsh-qq-session.${s.nonce}`], expiresAt: s.expiresAt,
        sessionExpiresAt: s.sessionExpiresAt, window: { width: window.width, height: window.height } };
    } finally { busy = false; }
  }

  function attach(s, ws) {
    if (s.closed || disposed || session !== s) { ws.close(1008, 'QQ desktop session closed'); return; }
    s.ws = ws;
    ws.on('error', () => finish(s, 1011));
    ws.once('close', () => finish(s));
    clearTimeout(s.timer);
    s.timer = setTimeout(() => finish(s), Math.max(1, s.sessionExpiresAt - now()));
    s.timer.unref?.();
    const args = ['--signal=TERM', '--kill-after=2s', `${Math.max(1, Math.ceil((s.sessionExpiresAt - now()) / 1000))}s`,
      'python3', '-I', '-c', DESKTOP_SOCKET_RELAY, 'x11vnc', '-norc', '-inetd', '-quiet', '-id', s.window.id, '-display', display,
      ...(xauthority ? ['-auth', xauthority] : []),
      '-once', '-nopw', '-noxdamage', '-nosel', '-input', 'KMB', '-safer', '-nocmds'];
    let child;
    try {
      child = mode === 'docker'
        ? spawn('docker', ['exec', '-i', '-e', `DISPLAY=${display}`, ...(xauthority ? ['-e', `XAUTHORITY=${xauthority}`] : []), container, 'timeout', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('timeout', args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { finish(s, 1011); return; }
    s.child = child;
    child.on('error', () => finish(s, 1011));
    child.once('close', () => finish(s));
    child.stderr.on('error', () => {});
    child.stderr.resume(); // Discard all x11vnc output; never relay to model/logs.
    child.stdin.on('error', () => finish(s, 1011));
    child.stdout.on('error', () => finish(s, 1011));
    child.stdout.on('end', () => finish(s));
    child.stdout.on('data', data => {
      if (s.closed) return;
      if (data.length > MAX_QUEUE || ws.bufferedAmount + data.length > MAX_QUEUE || ws.readyState !== 1) { finish(s, 1009); return; }
      child.stdout.pause();
      try { ws.send(data, { binary: true, compress: false }, error => {
        if (error) finish(s, 1011);
        else if (!s.closed) child.stdout.resume();
      }); } catch { finish(s, 1011); }
    });
    ws.on('message', (data, isBinary) => {
      if (s.closed) return;
      // RFB bytes are forwarded, not interpreted, logged, cached or persisted.
      if (!isBinary || !Buffer.isBuffer(data) || data.length > MAX_FRAME || child.stdin.writableLength + data.length > MAX_QUEUE) { finish(s, 1009); return; }
      try { if (!child.stdin.write(data)) ws.pause(); } catch { finish(s, 1011); }
    });
    child.stdin.on('drain', () => { if (!s.closed) ws.resume(); });
  }

  async function upgrade(req, socket, head) {
    const s = session;
    if (disposed || !s || s.closed || req.url !== WS_PATH || req.method !== 'GET') { rejectUpgrade(socket); return false; }
    // Require exact same-origin browser upgrade, even after parent Host auth.
    let origin;
    try { origin = new URL(req.headers?.origin); } catch { rejectUpgrade(socket); return false; }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers?.host || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || req.headers?.['sec-fetch-site'] === 'cross-site') { rejectUpgrade(socket); return false; }
    const protocols = String(req.headers?.['sec-websocket-protocol'] || '').split(',').map(p => p.trim());
    if (protocols.length !== 2 || !protocols.includes('binary') || !sameNonce(protocols.find(p => p.startsWith('dsh-qq-session.')), `dsh-qq-session.${s.nonce}`)) { rejectUpgrade(socket); return false; }
    if (s.used) { rejectUpgrade(socket, 409); return false; }
    if (now() >= s.expiresAt) { finish(s); rejectUpgrade(socket); return false; }
    s.used = true; s.nonce = null; // Reserve before awaits: parallel upgrades cannot replay.
    try {
      const window = await verifiedWindow();
      if (s.closed || disposed || session !== s || now() >= s.expiresAt || window.id !== s.window.id || window.width !== s.window.width || window.height !== s.window.height || socket.destroyed) {
        finish(s); rejectUpgrade(socket); return false;
      }
      // ws requires a real client Upgrade; handleUpgrade validates handshake/key.
      wss.handleUpgrade(req, socket, head, ws => attach(s, ws));
      return true;
    } catch { finish(s); rejectUpgrade(socket); return false; }
  }
  return {
    start, upgrade,
    stop() { generation++; if (session) finish(session); },
    dispose() { generation++; disposed = true; if (session) finish(session); wss.close(); },
  };
}
