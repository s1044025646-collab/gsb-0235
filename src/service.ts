/** 业务逻辑：导入 Set-Cookie、请求匹配预览、清理。 */
import {
  CookieError,
  defaultPath,
  domainMatch,
  matchCookie,
  parseOriginUrl,
  parseSetCookie,
  sortForSend,
} from "./cookie.ts";
import type { CookieRecord } from "./cookie.ts";
import { Store } from "./store.ts";

export interface ImportItemResult {
  header: string;
  status: "stored" | "replaced" | "deleted" | "rejected";
  reasons: string[];
  ignored: string[];
  cookie?: CookieRecord;
}

export interface MatchItemResult {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  included: boolean;
  reasons: string[];
}

export class CookieService {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  private requireJar(idOrName: string) {
    const jar = this.store.getJar(idOrName);
    if (!jar) throw new CookieError("JAR_NOT_FOUND", `jar 不存在: ${idOrName}`);
    return jar;
  }

  createJar(name: string, now: number) {
    if (!name || typeof name !== "string") throw new CookieError("BAD_REQUEST", "name 必须是非空字符串");
    return this.store.createJar(name, now);
  }

  listJars() {
    return this.store.listJars();
  }

  /** 导入多条 Set-Cookie；每条响应头独立传入，绝不按逗号切分。 */
  importCookies(idOrName: string, url: string, setCookies: string[], now: number): ImportItemResult[] {
    const jar = this.requireJar(idOrName);
    if (!Array.isArray(setCookies) || setCookies.length === 0) {
      throw new CookieError("BAD_REQUEST", "setCookies 必须是非空数组（每条 Set-Cookie 响应头一个元素）");
    }
    const origin = parseOriginUrl(url);
    return setCookies.map((header) => this.importOne(jar.id, origin, String(header), now));
  }

  private importOne(
    jarId: number,
    origin: { protocol: string; host: string; path: string },
    header: string,
    now: number
  ): ImportItemResult {
    const reasons: string[] = [];
    let parsed;
    try {
      parsed = parseSetCookie(header);
    } catch (e) {
      if (e instanceof CookieError) return { header, status: "rejected", reasons: [e.message], ignored: [] };
      throw e;
    }
    reasons.push(...parsed.errors);

    let hostOnly = true;
    let domain = origin.host;
    if (parsed.domain !== undefined) {
      if (!domainMatch(origin.host, parsed.domain)) {
        return {
          header,
          status: "rejected",
          reasons: [...reasons, `来源主机 ${origin.host} 不属于 Domain=${parsed.domain}，拒绝写入`],
          ignored: parsed.ignored,
        };
      }
      hostOnly = false;
      domain = parsed.domain;
      reasons.push(`Domain=${parsed.domain} 与来源主机匹配，按非 host-only 存储`);
    } else {
      reasons.push(`未设置 Domain，按 host-only 存储于 ${origin.host}`);
    }

    const path = parsed.path ?? defaultPath(origin.path);
    if (parsed.path === undefined) reasons.push(`未设置 Path，使用默认路径 ${path}`);

    let expiresAt: number | null = null;
    if (parsed.maxAge !== undefined) {
      if (parsed.maxAge <= 0) {
        const removed = this.store.deleteCookie(jarId, parsed.name, domain, path, now);
        reasons.push(`Max-Age=${parsed.maxAge} <= 0，删除同名 Cookie（${removed ? "已删除" : "原本不存在"}）`);
        return { header, status: "deleted", reasons, ignored: parsed.ignored };
      }
      expiresAt = now + parsed.maxAge * 1000;
      reasons.push(`Max-Age=${parsed.maxAge} 生效（优先于 Expires），到期 ${new Date(expiresAt).toISOString()}`);
    } else if (parsed.expires !== undefined) {
      if (parsed.expires <= now) {
        const removed = this.store.deleteCookie(jarId, parsed.name, domain, path, now);
        reasons.push(`Expires 已过期，删除同名 Cookie（${removed ? "已删除" : "原本不存在"}）`);
        return { header, status: "deleted", reasons, ignored: parsed.ignored };
      }
      expiresAt = parsed.expires;
      reasons.push(`Expires 生效，到期 ${new Date(expiresAt).toISOString()}`);
    } else {
      reasons.push("未设置期限：会话 Cookie，服务重启后将被清除");
    }

    const { action, record } = this.store.upsertCookie(
      jarId,
      {
        name: parsed.name,
        value: parsed.value,
        domain,
        hostOnly,
        path,
        secure: parsed.secure,
        expiresAt,
        createdAt: now,
      },
      now
    );
    reasons.push(action === "replaced" ? "同 (name, domain, path) 已存在，已替换并保留原创建顺序" : "新建存储项");
    return { header, status: action === "replaced" ? "replaced" : "stored", reasons, ignored: parsed.ignored, cookie: record };
  }

  listCookies(idOrName: string): CookieRecord[] {
    const jar = this.requireJar(idOrName);
    return this.store.listCookies(jar.id);
  }

  /** 预览某次请求的 Cookie 头，并给出每项选入/排除原因。 */
  preview(idOrName: string, url: string, now: number): { url: string; header: string; results: MatchItemResult[] } {
    const jar = this.requireJar(idOrName);
    const req = parseOriginUrl(url);
    const cookies = this.store.listCookies(jar.id);
    const evaluated = cookies.map((c) => ({ c, d: matchCookie(c, req, now) }));
    const included = sortForSend(evaluated.filter((e) => e.d.included).map((e) => e.c));
    const header = included.map((c) => `${c.name}=${c.value}`).join("; ");
    const results: MatchItemResult[] = evaluated.map(({ c, d }) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      hostOnly: c.hostOnly,
      secure: c.secure,
      included: d.included,
      reasons: d.reasons,
    }));
    const report = { url, header, results };
    this.store.saveMatchReport(jar.id, url, report, now);
    return report;
  }

  purgeExpired(idOrName: string, now: number): number {
    const jar = this.requireJar(idOrName);
    return this.store.purgeExpired(jar.id, now);
  }

  deleteJar(idOrName: string, now: number): void {
    const jar = this.requireJar(idOrName);
    this.store.deleteJar(jar.id, now);
  }
}
