# Cookie Jar Lab（本地 Cookie 存储与请求匹配实验服务）

一个只做后端的 **HTTP Cookie jar 实验服务**。它管理多个相互隔离的 jar，
记录你显式提供的“响应来源 URL + Set-Cookie 文本”，然后对给定的目标请求 URL
预览会发送的 `Cookie` 头，并逐项给出**选入 / 排除原因**。

> 全部使用 `example.test` 之类的**虚构测试数据**。
> 不读取浏览器账户或真实登录信息，不实际发起任何外部 HTTP 请求，不做爬虫、同步。

技术栈：**TypeScript + Node.js + SQLite（内置 `node:sqlite`）**。
无需 Docker、WSL、付费服务或在线 API，在 Windows 本地即可运行。

---

## 1. 环境要求

- Node.js **>= 22.5**（开发与验证使用 Node 25；内置 `node:sqlite`，无需原生编译）。
- npm。

## 2. 快速开始

```powershell
npm install        # 安装 typescript / tsx / @types/node
npm run build    # 类型检查并编译到 dist/
npm test         # 运行全部 19 个测试（固定时间，无需网络）
npm run demo     # 用虚构数据跑一遍完整演示（CLI，自动建 data/demo.db）
npm start        # 启动 HTTP API（默认让系统选择空闲端口）
```

指定端口启动：

```powershell
node dist/server.js --port 8080
# 或
$env:PORT=8080; npm start
```

启动后会打印实际监听地址，例如 `http://127.0.0.1:53124`，数据保存在项目内
`data/cookiejar.db`（可用环境变量 `COOKIEJAR_DB` 覆盖）。

## 3. 支持的属性与时间模型

支持：`Domain`、`Path`（含默认路径）、`Secure`、`Max-Age`、`Expires`、`HttpOnly`（存储/记录）。

| 属性 | 行为 |
| --- | --- |
| 无 `Domain` | **host-only**，只发回确切来源主机 |
| `Domain=x` | 归属域去掉前导点并小写；来源主机必须等于该域或为其子域，否则拒绝存储 |
| 无 `Path` | 默认路径按 RFC 6265 §5.1.4：取来源路径除最后一段外的目录 |
| `Path` | 必须以 `/` 开头，否则忽略该属性、回退默认路径 |
| `Secure` | 仅在 **HTTPS** 请求中发送 |
| `Max-Age` | **优先于** `Expires`；`<=0` 表示立即删除；相对当前时间计算绝对到期点 |
| `Expires` | 解析宽松 cookie-date（允许 `Sat, 02 Oct 2021 07:10:00 GMT` 这种**含逗号**的日期）；过去时间=删除；无法解析则拒绝 |
| `HttpOnly` | 存储并记录；本服务不区分脚本/HTTP 上下文，故不影响匹配 |
| `SameSite` / 其他 | **原样记录并在报告中标注“仅记录不执行”**，不伪装成完整浏览器行为 |

**时间模型**：所有写操作和匹配都接受可注入的 `now`（Unix 毫秒）。
- API 的 `/import`、`/preview`、`/purge` 请求体均可带 `"now": 1790928000000`。
- CLI `preview`/`purge` 支持 `--now <毫秒>`，也可用环境变量 `COOKIEJAR_NOW` 固定全局时间。
- 测试与演示都使用固定时间，结果可复现。

## 4. 关键匹配规则（严格边界）

存储标识（同一标识的新值会**替换**）：`(jar, name, domain, path)`。
同名但域或路径不同的 Cookie **分别保存**。

对目标请求，按下列顺序逐项判定（第一项失败即排除并给出原因码）：

1. `expired`：`expires_at <= now` 的持久 Cookie 不发送（清理前仍保留在库里）。
2. `domain-mismatch`：
   - host-only：请求主机必须与归属域**完全相等**；
   - Domain：请求主机等于归属域，**或**以 `.归属域` 结尾（点边界）。
   - 因此 `notexample.test`、`xexample.test` **绝不会**匹配 `example.test`，杜绝任意后缀/子串放行。
3. `path-mismatch`：请求路径等于 Cookie 路径，或在其斜杠边界之下
   （`/foo` 匹配 `/foo/bar`，但**不**匹配 `/foobar`）。
4. `secure-http-blocked`：带 `Secure` 的 Cookie 在 `http://` 请求中不发送。

发送顺序：先按 **Cookie 路径长度降序**，长度相同再按 **创建顺序 `created_seq` 升序**；
同名但符合条件的不同项会**同时保留**并拼成 `a=1; a=2` 形式。
替换既有项时**保留原 `created_seq`**，因此顺序稳定。

## 5. 会话 Cookie 与服务重启

- 没有 `Max-Age`/`Expires` 的是**会话 Cookie**（`expires_at = NULL`）。
- **会话边界是显式的**：调用 `DELETE /jars/{id}/session`（CLI `session-end`）结束该 jar 会话，
  只删除该 jar 的会话 Cookie，持久 Cookie 保留。
