/**
 * 核心数据类型定义。
 * 时间统一使用 Unix 毫秒时间戳（number），便于测试注入固定时间。
 */

/** 规范化后的 URL 视图（仅保留 Cookie 规则需要的部分）。 */
export interface UrlInfo {
  /** 小写后的 scheme，仅允许 http / https。 */
  protocol: 'http' | 'https';
  /** 小写后的 ASCII 主机名（无端口、无尾点）。 */
  host: string;
  /** 端口，仅用于展示，不参与 Cookie 匹配。 */
  port: number | null;
  /** 路径，保证以 "/" 开头，默认 "/"。 */
  path: string;
}

/** 数据库中的一条 Cookie 记录。 */
export interface CookieRow {
  id: number;
  jar_id: number;
  name: string;
  value: string;
  /** 归属域（已小写、去前导点）。 */
  domain: string;
  /** 1 表示 host-only（无 Domain 属性）；0 表示 Domain cookie。 */
  host_only: number;
  path: string;
  /** 1 表示带 Secure 属性。 */
  secure: number;
  /** 0/1（SQLite 无布尔）。 */
  http_only: number;
  /** SameSite 原始取值，仅记录不执行；空串表示未提供。 */
  same_site: string;
  /** 到期毫秒时间戳；null 表示会话 Cookie。 */
  expires_at: number | null;
  /** 稳定排序用：首次写入序号；替换同名项时保留。 */
  created_seq: number;
  created_at: number;
  last_seen: number;
  update_count: number;
}

export interface JarRow {
  id: number;
  name: string;
  created_at: number;
}

/** 解析单条 Set-Cookie 后得到的待存储信息（尚未决定接受/拒绝）。 */
export interface ParsedSetCookie {
  name: string;
  value: string;
  domain: string | null;
  path: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  /** Max-Age 解析后毫秒偏移；若提供。 */
  maxAge: number | null;
  /** Expires 是否提供及解析后的毫秒值；非法日期为 NaN。 */
  expires: number | null;
  expiresInvalid: boolean;
  /** 未识别/忽略的属性名列表，用于报告。 */
  ignoredAttributes: string[];
}

/** 单个 Cookie 在某次请求预览中的判定结果。 */
export interface CookieVerdict {
  cookie: CookieRow;
  selected: boolean;
  /** 选入或排除的稳定原因码，例如 path-mismatch。 */
  reason: string;
  /** 面向人的中文说明。 */
  detail: string;
}

export interface MatchResult {
  requestUrl: string;
  jarId: number;
  now: number;
  /** 形如 "a=1; b=2" 的最终 Cookie 头；无匹配时为空串。 */
  cookieHeader: string;
  selected: CookieVerdict[];
  excluded: CookieVerdict[];
}

/** 导入一条 Set-Cookie 的逐条结果。 */
export interface ImportResult {
  index: number;
  setCookie: string;
  accepted: boolean;
  action: 'stored' | 'replaced' | 'deleted' | 'rejected';
  reason: string;
  cookie: CookieRow | null;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
