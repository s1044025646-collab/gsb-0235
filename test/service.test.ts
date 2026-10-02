import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { CookieService } from "../src/service.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");

let dir: string;
let store: Store;
let svc: CookieService;

function reopen() {
  store.close();
  store = new Store(path.join(dir, "test.db"));
  svc = new CookieService(store);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookiejar-"));
  store = new Store(path.join(dir, "test.db"));
  svc = new CookieService(store);
  svc.createJar("main", T0);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("来源域不匹配：Domain 不属于来源主机时拒绝", () => {
  const [r] = svc.importCookies("main", "https://app.example.test/", ["a=1; Domain=other.test"], T0);
  assert.equal(r.status, "rejected");
  assert.equal(svc.listCookies("main").length, 0);
});

test("host-only 精确匹配，子域不发送；Domain 允许子域", () => {
  svc.importCookies("main", "https://app.example.test/", [
    "h=1",
    "d=1; Domain=example.test",
  ], T0);
  const sub = svc.preview("main", "https://other.example.test/", T0);
  assert.equal(sub.header, "d=1");
  const apex = svc.preview("main", "https://example.test/", T0);
  assert.equal(apex.header, "d=1");
});

test("域名点边界：badexample.test 不匹配 example.test", () => {
  svc.importCookies("main", "https://example.test/", ["d=1; Domain=example.test"], T0);
  const r = svc.preview("main", "https://badexample.test/", T0);
  assert.equal(r.header, "");
});

test("路径斜杠边界：/v1 匹配 /v1/x 但不匹配 /v10", () => {
  svc.importCookies("main", "https://a.example.test/", ["p=1; Path=/v1"], T0);
  assert.equal(svc.preview("main", "https://a.example.test/v1/x", T0).header, "p=1");
  assert.equal(svc.preview("main", "https://a.example.test/v1", T0).header, "p=1");
  assert.equal(svc.preview("main", "https://a.example.test/v10", T0).header, "");
});

test("默认路径：来自 /a/b/c 的响应默认路径为 /a/b", () => {
  svc.importCookies("main", "https://a.example.test/a/b/c", ["x=1"], T0);
  const [c] = svc.listCookies("main");
  assert.equal(c.path, "/a/b");
  assert.equal(svc.preview("main", "https://a.example.test/a/b/d", T0).header, "x=1");
  assert.equal(svc.preview("main", "https://a.example.test/a/other", T0).header, "");
});

test("Max-Age 优先于 Expires", () => {
  const [r] = svc.importCookies("main", "https://a.example.test/", [
    "m=1; Max-Age=100; Expires=Wed, 01 Jan 2031 00:00:00 GMT",
  ], T0);
  assert.equal(r.cookie!.expiresAt, T0 + 100_000);
  assert.equal(svc.preview("main", "https://a.example.test/", T0 + 101_000).header, "");
});

test("非正 Max-Age 删除已有 Cookie", () => {
  svc.importCookies("main", "https://a.example.test/", ["k=1"], T0);
  const [r] = svc.importCookies("main", "https://a.example.test/", ["k=; Max-Age=0"], T0);
  assert.equal(r.status, "deleted");
  assert.equal(svc.listCookies("main").length, 0);
});

test("Expires 日期中的逗号不会导致切分错误", () => {
  const [r] = svc.importCookies("main", "https://a.example.test/", [
    "e=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
  ], T0);
  assert.equal(r.status, "stored");
  assert.equal(r.cookie!.expiresAt, Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"));
});

test("Secure 只随 HTTPS 发送", () => {
  svc.importCookies("main", "https://a.example.test/", ["s=1; Secure"], T0);
  assert.equal(svc.preview("main", "https://a.example.test/", T0).header, "s=1");
  assert.equal(svc.preview("main", "http://a.example.test/", T0).header, "");
});

test("同 (name,domain,path) 替换并保留创建顺序；不同 path 分别保存", () => {
  svc.importCookies("main", "https://a.example.test/", [
    "n=1; Path=/",
    "n=2; Path=/sub",
    "n=3; Path=/",
  ], T0);
  const list = svc.listCookies("main");
  assert.equal(list.length, 2);
  assert.equal(list.find((c) => c.path === "/")!.value, "3");
  // 发送顺序：路径长者优先
  assert.equal(svc.preview("main", "https://a.example.test/sub/x", T0).header, "n=2; n=3");
});

test("同名不同域分别保存，排序稳定", () => {
  svc.importCookies("main", "https://example.test/", ["n=root; Domain=example.test"], T0);
  svc.importCookies("main", "https://a.example.test/", ["n=sub"], T0);
  const r = svc.preview("main", "https://a.example.test/", T0);
  assert.equal(r.header, "n=root; n=sub"); // 同路径长度，按创建顺序
});

test("空值 Cookie 可存储与发送", () => {
  svc.importCookies("main", "https://a.example.test/", ["empty="], T0);
  assert.equal(svc.preview("main", "https://a.example.test/", T0).header, "empty=");
});

test("过期项不发送且可被清理", () => {
  svc.importCookies("main", "https://a.example.test/", ["t=1; Max-Age=5"], T0);
  assert.equal(svc.preview("main", "https://a.example.test/", T0 + 6_000).header, "");
  assert.equal(svc.purgeExpired("main", T0 + 6_000), 1);
  assert.equal(svc.listCookies("main").length, 0);
});

test("会话 Cookie 在服务重启（新会话）后被清除，持久 Cookie 保留", () => {
  svc.importCookies("main", "https://a.example.test/", [
    "sess=1",
    "perm=1; Max-Age=3600",
  ], T0);
  reopen();
  const names = svc.listCookies("main").map((c) => c.name);
  assert.deepEqual(names, ["perm"]);
});

test("不同 jar 互不影响", () => {
  svc.createJar("other", T0);
  svc.importCookies("main", "https://a.example.test/", ["x=1"], T0);
  assert.equal(svc.listCookies("other").length, 0);
  assert.equal(svc.preview("other", "https://a.example.test/", T0).header, "");
});

test("不支持的属性在报告中说明", () => {
  const [r] = svc.importCookies("main", "https://a.example.test/", [
    "u=1; SameSite=Lax; HttpOnly; Weird=zz",
  ], T0);
  assert.equal(r.status, "stored");
  assert.ok(r.ignored.some((s) => s.includes("SameSite")));
  assert.ok(r.ignored.some((s) => s.includes("HttpOnly")));
  assert.ok(r.ignored.some((s) => s.includes("Weird")));
});

test("预览报告包含每项选入/排除原因", () => {
  svc.importCookies("main", "https://a.example.test/", ["s=1; Secure", "o=1"], T0);
  const r = svc.preview("main", "http://a.example.test/", T0);
  const sec = r.results.find((x) => x.name === "s")!;
  assert.equal(sec.included, false);
  assert.ok(sec.reasons.some((s) => s.includes("Secure")));
});

test("参数校验：非法 URL 与不存在的 jar 返回明确错误码", () => {
  const codeOf = (fn: () => void) => {
    try { fn(); } catch (e) { return (e as { code?: string }).code; }
    return undefined;
  };
  assert.equal(codeOf(() => svc.importCookies("main", "not-a-url", ["a=1"], T0)), "INVALID_URL");
  assert.equal(codeOf(() => svc.listCookies("nope")), "JAR_NOT_FOUND");
  assert.equal(codeOf(() => svc.importCookies("main", "https://127.0.0.1/", ["a=1"], T0)), "INVALID_DOMAIN");
});
