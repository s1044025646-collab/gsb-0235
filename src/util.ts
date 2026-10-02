import { ApiError, type UrlInfo } from './types.js';

/**
 * 校验普通 ASCII 测试域名/主机。
 * 仅接受小写或可小写化的 ASCII 标签：字母数字与连字符，标签不以连字符开头/结尾。
 * 不做公共后缀判断、不做真实可解析性判断，也不接受国际化域名（IDN）。
 */
const ASCII_HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function isValidAsciiHost(host: string): boolean {
  if (!host) return false;
  if (host.includes('xn--')) return false;
  return ASCII_HOST.test(host);
}

/**
 * 解析并严格校验 URL。只允许 http/https、ASCII 主机、必须是非 IP 测试域名风格。
 * 为保持实验范围明确，这里不接受 IPv4/IPv6 字面量。
 */
export function parseUrl(raw: string): UrlInfo {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError('URL_EMPTY', 'URL 不能为空', 400);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError('URL_INVALID', `不是合法 URL：${raw}`, 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ApiError('URL_SCHEME_UNSUPPORTED', `仅支持 http/https，收到 ${u.protocol}`, 400);
  }
  if (u.username || u.password) {
    throw new ApiError('URL_CREDENTIALS_UNSUPPORTED', 'URL 中不允许包含用户名/密码', 400);
  }
  // URL.hostname 会去掉方括号；检查是否含非 ASCII。
  const host = u.hostname.toLowerCase();
  if (/[^\x20-\x7f]/.test(host)) {
    throw new ApiError('URL_IDN_UNSUPPORTED', '不支持国际化域名（IDN），请使用 ASCII 测试域名', 400);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    throw new ApiError('URL_IP_UNSUPPORTED', '本实验不接受 IP 字面量主机', 400);
  }
  if (!isValidAsciiHost(host)) {
    throw new ApiError('URL_HOST_INVALID', `主机名不合法或不是普通 ASCII 域名：${host}`, 400);
  }
  const port = u.port ? Number(u.port) : null;
  return {
    protocol: u.protocol === 'https:' ? 'https' : 'http',
    host,
    port,
    path: u.pathname || '/',
  };
}

/**
 * RFC 6265 5.1.4 默认路径计算。
 */
export function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  // 路径不以 "/" 开头的情况已被排除；找除首字符外的最后一个 "/"。
  const lastSlash = requestPath.lastIndexOf('/');
  if (lastSlash === 0) return '/';
  return requestPath.slice(0, lastSlash);
}

/**
 * 域名归属判断（RFC 6262 5.1.3 思路，严格边界）。
 * - hostOnly：请求主机必须与 cookie 域完全相等。
 * - Domain cookie：请求主机等于域，或是域的子域（必须以 "." + 域 结尾）。
 * 不使用任意后缀/子串包含，杜绝 notexample.test 误匹配 example.test。
 */
export function domainMatches(requestHost: string, cookieDomain: string, hostOnly: boolean): boolean {
  if (hostOnly) return requestHost === cookieDomain;
  if (requestHost === cookieDomain) return true;
  return requestHost.endsWith('.' + cookieDomain);
}

/**
 * 路径匹配（RFC 6265 5.1.4）。
 * 匹配条件：请求路径 == cookie 路径，
 * 或请求路径以 cookie 路径为前缀且 cookie 路径以 "/" 结尾，
 * 或前缀后紧跟 "/"。严格检查斜杠边界。
 */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath.charAt(cookiePath.length) === '/';
}

/** 生成形如 a=1; b=2 的 Cookie 头值。 */
export function buildCookieHeader(pairs: Array<{ name: string; value: string }>): string {
  return pairs.map((p) => `${p.name}=${p.value}`).join('; ');
}

export function nowMs(): number {
  return Date.now();
}
