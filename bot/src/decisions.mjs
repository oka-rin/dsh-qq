import fs from 'node:fs';
import path from 'node:path';

/**
 * 「为什么没说话」账本。
 *
 * 机器人沉默的原因有十几条：没 @ 我、免打扰、用户冷却、每分钟上限、没人接话、
 * 今天额度用完、群太安静、搜索没搜到好东西……全散在代码里，出问题只能翻 debug 日志。
 * 这里统一记一笔：同一个会话 + 同一个原因，10 分钟内只记一条并累加次数，
 * 免得群里刷屏时被「未触发」灌满。
 */
export class DecisionLog {
  constructor({ dataDir = 'data', log = null, mergeWindowMs = 10 * 60_000, maxKeep = 500 } = {}) {
    this.log = log;
    this.mergeWindowMs = mergeWindowMs;
    this.maxKeep = maxKeep;
    this.file = path.resolve(dataDir, 'history', 'decisions.jsonl');
    this.rows = []; // 内存里留最近的，旧的不读盘
    this.dirty = 0;
    this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-this.maxKeep);
      this.rows = lines.map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      this.rows = [];
    }
  }

  #flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const keep = this.rows.slice(-this.maxKeep);
      fs.writeFileSync(this.file, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      this.dirty = 0;
    } catch (err) {
      this.log?.warn?.(`写决策日志失败：${err.message}`);
    }
  }

  /**
   * 记一笔。
   * @param {{scope?:string, kind:'passive'|'agent'|'share'|'qzone', reason:string, detail?:string, acted?:boolean}} item
   */
  record({ scope = '', kind = 'passive', reason = '', detail = '', acted = false } = {}) {
    if (!reason && !acted) return null;
    const now = Date.now();
    const tail = [...this.rows].reverse().find((r) => r.scope === scope && r.kind === kind && r.reason === reason);
    const mergeable = tail && !acted && !tail.acted && now - tail.at < this.mergeWindowMs;

    if (mergeable) {
      tail.n = (tail.n || 1) + 1;
      tail.at = now;
      if (detail) tail.detail = detail.slice(0, 200);
      this.dirty += 1;
      if (this.dirty >= 20) this.#flush();
      return tail;
    }

    const row = { at: now, scope, kind, reason, detail: detail ? detail.slice(0, 200) : '', acted, n: 1 };
    this.rows.push(row);
    if (this.rows.length > this.maxKeep * 2) this.rows = this.rows.slice(-this.maxKeep);
    this.dirty += 1;
    this.#flush();

    // 让 journalctl / 面板外的日志也能一眼看见（同一原因只在首次出现时打）
    if (!acted) this.log?.info?.(`${scope || '全局'} 没说话 · ${KIND_LABEL[kind] || kind} · ${reason}${detail ? `（${detail}）` : ''}`);
    else this.log?.info?.(`${scope || '全局'} 说话了 · ${KIND_LABEL[kind] || kind} · ${reason}`);
    return row;
  }

  /** 今天的战况：按原因聚合 */
  summary({ since = startOfToday(), scope = '' } = {}) {
    const mine = this.rows.filter((r) => r.at >= since && (!scope || r.scope === scope));
    const byReason = new Map();
    for (const r of mine) {
      const key = `${r.kind}|${r.reason}`;
      const cur = byReason.get(key) || { kind: r.kind, reason: r.reason, n: 0, acted: 0, lastAt: 0, scope: r.scope };
      cur.n += r.n || 1;
      if (r.acted) cur.acted += r.n || 1;
      cur.lastAt = Math.max(cur.lastAt, r.at);
      byReason.set(key, cur);
    }
    const rows = [...byReason.values()].sort((a, b) => b.n - a.n);
    return {
      since,
      acted: mine.filter((r) => r.acted).reduce((s, r) => s + (r.n || 1), 0),
      silent: mine.filter((r) => !r.acted).reduce((s, r) => s + (r.n || 1), 0),
      reasons: rows,
    };
  }

  /** 最近若干条，新→旧 */
  recent({ limit = 30, scope = '', kind = '' } = {}) {
    return this.rows
      .filter((r) => (!scope || r.scope === scope) && (!kind || r.kind === kind))
      .slice(-limit)
      .reverse();
  }
}

export const KIND_LABEL = {
  passive: '被动回消息',
  agent: '主动决策',
  share: '主动分享',
  qzone: '发说说',
  interject: '插嘴',
};

export function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
