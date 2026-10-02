# Cookie Jar 实验服务（纯本地，虚构数据）

一个 Windows 本地可运行的 HTTP Cookie 存储与请求匹配后端，使用 TypeScript + Node.js + SQLite（node:sqlite，零原生依赖）。只提供 API 与 CLI，不读取浏览器账户或真实登录信息，不发起任何外部 HTTP 请求。所有来源 URL 与 Cookie 文本均由用户显式提供，仅用于按规则实验“存哪些、发哪些”。

## 环境与安装

- 要求 Node.js >= 22.5（开发使用 Node 25 验证；node:sqlite 目前带 ExperimentalWarning，属正常提示）。
- 不需要 Docker / WSL / 付费服务 / 外部在线 API。

```powershell
npm install     # 仅安装 typescript 与 @types/node（开发依赖）
npm run build   # 编译到 dist/
npm test        # 运行全部测试（固定时间，node:test）
npm start       # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo    # 运行 example.test 虚构场景演示
```

## 范围与明确限制

- 仅支持普通 ASCII 测试域名（如 example.test 及其子域）；不支持公共后缀列表（PSL）、国际化域名（IDN/punycode）、IP 地址主机。
- 不实现 SameSite、HttpOnly 语义、Partitioned/CHIPS、浏览器同步、登录或爬虫；这些属性在导入报告中标记为“已忽略并说明”。
- 重点是按给定规则正确存储与选取 Cookie，而非完整浏览器安全策略。

## 支持的属性与时间模型

- 支持：Domain、Path（含 RFC 6265 默认路径）、Secure、Max-Age、Expires。
- Max-Age 优先于 Expires；Max-Age <= 0 或已过期的 Expires 表示删除同标识 Cookie。
- 过期项不发送；Secure 只随 HTTPS 请求发送。
- 未设期限的为会话 Cookie：服务进程的一次运行即一个 jar 会话；服务重启时会清除上一会话遗留的会话 Cookie（持久 Cookie 保留）。
- 当前时间可注入：API/CLI 均接受 now 参数（ISO 字符串或毫秒），测试全部使用固定时间。
- 多条 Set-Cookie 响应头必须逐条传入（数组元素），绝不按逗号切分——Expires=Wed, 21 Oct ... 中的逗号是合法日期内容。

## 关键匹配规则

- 域名：host-only（未设 Domain）要求请求主机与存储主机完全相等；设了 Domain 则要求 host === domain 或 host 以 "."+domain 结尾（点边界，badexample.test 不匹配 example.test）。Domain 与来源主机不匹配时整条拒绝写入。
- 路径：相等、或请求路径以 Cookie 路径为前缀且（Cookie 路径以 / 结尾或下一字符为 /）（斜杠边界，/v1 不匹配 /v10）。默认路径取来源 URL 路径去掉最后一段。
- 标识与替换：以 (jar, name, domain, path) 为唯一标识；同名不同域/路径分别保存；同标识新值替换旧值并保留原创建顺序。
- 发送排序：路径长者优先，其次按创建顺序，稳定且保留同名不同项。

## HTTP API

默认绑定 127.0.0.1，--port 0（默认）自动选择空闲端口；也可用 --port N 或环境变量 PORT 指定。数据文件默认 data/cookies.db，可用 --data PATH 更改。

```powershell
node dist/server.js [--port N] [--data PATH]
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /health | 健康检查 |
| POST | /jars | 创建 jar，body {"name":"demo"} |
| GET | /jars | 列出 jar |
| DELETE | /jars/:idOrName | 删除 jar 及其全部数据 |
| POST | /jars/:id/cookies | 导入，body {"url": 来源URL, "setCookies": [...], "now": 可选} |
| GET | /jars/:id/cookies | 列出存储项 |
| POST | /jars/:id/match | 预览请求，body {"url": 目标URL, "now": 可选}，返回 Cookie 头与每项选入/排除原因 |
| POST | /jars/:id/purge | 清理过期项，body {"now": 可选} |

错误统一为 {"error":{"code","message"}}，错误码包括：INVALID_URL、INVALID_DOMAIN、INVALID_COOKIE、BAD_REQUEST、BAD_JSON、JAR_NOT_FOUND、JAR_EXISTS、NOT_FOUND、INTERNAL。

## CLI

```powershell
node dist/cli.js create-jar --name demo
node dist/cli.js list-jars
node dist/cli.js import --jar demo --url "https://app.example.test/login" `
  --set-cookie "sid=abc; Path=/; Secure" `
  --set-cookie "pref=dark; Domain=example.test; Expires=Wed, 21 Oct 2026 07:28:00 GMT" `
  --now 2026-01-01T00:00:00Z
node dist/cli.js list --jar demo
node dist/cli.js preview --jar demo --url "https://sub.example.test/" --now 2026-01-01T00:00:00Z
node dist/cli.js purge --jar demo
node dist/cli.js delete-jar --jar demo
node dist/cli.js demo
```

通用参数：--data PATH 指定数据库文件；--now 注入当前时间（ISO 或毫秒）。demo 命令演示 host-only 与 Domain 区别、不同 Path、HTTP 与 HTTPS、过期删除与同名排序。

## 数据存储

SQLite 单文件（默认 data/cookies.db），表：jars、cookies（接受的属性、创建/到期时间、创建序号、所属会话）、operations（操作日志）、match_reports（匹配报告）。不同 jar 通过 jar_id 完全隔离。

## 项目结构

- src/cookie.ts — Set-Cookie 解析、域/路径匹配、排序
- src/store.ts — SQLite 持久化
- src/service.ts — 导入/预览/清理业务逻辑
- src/server.ts — HTTP API
- src/cli.ts — CLI 与演示
- test/service.test.ts — 18 个固定时间测试
