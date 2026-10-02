import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Store } from '../src/db.ts';
import { CookieService } from '../src/service.ts';
import { parseCookieDate, parseSetCookie } from '../src/cookie.ts';
import { defaultPath, domainMatches, pathMatches, parseUrl } from '../src/util.ts';

const T = Date.UTC(2026, 9, 2, 8, 0, 0);

function setup(label: string) {
  const file = join(tmpdir(), `cjl-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(file);
  const svc = new CookieService(store);
  return {
    file,
    store,
    svc,
    close: () => { store.close(); rmSync(file, { force: true }); rmSync(file + '-wal', { force: true }); rmSync(file + '-shm', { force: true }); },
  };
}

test('domainMatches：host-only 全等，Domain 严格点边界', () => {
  assert.equal(domainMatches('shop.example.test', 'example.test', false), true);
  assert.equal(domainMatches('example.test', 'example.test', false), true);
  assert.equal(domainMatches('notexample.test', 'example.test', false), false);
  assert.equal(domainMatches('xexample.test', 'example.test', false), false);
  assert.equal(domainMatches('example.test', 'example.test', true), true);
  assert.equal(domainMatches('shop.example.test', 'example.test', true), false);
});

test('pathMatches：斜杠边界而非任意前缀', () => {
  assert.equal(pathMatches('/foo/bar', '/foo/'), true);
  assert.equal(pathMatches('/foo/bar', '/foo'), true);   // 边界处是 /
  assert.equal(pathMatches('/foobar', '/foo'), false);  // 经典子串误匹配
  assert.equal(pathMatches('/foo', '/foo/'), false);
  assert.equal(pathMatches('/foo', '/foo'), true);
});

test('defaultPath：按 RFC 5.1.4 计算', () => {
  assert.equal(defaultPath('/'), '/');
  assert.equal(defaultPath('/a'), '/');
  assert.equal(defaultPath('/a/b'), '/a');
  assert.equal(defaultPath('/a/b/c'), '/a/b');
});

test('parseCookieDate 接受合法日期中的逗号，拒绝非法日期', () => {
  assert.equal(parseCookieDate('Sat, 02 Oct 2021 07:10:00 GMT'), Date.UTC(2021, 9, 2, 7, 10, 0));
  assert.equal(parseCookieDate('02 Oct 2021 07:10:00 GMT'), Date.UTC(2021, 9, 2, 7, 10, 0));
  assert.ok(Number.isNaN(parseCookieDate('not a date')));
  assert.ok(Number.isNaN(parseCookieDate('31 Feb 2021 00:00:00 GMT')));
});

test('URL 校验：拒绝 IDN、IP、非 http(s)', () => {
  assert.equal(parseUrl('https://a.example.test/x').host, 'a.example.test');
  assert.throws(() => parseUrl('ftp://a.example.test/'), (e: Error & { code?: string }) => e.code === 'URL_SCHEME_UNSUPPORTED');
  assert.throws(() => parseUrl('http://127.0.0.1/'), (e: Error & { code?: string }) => e.code === 'URL_IP_UNSUPPORTED');
  assert.throws(
    () => parseUrl('http://例え.test/'),
    (e: Error & { code?: string }) => e.code === 'URL_IDN_UNSUPPORTED' || e.code === 'URL_HOST_INVALID',
  );
});

test('host-only 与 Domain 的区别', () => {
  const { svc, close } = setup('hostdomain');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://shop.example.test/', [
    'a=1; Path=/',
    'b=2; Domain=example.test; Path=/',
  ], T);
  // host-only 只发给来源主机本身
  assert.equal(svc.previewRequest(jar.id, 'https://shop.example.test/', T).cookieHeader, 'a=1; b=2');
  // 子域只能拿到 Domain cookie
  assert.equal(svc.previewRequest(jar.id, 'https://www.example.test/', T).cookieHeader, 'b=2');
  // 任意后缀伪装域拿不到任何 cookie
  assert.equal(svc.previewRequest(jar.id, 'https://notexample.test/', T).cookieHeader, '');
  close();
});

test('来源域不匹配时拒绝 Domain cookie', () => {
  const { svc, close } = setup('reject-domain');
  const jar = svc.createJar('j', T);
  const r = svc.importSetCookies(jar.id, 'https://shop.example.test/', ['x=1; Domain=other.test'], T);
  assert.equal(r[0]!.accepted, false);
  assert.equal(r[0]!.reason.includes('domain-reject'), true);
  assert.equal(svc.listCookies(jar.id).length, 0);
  close();
});

test('默认路径：来源 /cart/checkout 且无 Path 属性时默认 /cart', () => {
  const { svc, close } = setup('default-path');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://shop.example.test/cart/checkout', ['x=1'], T);
  assert.equal(svc.listCookies(jar.id)[0]!.path, '/cart');
  assert.equal(svc.previewRequest(jar.id, 'https://shop.example.test/cart/pay', T).cookieHeader, 'x=1');
  assert.equal(svc.previewRequest(jar.id, 'https://shop.example.test/home', T).cookieHeader, '');
  close();
});

test('Path 非法值时回退默认路径', () => {
  const { svc, close } = setup('bad-path');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://h.example.test/a/b', ['x=1; Path=relative'], T);
  assert.equal(svc.listCookies(jar.id)[0]!.path, '/a');
  close();
});

test('Max-Age 优先于 Expires（即使 Expires 在过去）', () => {
  const { svc, close } = setup('maxage-priority');
  const jar = svc.createJar('j', T);
  const r = svc.importSetCookies(jar.id, 'https://h.example.test/', [
    'x=1; Max-Age=100; Expires=Sat, 02 Oct 2021 07:10:00 GMT',
  ], T);
  assert.equal(r[0]!.action, 'stored');
  const c = svc.listCookies(jar.id)[0]!;
  assert.equal(c.expires_at, T + 100_000);
  // Expires 单独在过去则删除
  svc.importSetCookies(jar.id, 'https://h.example.test/', ['y=2; Expires=Sat, 02 Oct 2021 07:10:00 GMT'], T);
  assert.equal(svc.listCookies(jar.id).find((c) => c.name === 'y'), undefined);
  close();
});

test('非正 Max-Age 表示删除；删除命中与 no-op', () => {
  const { svc, close } = setup('delete');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://h.example.test/', ['k=v; Path=/'], T);
  const r1 = svc.importSetCookies(jar.id, 'https://h.example.test/', ['k=new; Max-Age=0; Path=/'], T);
  assert.equal(r1[0]!.action, 'deleted');
  assert.equal(svc.listCookies(jar.id).length, 0);
  const r2 = svc.importSetCookies(jar.id, 'https://h.example.test/', ['ghost=v; Max-Age=-5; Path=/'], T);
  assert.equal(r2[0]!.action, 'deleted');
  assert.equal(svc.listCookies(jar.id).length, 0);
  close();
});

test('同名不同域/路径分别保存；同一标识替换且保留序号', () => {
  const { svc, close } = setup('replace');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://shop.example.test/', [
    'a=1; Path=/',
    'a=2; Path=/sub',
  ], T);
  svc.importSetCookies(jar.id, 'https://www.example.test/', ['a=3; Domain=example.test; Path=/'], T);
  const before = svc.listCookies(jar.id);
  assert.equal(before.length, 3);
  const firstSeq = before.find((c) => c.path === '/' && c.host_only === 1)!.created_seq;
  const rep = svc.importSetCookies(jar.id, 'https://shop.example.test/', ['a=99; Path=/'], T);
  assert.equal(rep[0]!.action, 'replaced');
  const after = svc.listCookies(jar.id);
  assert.equal(after.length, 3);
  assert.equal(after.find((c) => c.path === '/' && c.host_only === 1)!.value, '99');
  assert.equal(after.find((c) => c.path === '/' && c.host_only === 1)!.created_seq, firstSeq);
  close();
});

test('空值 Cookie 合法并正确发送', () => {
  const { svc, close } = setup('empty-value');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://h.example.test/', ['empty=; Path=/', 'n=v; Path=/'], T);
  assert.equal(svc.previewRequest(jar.id, 'https://h.example.test/', T).cookieHeader, 'empty=; n=v');
  close();
});

test('Secure 只随 HTTPS 发送', () => {
  const { svc, close } = setup('secure');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://h.example.test/', ['s=1; Secure; Path=/', 'p=2; Path=/'], T);
  assert.equal(svc.previewRequest(jar.id, 'http://h.example.test/', T).cookieHeader, 'p=2');
  const ex = svc.previewRequest(jar.id, 'http://h.example.test/', T).excluded.find((v) => v.cookie.name === 's');
  assert.equal(ex!.reason, 'secure-http-blocked');
  assert.equal(svc.previewRequest(jar.id, 'https://h.example.test/', T).cookieHeader, 's=1; p=2');
  close();
});

test('过期项不发送且可清理', () => {
  const { svc, close } = setup('expiry');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://h.example.test/', ['m=1; Max-Age=60; Path=/', 'f=2; Path=/'], T);
  const later = T + 61_000;
  const r = svc.previewRequest(jar.id, 'https://h.example.test/', later);
  assert.equal(r.cookieHeader, 'f=2');
  assert.equal(r.excluded.find((v) => v.cookie.name === 'm')!.reason, 'expired');
  const purged = svc.purge(later);
  assert.equal(purged.total, 1);
  assert.equal(svc.listCookies(jar.id).length, 1);
  close();
});

test('发送顺序：路径长度优先，再按创建顺序；同名项可同时保留', () => {
  const { svc, close } = setup('ordering');
  const jar = svc.createJar('j', T);
  svc.importSetCookies(jar.id, 'https://shop.example.test/', [
    'c=root; Path=/',
    'c=long; Path=/a/b/c',
    'c=mid; Path=/a',
  ], T);
  assert.equal(
    svc.previewRequest(jar.id, 'https://shop.example.test/a/b/c', T).cookieHeader,
    'c=long; c=mid; c=root',
  );
  close();
});

test('SameSite 等属性记录到报告但不执行', () => {
  const parsed = parseSetCookie('a=1; SameSite=Strict; Priority=High');
  assert.ok(parsed.ignoredAttributes.some((x) => x.startsWith('samesite')));
  assert.ok(parsed.ignoredAttributes.includes('priority'));
});

test('jar 之间互不污染', () => {
  const { svc, close } = setup('isolation');
  const j1 = svc.createJar('j1', T);
  const j2 = svc.createJar('j2', T);
  svc.importSetCookies(j1.id, 'https://h.example.test/', ['x=1; Path=/'], T);
  assert.equal(svc.listCookies(j1.id).length, 1);
  assert.equal(svc.listCookies(j2.id).length, 0);
  assert.equal(svc.previewRequest(j2.id, 'https://h.example.test/', T).cookieHeader, '');
  close();
});

test('会话 Cookie：session-end 清除；持久 Cookie 保留；可跨“重启”读取', () => {
  const file = join(tmpdir(), `cjl-restart-${process.pid}-${Date.now()}.db`);
  {
    const store = new Store(file);
    const svc = new CookieService(store);
    const jar = svc.createJar('persist', T);
    svc.importSetCookies(jar.id, 'https://h.example.test/', [
      'session=1; Path=/',
      'persistent=2; Max-Age=999999; Path=/',
    ], T);
    store.close();
  }
  // 模拟服务重启：重新打开同一数据库文件，持久数据仍在。
  {
    const store = new Store(file);
    const svc = new CookieService(store);
    const jar = svc.listJars()[0]!;
    const rows = svc.listCookies(jar.id);
    assert.equal(rows.length, 2);
    assert.equal(svc.previewRequest(jar.id, 'https://h.example.test/', T).cookieHeader, 'session=1; persistent=2');
    // 会话边界：显式结束会话只删除会话 Cookie。
    const ended = svc.endSession(jar.id, T);
    assert.equal(ended.cleared, 1);
    assert.equal(svc.previewRequest(jar.id, 'https://h.example.test/', T).cookieHeader, 'persistent=2');
    store.close();
  }
  rmSync(file, { force: true });
  rmSync(file + '-wal', { force: true });
  rmSync(file + '-shm', { force: true });
});
