import fs from 'node:fs';
import { spawn } from 'node:child_process';

/** Serial process owner: never kills an attached external daemon. */
export function createBotManager({ enabled, entry, cwd, env, probe, initialize, log, autoRestart = true, restartDelayMs = 3000 }) {
  const state = { child: null, startedAt: 0, lastExit: null, restarts: 0, attached: false };
  let disposed = false, stopping = false, timer, queue = Promise.resolve();
  const serial = (fn) => { const task = queue.then(fn); queue = task.catch(() => {}); return task; };
  async function start() {
    if (disposed || !enabled || state.child) return;
    initialize();
    if (await probe()) { state.attached = true; log('已连接外部机器人；重启请使用原进程管理器，避免双实例'); return; }
    if (disposed || stopping) return;
    if (!fs.existsSync(entry)) throw new Error(`找不到机器人入口：${entry}`);
    state.attached = false;
    const child = spawn(process.execPath, [entry, 'start'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    state.child = child; state.startedAt = Date.now(); state.lastExit = null;
    child.stdout.on('data', b => log(b.toString()));
    child.stderr.on('data', b => log(b.toString()));
    child.on('error', err => log(`机器人启动失败：${err.message}`));
    child.on('close', (code, signal) => {
      if (state.child === child) state.child = null;
      state.lastExit = { at: Date.now(), code, signal };
      log(`机器人进程退出（code=${code} signal=${signal || '-'}）`);
      if (!disposed && !stopping && autoRestart) {
        state.restarts++; clearTimeout(timer);
        timer = setTimeout(() => serial(start).catch(e => log(e.message)), Math.max(500, restartDelayMs)); timer.unref();
      }
    });
    log(`已拉起机器人 PID ${child.pid || '待定'}`);
  }
  async function stop() {
    stopping = true; clearTimeout(timer);
    const child = state.child;
    if (!child) return;
    await new Promise(resolve => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 4000); kill.unref();
      child.once('close', () => { clearTimeout(kill); resolve(); });
      child.kill('SIGTERM');
    });
  }
  return {
    state,
    start: () => serial(start),
    restart: () => serial(async () => {
      if (!enabled) throw new Error('当前未启用托管进程');
      if (state.attached && !state.child && await probe()) throw new Error('当前连接外部机器人，请用原进程管理器重启；未启动第二个实例');
      await stop(); stopping = false; await start();
      return { ok: true, pid: state.child?.pid || null, attached: state.attached };
    }),
    dispose() { disposed = true; void stop(); },
  };
}

/** Bounded shell-free command runner used only for explicit gateway management. */
export function command(bin, args, { cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const append = b => { output = (output + b.toString()).slice(-32000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs); timer.unref();
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0 || timedOut) reject(new Error(output || `命令失败 (${code})`)); else resolve(output); });
  });
}
