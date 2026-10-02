import { Store } from './db.js';
import { parseSetCookie } from './cookie.js';
import { parseUrl, defaultPath, domainMatches, pathMatches, buildCookieHeader } from './util.js';
import type {
  CookieRow, ImportResult, MatchResult, CookieVerdict,
} from './types.js';

function domainSuffix(requestHost: string, domain: string): boolean {
  return requestHost === domain || requestHost.endsWith('.' + domain);
}

export class CookieService {
  constructor(private store: Store) {}

  createJar(name: string, now: number) {
    if (!name || !name.trim()) {
      const e = new Error('jar 名称不能为空'); (e as Error & { code?: string }).code = 'VALIDATION'; throw e;
    }
    return this.store.createJar(name.trim(), now);
  }

  listJars() { return this.store.listJars(); }
  listCookies(jarId: number) { this.store.requireJar(jarId); return this.store.listCookies(jarId); }
  listOperations(jarId: number) { this.store.requireJar(jarId); return this.store.listOperations(jarId); }

  /**
   * 向某 jar 导入多条 Set-Cookie（每条是一个独立响应头，绝不按逗号切分）。
   * @param sourceUrl 响应来源 URL，决定来源主机与默认 path、Domain 合法性。
   * @param now 可注入当前时间（毫秒）。
   */
  importSetCookies(jarId: number, sourceUrl: string, setCookies: string[], now: number): ImportResult[] {
    this.store.requireJar(jarId);
    if (!Array.isArray(setCookies) || setCookies.length === 0) {
      const e = new Error('setCookies 必须是非空字符串数组（每个元素是一条独立响应头）');
      (e as Error & { code?: string }).code = 'VALIDATION'; throw e;
    }
    const source = parseUrl(sourceUrl);
    const results: ImportResult[] = [];

    setCookies.forEach((raw, index) => {
      let parsed;
      try {
        parsed = parseSetCookie(raw);
      } catch (err) {
        results.push({ index, setCookie: raw, accepted: false, action: 'rejected', reason: (err as Error).message, cookie: null });
        return;
      }

      // 决定 cookie 域：显式 Domain 或来源主机（host-only）。
      let cookieDomain: string;
      let hostOnly: boolean;
      if (parsed.domain !== null) {
        if (!domainSuffix(source.host, parsed.domain)) {
          results.push({
            index, setCookie: raw, accepted: false, action: 'rejected',
            reason: `来源域不匹配：Domain=${parsed.domain} 不是来源主机 ${source.host} 本身或其父域（domain-reject）`,
            cookie: null,
          });
          return;
        }
        cookieDomain = parsed.domain;
        hostOnly = false;
      } else {
        cookieDomain = source.host;
        hostOnly = true;
      }

      const cookiePath = parsed.path ?? defaultPath(source.path);
      const existing = this.store.findCookie(jarId, parsed.name, cookieDomain, cookiePath);

      // 到期时间：Max-Age 优先于 Expires；非正 Max-Age 表示立即删除。
      let expiresAt: number | null = null;
      let deleteNow = false;
      if (parsed.maxAge !== null) {
        if (parsed.maxAge <= 0) {
          expiresAt = now;
          deleteNow = true;
        } else {
          expiresAt = now + parsed.maxAge;
        }
      } else if (parsed.expiresInvalid) {
        results.push({
          index, setCookie: raw, accepted: false, action: 'rejected',
          reason: 'Expires 日期无法解析（invalid-expires）',
          cookie: null,
        });
        return;
      } else if (parsed.expires !== null) {
        expiresAt = parsed.expires;
        if (expiresAt <= now) deleteNow = true;
      }

      // 删除语义：同一标识存在则删除；不存在也视为成功的 no-op 删除。
      if (deleteNow) {
        if (existing) this.store.deleteCookie(existing.id);
        this.store.logOperation(jarId, now, 'delete',
          `${parsed.name} @ ${cookieDomain}${cookiePath}（来源 ${sourceUrl}）`);
        results.push({
          index, setCookie: raw, accepted: true, action: 'deleted',
          reason: existing
            ? `已删除既有同名项 #${existing.id}（Max-Age/Expires 指向过去）`
            : '删除指令未命中既有项（no-op）',
          cookie: null,
        });
        return;
      }

      let saved: CookieRow;
      let action: 'stored' | 'replaced';
      if (existing) {
        // 同一 (jar,name,domain,path) 替换；保留 created_seq 以维持创建顺序稳定。
        saved = this.store.updateCookie(existing.id, {
          value: parsed.value,
          host_only: hostOnly ? 1 : 0,
          secure: parsed.secure || existing.secure === 1 ? 1 : 0,
          http_only: parsed.httpOnly ? 1 : existing.http_only,
          same_site: parsed.sameSite,
          expires_at: expiresAt,
          last_seen: now,
          update_count: existing.update_count + 1,
        });
        action = 'replaced';
      } else {
        saved = this.store.insertCookie({
          jar_id: jarId,
          name: parsed.name,
          value: parsed.value,
          domain: cookieDomain,
          host_only: hostOnly ? 1 : 0,
          path: cookiePath,
          secure: parsed.secure ? 1 : 0,
          http_only: parsed.httpOnly ? 1 : 0,
          same_site: parsed.sameSite,
          expires_at: expiresAt,
          created_seq: this.store.nextSeq(),
          created_at: now,
          last_seen: now,
          update_count: 0,
        });
        action = 'stored';
      }

      this.store.logOperation(jarId, now, action,
        `${parsed.name}=${parsed.value} @ ${cookieDomain}${cookiePath}` +
        (parsed.ignoredAttributes.length ? `；忽略属性: ${parsed.ignoredAttributes.join(', ')}` : ''));
      results.push({
        index, setCookie: raw, accepted: true, action,
        reason: action === 'replaced'
          ? `替换了同一标识 (name,domain,path) 的既有项 #${existing?.id ?? ''}，保留创建序号`
          : `新存入，host_only=${hostOnly}，path=${cookiePath}` +
            (parsed.ignoredAttributes.length ? `；忽略: ${parsed.ignoredAttributes.join(', ')}` : ''),
        cookie: saved,
      });
    });

    return results;
  }

