/**
 * 语义检索用的向量：拿一个 OpenAI 兼容的 /embeddings 接口把文字变成数组。
 * 现在接的是阿里云百炼（text-embedding-v4，1024 维，0.2s 一次、批量 10 条）。
 * 原则：这只是「锦上添花」，任何失败都必须静默退回字面检索，不许把聊天搞挂。
 */

/** 余弦相似度（两个等长数组） */
export function cosine(a, b) {
  const n = Math.min(a?.length || 0, b?.length || 0);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Float32 数组 ↔ Buffer（存 SQLite 用） */
export function packVec(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function unpackVec(buf) {
  if (!buf) return [];
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

export class Embedder {
  constructor({ baseUrl, model = 'text-embedding-v4', dims = 1024, apiKey = '', keyEnv = 'DASHSCOPE_API_KEY', timeoutMs = 20000, batch = 10, log } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.model = model;
    this.dims = dims;
    this.apiKey = apiKey || process.env[keyEnv] || '';
    this.keyEnv = keyEnv;
    this.timeoutMs = timeoutMs;
    this.batch = Math.max(1, Math.min(10, batch));
    this.log = log;
  }

  get enabled() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  /**
   * 一批文字 → 一批向量。任何一条失败整批抛错，调用方自己决定怎么退。
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embed(texts) {
    if (!this.enabled) throw new Error('没有配置 embedding 接口或 key');
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '').slice(0, 4000));
    const out = [];
    for (let i = 0; i < list.length; i += this.batch) {
      const slice = list.slice(i, i + this.batch);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: slice, dimensions: this.dims }),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`embedding ${res.status}：${text.slice(0, 160)}`);
        const data = JSON.parse(text);
        const rows = (data?.data || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== slice.length) throw new Error(`embedding 少返回了：要 ${slice.length} 条，给 ${rows.length}`);
        for (const r of rows) out.push(r.embedding);
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  }

  async embedOne(text) {
    const [v] = await this.embed([text]);
    return v;
  }
}

/** 从 config 里造一个（没开或没 key 就返回 null） */
export function embedderOf(cfg, { log } = {}) {
  const c = cfg?.chat?.learn?.embedding || cfg?.learn?.embedding || null;
  if (!c || c.enabled === false) return null;
  const e = new Embedder({
    baseUrl: c.baseUrl,
    model: c.model,
    dims: c.dims,
    apiKey: c.apiKey,
    keyEnv: c.keyEnv,
    timeoutMs: c.timeoutMs,
    batch: c.batch,
    log,
  });
  return e.enabled ? e : null;
}

export default Embedder;
