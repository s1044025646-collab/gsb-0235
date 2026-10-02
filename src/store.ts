/** SQLite 持久化层（node:sqlite，零原生依赖）。 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { CookieRecord } from "./cookie.ts";

export interface JarRow {
  id: number;
  name: string;
  createdAt: number;
}

export class Store {
  private db: DatabaseSync;
  readonly sessionId: string;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.sessionId = `${Date.now()}-${process.pid}`;
    this.init();
    // 会话边界：服务启动即新会话，清除上一会话遗留的会话 Cookie。
    this.db.prepare("DELETE FROM cookies WHERE expires_at IS NULL AND session_id != ?").run(this.sessionId);
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        creation_seq INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        UNIQUE (jar_id, name, domain, path)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jar_id INTEGER,
        op TEXT NOT NULL,
        detail TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jar_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        at INTEGER NOT NULL,
        report_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private log(jarId: number | null, op: string, detail: unknown, at: number): void {
    this.db
      .prepare("INSERT INTO operations (jar_id, op, detail, at) VALUES (?, ?, ?, ?)")
      .run(jarId, op, JSON.stringify(detail), at);
  }

  createJar(name: string, now: number): JarRow {
    try {
      const r = this.db.prepare("INSERT INTO jars (name, created_at) VALUES (?, ?)").run(name, now);
      const jar = { id: Number(r.lastInsertRowid), name, createdAt: now };
      this.log(jar.id, "create-jar", { name }, now);
      return jar;
    } catch {
      throw Object.assign(new Error(`jar 名称已存在: ${name}`), { code: "JAR_EXISTS" });
    }
  }

  listJars(): JarRow[] {
    const rows = this.db.prepare("SELECT id, name, created_at AS createdAt FROM jars ORDER BY id").all();
    return rows as unknown as JarRow[];
  }

  getJar(idOrName: string): JarRow | undefined {
    const byId = /^\d+$/.test(idOrName)
      ? this.db.prepare("SELECT id, name, created_at AS createdAt FROM jars WHERE id = ?").get(Number(idOrName))
      : undefined;
    const row =
      byId ?? this.db.prepare("SELECT id, name, created_at AS createdAt FROM jars WHERE name = ?").get(idOrName);
    return row as JarRow | undefined;
  }

  deleteJar(jarId: number, now: number): void {
    this.db.prepare("DELETE FROM cookies WHERE jar_id = ?").run(jarId);
    this.db.prepare("DELETE FROM match_reports WHERE jar_id = ?").run(jarId);
    this.db.prepare("DELETE FROM jars WHERE id = ?").run(jarId);
    this.log(jarId, "delete-jar", { jarId }, now);
  }

  private nextSeq(jarId: number): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(creation_seq), 0) + 1 AS seq FROM cookies WHERE jar_id = ?")
      .get(jarId) as { seq: number };
    return row.seq;
  }

  /** 插入或按 (jar,name,domain,path) 替换；替换时保留原 creation_seq。 */
  upsertCookie(
    jarId: number,
    c: Omit<CookieRecord, "id" | "jarId" | "creationSeq">,
    now: number
  ): { action: "created" | "replaced"; record: CookieRecord } {
    const existing = this.db
      .prepare("SELECT * FROM cookies WHERE jar_id = ? AND name = ? AND domain = ? AND path = ?")
      .get(jarId, c.name, c.domain, c.path) as Record<string, unknown> | undefined;
    const seq = existing ? (existing.creation_seq as number) : this.nextSeq(jarId);
    this.db
      .prepare(
        `INSERT INTO cookies (jar_id, name, value, domain, host_only, path, secure, expires_at, created_at, creation_seq, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (jar_id, name, domain, path) DO UPDATE SET
           value = excluded.value, host_only = excluded.host_only, secure = excluded.secure,
           expires_at = excluded.expires_at, session_id = excluded.session_id`
      )
      .run(
        jarId, c.name, c.value, c.domain, c.hostOnly ? 1 : 0, c.path, c.secure ? 1 : 0,
        c.expiresAt, now, seq, this.sessionId
      );
    this.log(jarId, existing ? "replace-cookie" : "set-cookie", { name: c.name, domain: c.domain, path: c.path }, now);
    const row = this.db
      .prepare("SELECT * FROM cookies WHERE jar_id = ? AND name = ? AND domain = ? AND path = ?")
      .get(jarId, c.name, c.domain, c.path) as Record<string, unknown>;
    return { action: existing ? "replaced" : "created", record: this.toRecord(row) };
  }

  deleteCookie(jarId: number, name: string, domain: string, path: string, now: number): boolean {
    const r = this.db
      .prepare("DELETE FROM cookies WHERE jar_id = ? AND name = ? AND domain = ? AND path = ?")
      .run(jarId, name, domain, path);
    if (Number(r.changes) > 0) {
      this.log(jarId, "delete-cookie", { name, domain, path }, now);
      return true;
    }
    return false;
  }

  listCookies(jarId: number): CookieRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM cookies WHERE jar_id = ? ORDER BY creation_seq")
      .all(jarId) as Record<string, unknown>[];
    return rows.map((r) => this.toRecord(r));
  }

  purgeExpired(jarId: number, now: number): number {
    const r = this.db
      .prepare("DELETE FROM cookies WHERE jar_id = ? AND expires_at IS NOT NULL AND expires_at <= ?")
      .run(jarId, now);
    const n = Number(r.changes);
    if (n > 0) this.log(jarId, "purge-expired", { removed: n }, now);
    return n;
  }

  saveMatchReport(jarId: number, url: string, report: unknown, now: number): void {
    this.db
      .prepare("INSERT INTO match_reports (jar_id, url, at, report_json) VALUES (?, ?, ?, ?)")
      .run(jarId, url, now, JSON.stringify(report));
  }

  listOperations(jarId: number): unknown[] {
    return this.db
      .prepare("SELECT op, detail, at FROM operations WHERE jar_id = ? ORDER BY id")
      .all(jarId) as unknown[];
  }

  private toRecord(row: Record<string, unknown>): CookieRecord {
    return {
      id: row.id as number,
      jarId: row.jar_id as number,
      name: row.name as string,
      value: row.value as string,
      domain: row.domain as string,
      hostOnly: row.host_only === 1,
      path: row.path as string,
      secure: row.secure === 1,
      expiresAt: (row.expires_at as number | null) ?? null,
      createdAt: row.created_at as number,
      creationSeq: row.creation_seq as number,
    };
  }
}
