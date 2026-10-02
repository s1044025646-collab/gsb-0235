/**
 * Set-Cookie 解析与 RFC 6265 风格匹配规则（教学简化版）。
 * 仅支持普通 ASCII 域名；不支持公共后缀列表、IDN、SameSite 等完整浏览器策略。
 */

export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;      // 规范化后的小写域（去掉前导点）
  path?: string;
  secure: boolean;
  maxAge?: number;      // 秒
  expires?: number;     // epoch 毫秒
  ignored: string[];    // 被忽略/不支持的属性说明
  errors: string[];     // 解析级问题（不必然导致拒绝）
}

export interface CookieRecord {
  id: number;
  jarId: number;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt: number | null; // null = 会话 Cookie
  createdAt: number;
  creationSeq: number;
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function isValidDomain(host: string): boolean {
  if (!DOMAIN_RE.test(host)) return false;
  // 拒绝 IPv4 形式（最后一段为纯数字），本服务只面向普通 ASCII 测试域名。
  const last = host.split(".").pop() ?? "";
  return !/^\d+$/.test(last);
}

/** 从来源 URL 提取并校验 host（仅 http/https、ASCII 域名）。 */
export function parseOriginUrl(raw: string): { protocol: string; host: string; path: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CookieError("INVALID_URL", `无法解析 URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CookieError("INVALID_URL", `仅支持 http/https URL，得到: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (!isValidDomain(host)) {
    throw new CookieError(
      "INVALID_DOMAIN",
      `域名必须是普通 ASCII 测试域名（不支持 IP、IDN 或端口外的特殊主机）: ${host}`
    );
  }
  return { protocol: url.protocol, host, path: url.pathname || "/" };
}

export class CookieError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** RFC 6265 默认路径算法。 */
export function defaultPath(urlPath: string): string {
  if (!urlPath.startsWith("/")) return "/";
  const lastSlash = urlPath.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return urlPath.slice(0, lastSlash);
}

/**
 * 解析单条 Set-Cookie 头。调用方必须按“每条响应头一个字符串”传入，
 * 本函数绝不按逗号切分（Expires 日期中合法包含逗号）。
 */
export function parseSetCookie(header: string): ParsedSetCookie {
  const errors: string[] = [];
  const ignored: string[] = [];
  const parts = header.split(";");
  const first = parts.shift() ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) {
    throw new CookieError("INVALID_COOKIE", `Set-Cookie 缺少合法的 name=value: ${header}`);
  }
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name || /[()<>@,;:\\"/\[\]?={}\s]/.test(name)) {
    throw new CookieError("INVALID_COOKIE", `Cookie 名称含非法字符: "${name}"`);
  }

  const out: ParsedSetCookie = { name, value, secure: false, ignored, errors };

  for (const rawAttr of parts) {
    const attr = rawAttr.trim();
    if (!attr) continue;
    const attrEq = attr.indexOf("=");
    const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();

    switch (attrName) {
      case "domain": {
        const d = attrValue.replace(/^\.+/, "").toLowerCase();
        if (!d || !isValidDomain(d)) {
          errors.push(`Domain 属性非法，已忽略: "${attrValue}"`);
        } else {
          out.domain = d;
        }
        break;
      }
      case "path":
        if (attrValue.startsWith("/")) out.path = attrValue;
        else errors.push(`Path 属性未以 / 开头，将使用默认路径: "${attrValue}"`);
        break;
      case "secure":
        out.secure = true;
        break;
      case "max-age": {
        const n = Number(attrValue);
        if (!Number.isInteger(n)) errors.push(`Max-Age 不是整数，已忽略: "${attrValue}"`);
        else out.maxAge = n;
        break;
      }
      case "expires": {
        const t = Date.parse(attrValue);
        if (Number.isNaN(t)) errors.push(`Expires 日期无法解析，已忽略: "${attrValue}"`);
        else out.expires = t;
        break;
      }
      case "httponly":
        ignored.push("HttpOnly：本服务不执行脚本，仅记录该标记");
        break;
      case "samesite":
        ignored.push(`SameSite=${attrValue || "(无值)"}：不实现 SameSite 策略，仅记录`);
        break;
      case "partitioned":
        ignored.push("Partitioned：不支持分区 Cookie（CHIPS）");
        break;
      default:
        ignored.push(`未知属性 ${(attrEq === -1 ? attr : attr.slice(0, attrEq)).trim()}${attrValue ? `=${attrValue}` : ""}：已忽略`);
    }
  }
  return out;
}

/** 域名匹配：host 等于 domain，或 host 以 "."+domain 结尾（点边界）。 */
export function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith("." + domain);
}

/** 路径匹配：相等、或前缀且 path 以 / 结尾、或前缀后下一字符为 /（斜杠边界）。 */
export function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (reqPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith("/")) return true;
    return reqPath[cookiePath.length] === "/";
  }
  return false;
}

export interface MatchDecision {
  included: boolean;
  reasons: string[];
}

/** 判断某条已存 Cookie 是否应随请求发送。 */
export function matchCookie(
  c: CookieRecord,
  req: { protocol: string; host: string; path: string },
  now: number
): MatchDecision {
  const reasons: string[] = [];
  if (c.expiresAt !== null && c.expiresAt <= now) {
    reasons.push(`已过期（expiresAt=${new Date(c.expiresAt).toISOString()} <= now）`);
    return { included: false, reasons };
  }
  if (c.secure && req.protocol !== "https:") {
    reasons.push("Secure Cookie 不随非 HTTPS 请求发送");
    return { included: false, reasons };
  }
  if (c.hostOnly) {
    if (req.host !== c.domain) {
      reasons.push(`host-only：请求主机 ${req.host} 不等于 ${c.domain}`);
      return { included: false, reasons };
    }
    reasons.push(`host-only 精确匹配 ${c.domain}`);
  } else {
    if (!domainMatch(req.host, c.domain)) {
      reasons.push(`域名不匹配：${req.host} 不属于 ${c.domain}（点边界检查失败）`);
      return { included: false, reasons };
    }
    reasons.push(`Domain 匹配 ${c.domain}`);
  }
  if (!pathMatch(req.path, c.path)) {
    reasons.push(`路径不匹配：${req.path} 不在 ${c.path} 之下（斜杠边界检查失败）`);
    return { included: false, reasons };
  }
  reasons.push(`Path 匹配 ${c.path}`);
  return { included: true, reasons };
}

/** 发送排序：路径长者优先，其次创建顺序（creationSeq 升序）。 */
export function sortForSend(cookies: CookieRecord[]): CookieRecord[] {
  return [...cookies].sort((a, b) => {
    if (b.path.length !== a.path.length) return b.path.length - a.path.length;
    return a.creationSeq - b.creationSeq;
  });
}
