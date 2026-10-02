import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CookieRow, JarRow } from './types.js';

/**
 * SQLite 持久层。使用 Node 内置 node:sqlite（Node >= 22.5，
 * Node 25 已可直接使用），无需原生编译依赖。
 */
export class Store {
  readonly db: DatabaseSync;
  private seqStmt;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
    this.seqStmt = this.db.prepare('SELECT COALESCE(MAX(created_seq), 0) AS s FROM cookies');
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cookies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jar_id INTEGER NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        domain TEXT NOT NULL,
        host_only INTEGER NOT NULL,
        path TEXT NOT NULL,
        secure INTEGER NOT NULL,
        http_only INTEGER NOT NULL DEFAULT 0,
        same_site TEXT NOT NULL DEFAULT '',
        expires_at INTEGER,
        created_seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        update_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(jar_id, name, domain, path)
      );
      CREATE INDEX IF NOT EXISTS idx_cookies_jar ON cookies(jar_id);
      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jar_id INTEGER,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jar_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        request_url TEXT NOT NULL,
        now_ms INTEGER NOT NULL,
        cookie_header TEXT NOT NULL,
        selected_count INTEGER NOT NULL,
        excluded_count INTEGER NOT NULL,
        report TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- jars ----
  createJar(name: string, now: number): JarRow {
    const stmt = this.db.prepare('INSERT INTO jars(name, created_at) VALUES(?, ?)');
    try {
      const info = stmt.run(name, now);
      return { id: Number(info.lastInsertRowid), name, created_at: now };
    } catch (e) {
      if ((e as Error).message.includes('UNIQUE')) {
        const err = new Error(`jar 名称已存在：${name}`);
        (err as Error & { code?: string }).code = 'JAR_EXISTS';
        throw err;
      }
      throw e;
    }
  }

  getJar(jarId: number): JarRow | null {
    return (this.db.prepare('SELECT * FROM jars WHERE id = ?').get(jarId) as unknown as JarRow | undefined) ?? null;
  }

  requireJar(jarId: number): JarRow {
    const jar = this.getJar(jarId);
    if (!jar) {
      const err = new Error(`jar 不存在：${jarId}`);
      (err as Error & { code?: string }).code = 'JAR_NOT_FOUND';
      throw err;
    }
    return jar;
  }

  listJars(): JarRow[] {
    return this.db.prepare('SELECT * FROM jars ORDER BY id').all() as unknown as JarRow[];
  }

  // ---- cookies ----
  nextSeq(): number {
    const row = this.seqStmt.get() as { s: number };
    return row.s + 1;
  }

  findCookie(jarId: number, name: string, domain: string, path: string): CookieRow | null {
    const row = this.db
      .prepare('SELECT * FROM cookies WHERE jar_id=? AND name=? AND domain=? AND path=?')
      .get(jarId, name, domain, path);
    return (row as unknown as CookieRow | undefined) ?? null;
  }

  listCookies(jarId: number): CookieRow[] {
    return this.db
      .prepare('SELECT * FROM cookies WHERE jar_id=? ORDER BY created_seq, id')
      .all(jarId) as unknown as CookieRow[];
  }

  insertCookie(c: Omit<CookieRow, 'id'>): CookieRow {
    const info = this.db
      .prepare(
        `INSERT INTO cookies(jar_id,name,value,domain,host_only,path,secure,http_only,same_site,
          expires_at,created_seq,created_at,last_seen,update_count)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.jar_id, c.name, c.value, c.domain, c.host_only ? 1 : 0, c.path, c.secure ? 1 : 0,
        c.http_only, c.same_site, c.expires_at, c.created_seq, c.created_at, c.last_seen, c.update_count,
      );
    return this.db.prepare('SELECT * FROM cookies WHERE id=?').get(Number(info.lastInsertRowid)) as unknown as CookieRow;
  }

  updateCookie(id: number, fields: Partial<CookieRow>): CookieRow {
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k}=?`);
      vals.push(k === 'host_only' || k === 'secure' ? (v ? 1 : 0) : v);
    }
    vals.push(id);
    this.db.prepare(`UPDATE cookies SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    return this.db.prepare('SELECT * FROM cookies WHERE id=?').get(id) as unknown as CookieRow;
  }

  deleteCookie(id: number): void {
    this.db.prepare('DELETE FROM cookies WHERE id=?').run(id);
  }

  /** 删除严格过期（expires_at <= now）的持久 Cookie；返回删除数量。 */
  purgeExpired(now: number): { total: number; byJar: Record<number, number> } {
    const rows = this.db
      .prepare('SELECT id, jar_id FROM cookies WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(now) as Array<{ id: number; jar_id: number }>;
    const byJar: Record<number, number> = {};
    const del = this.db.prepare('DELETE FROM cookies WHERE id=?');
    for (const r of rows) {
      del.run(r.id);
      byJar[r.jar_id] = (byJar[r.jar_id] ?? 0) + 1;
    }
    return { total: rows.length, byJar };
  }

  /** 删除某 jar 的全部会话 Cookie（expires_at IS NULL），模拟会话结束。 */
  clearSessions(jarId: number): number {
    const info = this.db
      .prepare('DELETE FROM cookies WHERE jar_id=? AND expires_at IS NULL')
      .run(jarId);
    return Number(info.changes);
  }

  logOperation(jarId: number | null, ts: number, kind: string, detail: string): void {
    this.db.prepare('INSERT INTO operations(jar_id, ts, kind, detail) VALUES(?,?,?,?)')
      .run(jarId, ts, kind, detail);
  }

  logMatch(m: {
    jarId: number; ts: number; requestUrl: string; now: number;
    cookieHeader: string; selected: number; excluded: number; report: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO match_logs(jar_id,ts,request_url,now_ms,cookie_header,selected_count,excluded_count,report)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(m.jarId, m.ts, m.requestUrl, m.now, m.cookieHeader, m.selected, m.excluded, m.report);
  }

  listOperations(jarId: number, limit = 50): unknown[] {
    return this.db
      .prepare('SELECT * FROM operations WHERE jar_id=? ORDER BY id DESC LIMIT ?')
      .all(jarId, limit);
  }
}
