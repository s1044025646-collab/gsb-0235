import { ApiError, type ParsedSetCookie } from './types.js';

/**
 * 按分号切分单条 Set-Cookie（分号不会出现在合法日期字段中，
 * 日期内部的逗号因此被完整保留，避免“按逗号切分”的经典错误）。
 */
export function splitSegments(setCookie: string): string[] {
  return setCookie.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * 解析 RFC 6265 要求的宽松 cookie-date（允许 "Sat, 02 Oct 2021 07:10:00 GMT"
 * 这类带逗号的合法日期）。失败返回 NaN。
 */
export function parseCookieDate(input: string): number {
  const datePart = input.split(' ').filter(Boolean);
  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;
  let time: string | null = null;

  for (const tokenRaw of datePart) {
    // 去掉可能存在的星期前缀，如 "Sat,"；以冒号判断时间。
    const token = tokenRaw.replace(/,$/, '');
    if (/^\d{1,2}:\d{2}:\d{2}$/.test(token)) {
      time = token;
      continue;
    }
    const mon = MONTHS[token.toLowerCase().slice(0, 3)];
    if (mon !== undefined && /^[a-z]{3}/i.test(token)) {
      month = mon;
      continue;
    }
    if (/^\d{1,2}$/.test(token) && day === null) {
      day = Number(token);
      continue;
    }
    if (/^\d{2,4}$/.test(token)) {
      year = Number(token);
      continue;
    }
    // 形如 "02-Oct-2021" 的情况
    const dashed = token.split('-');
    if (dashed.length === 3) {
      const d = dashed[0]!;
      const m = MONTHS[dashed[1]!.toLowerCase().slice(0, 3)];
      const y = dashed[2]!;
      if (/^\d{1,2}$/.test(d) && m !== undefined && /^\d{2,4}$/.test(y)) {
        day = Number(d);
        month = m;
        year = Number(y);
        continue;
      }
    }
    // 无法识别的 token（如星期）直接忽略
  }

  if (day === null || month === null || year === null || time === null) return NaN;
  const [hStr, mStr, sStr] = time.split(':');
  const h = Number(hStr);
  const min = Number(mStr);
  const sec = Number(sStr);
  if (h > 23 || min > 59 || sec > 59) return NaN;
  if (day < 1 || day > 31) return NaN;
  if (year >= 70 && year <= 99) year += 1900;
  else if (year >= 0 && year <= 69) year += 2000;
  if (year < 1601) return NaN;

  const ms = Date.UTC(year, month, day, h, min, sec);
  if (Number.isNaN(ms)) return NaN;
  // Date.UTC 会对溢出日期进位（如 2 月 31 日），需要回查。
  const check = new Date(ms);
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return NaN;
  return ms;
}

const RECOGNIZED = new Set(['expires', 'max-age', 'domain', 'path', 'secure', 'httponly', 'samesite']);

/**
 * 解析单条 Set-Cookie 头部值（不含 "Set-Cookie:" 前缀）。
 * 只做语法解析，不做来源域校验（那是存储阶段的事）。
 */
export function parseSetCookie(setCookie: string): ParsedSetCookie {
  if (typeof setCookie !== 'string' || setCookie.trim() === '') {
    throw new ApiError('SETCOOKIE_EMPTY', 'Set-Cookie 不能为空', 400);
  }
  const segments = splitSegments(setCookie);
  const first = segments[0];
  if (!first || !first.includes('=')) {
    throw new ApiError('SETCOOKIE_NO_NAME_VALUE', 'Set-Cookie 首段必须是 name=value', 400);
  }
  const eq = first.indexOf('=');
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (name === '') {
    throw new ApiError('SETCOOKIE_NAME_EMPTY', 'Cookie 名不能为空', 400);
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new ApiError('SETCOOKIE_NAME_INVALID', `Cookie 名含非法字符：${name}`, 400);
  }

  const result: ParsedSetCookie = {
    name,
    value,
    domain: null,
    path: null,
    secure: false,
    httpOnly: false,
    sameSite: '',
    maxAge: null,
    expires: null,
    expiresInvalid: false,
    ignoredAttributes: [],
  };

  let sawMaxAge = false;
  for (const seg of segments.slice(1)) {
    const idx = seg.indexOf('=');
    const attrName = (idx === -1 ? seg : seg.slice(0, idx)).trim().toLowerCase();
    const attrValue = idx === -1 ? '' : seg.slice(idx + 1).trim();

    switch (attrName) {
      case 'expires':
        if (!sawMaxAge) {
          const t = parseCookieDate(attrValue);
          if (Number.isNaN(t)) result.expiresInvalid = true;
          else result.expires = t;
        }
        break;
      case 'max-age': {
        const m = /^-?\d+$/.test(attrValue) ? Number(attrValue) : NaN;
        if (!Number.isNaN(m)) {
          result.maxAge = m * 1000;
          sawMaxAge = true;
          result.expires = null; // Max-Age 优先：出现后忽略 Expires
        } else {
          result.ignoredAttributes.push(`max-age(非法值:${attrValue})`);
        }
        break;
      }
      case 'domain':
        result.domain = attrValue.replace(/^\./, '').toLowerCase() || null;
        break;
      case 'path':
        result.path = attrValue.startsWith('/') ? attrValue : null;
        break;
      case 'secure':
        result.secure = true;
        break;
      case 'httponly':
        result.httpOnly = true;
        break;
      case 'samesite':
        result.sameSite = attrValue.toLowerCase();
        result.ignoredAttributes.push(`samesite(仅记录不执行:${attrValue || '空'})`);
        break;
      default:
        if (attrName && !RECOGNIZED.has(attrName)) {
          result.ignoredAttributes.push(attrName);
        }
    }
  }
  return result;
}