  /** 预览某次请求会发送的 Cookie 头，并给出每项选入/排除原因。 */
  previewRequest(jarId: number, requestUrl: string, now: number): MatchResult {
    this.store.requireJar(jarId);
    const target = parseUrl(requestUrl);
    const all = this.store.listCookies(jarId);
    const selected: CookieVerdict[] = [];
    const excluded: CookieVerdict[] = [];

    for (const c of all) {
      const v = this.evaluate(c, target.host, target.path, target.protocol, now);
      (v.selected ? selected : excluded).push(v);
    }

    // 排序：路径长度长的优先；其次创建序号稳定排序（RFC 6265 5.4）。
    selected.sort((a, b) => {
      const dl = b.cookie.path.length - a.cookie.path.length;
      if (dl !== 0) return dl;
      return a.cookie.created_seq - b.cookie.created_seq;
    });

    const cookieHeader = buildCookieHeader(selected.map((v) => ({ name: v.cookie.name, value: v.cookie.value })));
    const result: MatchResult = {
      requestUrl, jarId, now, cookieHeader, selected, excluded,
    };
    this.store.logMatch({
      jarId, ts: now, requestUrl, now, cookieHeader,
      selected: selected.length, excluded: excluded.length,
      report: JSON.stringify({
        selected: selected.map((v) => ({ id: v.cookie.id, reason: v.reason })),
        excluded: excluded.map((v) => ({ id: v.cookie.id, reason: v.reason })),
      }),
    });
    return result;
  }

  private evaluate(c: CookieRow, host: string, path: string, protocol: 'http' | 'https', now: number): CookieVerdict {
    const cookie = c;
    const hostOnly = cookie.host_only === 1;
    const secure = cookie.secure === 1;
    // 1) 过期优先排除（过期项不发送）。
    if (cookie.expires_at !== null && (cookie.expires_at as number) <= now) {
      return { cookie: c, selected: false, reason: 'expired', detail: `已过期：到期 ${new Date(cookie.expires_at as number).toISOString()} <= 当前 ${new Date(now).toISOString()}` };
    }
    // 2) 域：host-only 必须全等；Domain 必须全等或以 ".domain" 结尾（严格边界）。
    if (!domainMatches(host, cookie.domain, hostOnly)) {
      return {
        cookie: c, selected: false, reason: 'domain-mismatch',
        detail: hostOnly
          ? `host-only 域不匹配：cookie 域 ${cookie.domain} 与请求主机 ${host} 不完全相等`
          : `Domain 不匹配：${host} 既不等于 ${cookie.domain}，也不是其子域（要求点边界）`,
      };
    }
    // 3) 路径：全等或斜杠边界前缀。
    if (!pathMatches(path, cookie.path)) {
      return { cookie: c, selected: false, reason: 'path-mismatch', detail: `路径不匹配：请求路径 ${path} 不在 cookie 路径 ${cookie.path} 之下（斜杠边界）` };
    }
    // 4) Secure：只随 HTTPS 发送。
    if (secure && protocol !== 'https') {
      return { cookie: c, selected: false, reason: 'secure-http-blocked', detail: '带 Secure 属性，仅在 HTTPS 请求中发送' };
    }
    const reasons = ['域匹配', '路径匹配'];
    if (secure) reasons.push('HTTPS 满足 Secure');
    if (cookie.expires_at === null) reasons.push('会话 Cookie 未过期');
    else reasons.push(`未过期（${new Date(cookie.expires_at).toISOString()}）`);
    return { cookie: c, selected: true, reason: 'selected', detail: `${reasons.join('、')}；排序路径长度 ${cookie.path.length}，序号 ${cookie.created_seq}` };
  }

  /** 清理过期项；返回被清理数量。 */
  purge(now: number) {
    const r = this.store.purgeExpired(now);
    this.store.logOperation(null, now, 'purge', `清理过期 Cookie ${r.total} 条`);
    return r;
  }

  /** 结束某 jar 会话：删除其会话 Cookie。 */
  endSession(jarId: number, now: number) {
    this.store.requireJar(jarId);
    const n = this.store.clearSessions(jarId);
    this.store.logOperation(jarId, now, 'session-end', `结束会话，清除会话 Cookie ${n} 条`);
    return { cleared: n };
  }
}
