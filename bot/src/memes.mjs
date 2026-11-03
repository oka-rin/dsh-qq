import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** 默认去找 dsh-meme 插件的图库：用户目录优先，插件自带库兜底。 */
export const DEFAULT_MEME_DIRS = [
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'meme-packs'),
  ...(process.env.DSH_PROFILE_DIR ? [path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'dsh-meme', 'memes')] : []),
];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/**
 * 表情包图库（只读）。
 * 复用 dsh-meme 每个图库里的 index.db（表 memes：path/tag/caption/keywords），
 * 这样关键词、描述跟网页端面板完全一致，不需要再解析一遍图片。
 */
export class MemeLibrary {
  constructor({ dirs = DEFAULT_MEME_DIRS, log = null } = {}) {
    this.dirs = dirs;
    this.log = log;
    this.packs = null;
    this.cacheAt = 0;
  }

  /** 扫出所有图库目录（含 index.db 或 memes/ 子目录的那种）。 */
  #scan() {
    const packs = [];
    for (const dir of this.dirs) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const packDir = path.join(dir, entry.name);
        const dbFile = path.join(packDir, 'index.db');
        if (!fs.existsSync(dbFile)) continue;
        packs.push({ id: entry.name, dir: packDir, db: dbFile });
      }
    }
    return packs;
  }

  packsList() {
    const now = Date.now();
    if (this.packs && now - this.cacheAt < 60_000) return this.packs;
    this.packs = this.#scan();
    this.cacheAt = now;
    return this.packs;
  }

  /** 按关键词/标签搜图；返回带绝对路径的行，方便直接发出去。 */
  list({ q = '', tag = '', limit = 20 } = {}) {
    const packs = this.packsList();
    const out = [];
    const want = String(q || '').trim();
    const tagWant = String(tag || '').trim();
    for (const pack of packs) {
      let db;
      try {
        db = new DatabaseSync(pack.db, { readOnly: true });
      } catch (err) {
        this.log?.warn?.(`图库打不开（${pack.id}）：${err.message}`);
        continue;
      }
      try {
        const where = [];
        const params = [];
        if (tagWant) {
          where.push('tag = ?');
          params.push(tagWant);
        }
        if (want) {
          where.push('(caption LIKE ? OR keywords LIKE ? OR file_name LIKE ?)');
          const like = `%${want}%`;
          params.push(like, like, like);
        }
        const sql = `SELECT path, tag, file_name, caption, keywords FROM memes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} LIMIT ?`;
        // 内存里兜底过滤一遍：SQLite 的 LIKE 对大小写/全角不敏感度有限
        const rows = db.prepare(sql).all(...params, Math.max(1, limit * 4));
        for (const row of rows) {
          const file = path.join(pack.dir, row.path);
          if (!IMAGE_EXT.test(file) || !fs.existsSync(file)) continue;
          if (want) {
            const hay = `${row.caption || ''} ${row.keywords || ''} ${row.file_name || ''}`;
            if (!hay.includes(want)) continue;
          }
          out.push({
            file,
            pack: pack.id,
            tag: row.tag,
            caption: row.caption || '',
            keywords: row.keywords || '',
          });
          if (out.length >= limit) break;
        }
      } catch (err) {
        this.log?.warn?.(`图库查询失败（${pack.id}）：${err.message}`);
      } finally {
        try { db.close(); } catch { /* 关不掉就算了 */ }
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 按关键词挑一张；同一个关键词的候选里随机，避免每次都发同一张。 */
  pick(q, { tag = '' } = {}) {
    const rows = this.list({ q, tag, limit: 12 });
    if (!rows.length) return null;
    return rows[Math.floor(Math.random() * rows.length)];
  }
}
