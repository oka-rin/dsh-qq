import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { appendJsonl, ensureDir, readJson, readJsonlTail, writeJsonAtomic } from './util.mjs';

/**
 * 持久化：每个会话一个 JSONL 历史文件，另有一个 state.json 存放开关 / 人设覆盖 / 统计。
 * 目录结构：
 *   data/
 *     state.json
 *     history/group_123.jsonl
 *     history/private_456.jsonl
 */
export class Store {
  constructor(dataDir, { rotateAtBytes = 8 * 1024 * 1024, rotateCheckEvery = 200 } = {}) {
    this.dataDir = dataDir;
    this.rotateAtBytes = rotateAtBytes;
    this.rotateCheckEvery = rotateCheckEvery;
    this.appendCounts = new Map();
    this.historyDir = ensureDir(path.join(dataDir, 'history'));
    this.stateFile = path.join(dataDir, 'state.json');
    this.state = readJson(this.stateFile, {
      scopes: {},
      persona: null,
      stats: { events: 0, replies: 0, startedAt: null },
    });
    this.state.scopes ??= {};
    this.state.stats ??= { events: 0, replies: 0, startedAt: null };
    this.startedAt = this.state.stats.startedAt ??= Date.now();
  }

  #file(scopeKeyStr) {
    return path.join(this.historyDir, `${String(scopeKeyStr).replace(':', '_')}.jsonl`);
  }

  save() {
    writeJsonAtomic(this.stateFile, this.state);
  }

  append(scope, entry) {
    const row = { ts: Date.now(), scope, ...entry };
    const file = this.#file(scope);
    appendJsonl(file, row);
    this.#maybeRotate(scope, file);
    return row;
  }

  /** 文件大到阈值就切走 + gzip，归档目录里只留当前这一段 */
  #maybeRotate(scope, file) {
    const n = (this.appendCounts.get(scope) || 0) + 1;
    this.appendCounts.set(scope, n);
    if (n % this.rotateCheckEvery !== 0) return;
    try {
      if (fs.statSync(file).size < this.rotateAtBytes) return;
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      let rotated = file.replace(/\.jsonl$/, `.${stamp}.jsonl.gz`);
      for (let i = 1; fs.existsSync(rotated); i += 1) rotated = file.replace(/\.jsonl$/, `.${stamp}-${i}.jsonl.gz`);
      const data = fs.readFileSync(file);
      fs.writeFileSync(rotated, zlib.gzipSync(data, { level: 6 }));
      fs.truncateSync(file, 0);
    } catch {
      /* 切分失败不影响写入 */
    }
  }

  /** 某个会话的历史分片（新的在前：当前段 + 各 gz 归档） */
  archivesOf(scope) {
    const base = path.basename(this.#file(scope)).replace(/\.jsonl$/, '');
    let names = [];
    try {
      names = fs.readdirSync(this.historyDir).filter((f) => f === `${base}.jsonl` || (f.startsWith(`${base}.`) && f.endsWith('.jsonl.gz')));
    } catch {
      return [];
    }
    const gz = names.filter((f) => f.endsWith('.gz')).sort().reverse();
    return [...gz.map((f) => path.join(this.historyDir, f)), path.join(this.historyDir, `${base}.jsonl`)].filter((f) => fs.existsSync(f));
  }

  tail(scope, n = 20) {
    let rows = readJsonlTail(this.#file(scope), n);
    if (rows.length >= n) return rows.slice(-n);
    for (const file of this.archivesOf(scope).filter((f) => f.endsWith('.gz'))) {
      try {
        const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
        const old = [];
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            old.push(JSON.parse(line));
          } catch {
            /* 坏行跳过 */
          }
        }
        rows = [...old.slice(-(n - rows.length)), ...rows];
      } catch {
        /* 坏档跳过 */
      }
      if (rows.length >= n) break;
    }
    return rows.slice(-n);
  }

  /** 读取某会话最后一条消息的时间（用于冷却/活跃度判断） */
  lastActivityAt(scope) {
    const rows = this.tail(scope, 1);
    return rows.length ? rows[rows.length - 1].ts : 0;
  }

  scopeState(scope) {
    return (this.state.scopes[scope] ??= { autochat: true, replies: 0, lastReplyAt: 0 });
  }

  setScopeAutochat(scope, enabled) {
    const s = this.scopeState(scope);
    s.autochat = !!enabled;
    this.save();
    return s;
  }

  bumpScopeReplies(scope) {
    const s = this.scopeState(scope);
    s.replies = (s.replies ?? 0) + 1;
    s.lastReplyAt = Date.now();
    this.state.stats.replies = (this.state.stats.replies ?? 0) + 1;
    this.save();
    return s;
  }

  persona() {
    return this.state.persona || null;
  }

  setPersona(persona) {
    const previous = this.state.persona;
    this.state.persona = persona || null;
    try {
      this.save();
    } catch (error) {
      this.state.persona = previous;
      throw error;
    }
    return this.state.persona;
  }

  listScopes() {
    try {
      return fs
        .readdirSync(this.historyDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const key = f.replace(/\.jsonl$/, '').replace('_', ':');
          const last = this.tail(key, 1)[0];
          return { scope: key, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
        })
        .sort((a, b) => b.lastTs - a.lastTs);
    } catch {
      return [];
    }
  }
}