- **重启处理**：为简单可预测，服务进程重启**不会自动清空**任何数据；
  SQLite 中持久 Cookie 和会话 Cookie 都仍在磁盘上，是否结束会话由你显式调用。
  测试 `会话 Cookie：session-end 清除；持久 Cookie 保留；可跨“重启”读取` 覆盖了重开同一 DB 文件的场景。

## 6. 明确不支持的范围（限制）

- **不做公共后缀列表（PSL）判断**：`Domain=com` 之类是否可设置不做浏览器式校验，仅做来源域父子关系校验。
- **不支持国际化域名（IDN / punycode 视觉处理）**，主机限普通 ASCII 测试域名；不接受 IP 字面量。
- **不实现 SameSite、__Host- 前缀、名称前缀安全策略、分区/沙箱、真实 HttpOnly 上下文**等完整浏览器策略。
- 不做真实网络请求、不校验证书、不处理重定向、不跟踪 `__Secure-` 之外的前缀语义。

## 7. HTTP API

所有请求/响应均为 JSON。错误统一形如 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与当前时间 |
| GET | `/jars` | 列出 jar |
| POST | `/jars` | body `{"name":"shop"}` | 创建 jar（重名返回 `409 JAR_EXISTS`） |
| GET | `/jars/{id}/cookies` | 列出存储项 |
| POST | `/jars/{id}/import` | 导入多条 Set-Cookie（见下） |
| POST | `/jars/{id}/preview` | 预览请求 Cookie 头 + 逐项原因 |
| POST | `/jars/{id}/purge` | 清理过期项（body 可选 `{"now":...}`） |
| DELETE | `/jars/{id}/session` | 结束会话，删除会话 Cookie |
| GET | `/jars/{id}/operations` | 操作记录 |

`/import` 请求体：

```json
{
  "sourceUrl": "https://shop.example.test/cart/checkout",
  "setCookies": [
    "sid=abc; Path=/cart; HttpOnly",
    "old=x; Expires=Sat, 02 Oct 2021 07:10:00 GMT; Path=/",
    "kill=v; Max-Age=0; Path=/"
  ],
  "now": 1790928000000
}
```

`setCookies` 的**每个元素是一条独立的响应头**；服务端只按分号切属性，
**绝不按逗号切分**，因此带逗号的 `Expires` 日期安全。
逐条返回 `accepted/action(stored|replaced|deleted|rejected)/reason`。

`/preview` 请求体：`{"requestUrl":"https://www.example.test/cart/pay","now":1790928000000}`，
响应含 `cookieHeader`、`selected[]`、`excluded[]`，每项带 `reason` 与中文 `detail`。

常见错误码：`URL_INVALID`、`URL_SCHEME_UNSUPPORTED`、`URL_IDN_UNSUPPORTED`、
`URL_IP_UNSUPPORTED`、`URL_HOST_INVALID`、`SETCOOKIE_NAME_INVALID`、
`JAR_NOT_FOUND(404)`、`JAR_EXISTS(409)`、`JSON_INVALID(400)`、`NOT_FOUND(404)`。

### curl / PowerShell 调用示例

```powershell
Invoke-RestMethod -Method Post -ContentType 'application/json' `
  -Body '{"name":"shop"}' http://127.0.0.1:8080/jars
```

## 8. CLI 完整命令

```powershell
# 构建后也可以直接用 node dist/cli.js ...
npx tsx src/cli.ts serve --port 8080
npx tsx src/cli.ts jar create shop
npx tsx src/cli.ts jar list
npx tsx src/cli.ts import 1 "https://shop.example.test/cart/checkout" `
  "sid=abc; Path=/cart" "ui=dark; Domain=example.test; Path=/"
npx tsx src/cli.ts cookies 1
npx tsx src/cli.ts preview 1 "https://www.example.test/cart/pay" --now 1790928000000
npx tsx src/cli.ts purge --now 1790940000000
npx tsx src/cli.ts session-end 1
npx tsx src/cli.ts operations 1
npx tsx src/cli.ts demo
```

## 9. 目录结构

```
src/
  types.ts    数据类型与错误
  util.ts     URL 校验、默认路径、域/路径严格边界匹配
  cookie.ts   Set-Cookie 解析、cookie-date 解析（保留日期中的逗号）
  db.ts       SQLite 表结构与读写（jars/cookies/operations/match_logs）
  service.ts  存储判定、替换/删除、请求匹配与排序
  server.ts   HTTP API（默认空闲端口）
  cli.ts     CLI 与内置 demo
test/cookie.test.ts  19 个规则测试
scripts/smoke.ps1  HTTP 端到端冒烟脚本
```

## 10. 数据库

SQLite 文件默认在 `data/cookiejar.db`（启用 WAL）。表：
`jars`、`cookies`（含 `expires_at`、`created_seq`、`update_count` 等）、
`operations`（每次存储/替换/删除/清理/会话结束）、`match_logs`（每次预览的完整判定报告 JSON）。
所有查询都带 `jar_id`，不同 jar **不会互相污染**。
