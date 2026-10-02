#!/usr/bin/env node
import { join } from 'node:path';
import { Store } from './db.js';
import { CookieService } from './service.js';
import { startServer } from './server.js';

const T0 = Date.UTC(2026, 9, 2, 8, 0, 0); // 2026-10-02 08:00:00 UTC 固定演示时间

function dbPath() {
  return process.env.COOKIEJAR_DB ?? join(process.cwd(), 'data', 'cookiejar.db');
}

function withSvc<T>(fn: (s: CookieService) => T): T {
  const store = new Store(dbPath());
  try {
    return fn(new CookieService(store));
  } finally {
    store.close();
  }
}

const fmt = (v: unknown) => JSON.stringify(v, null, 2);

function help(): void {
  console.log(`cookie-jar-lab —— 本地 Cookie jar 实验 CLI

用法:
  cookiejar serve [--port <端口>]              启动 HTTP API（默认选空闲端口）
  cookiejar jar create <名称>                  创建 jar
  cookiejar jar list                           列出所有 jar
  cookiejar cookies <jarId>                    列出 jar 内存储项
  cookiejar import <jarId> <来源URL> <Set-Cookie> [<Set-Cookie>...]
                                              导入一条或多条独立 Set-Cookie 头
  cookiejar preview <jarId> <请求URL> [--now <毫秒>]  预览请求 Cookie 头及原因
  cookiejar purge [--now <毫秒>]               清理过期项
  cookiejar session-end <jarId>                结束会话（清除会话 Cookie）
  cookiejar operations <jarId>                 查看操作记录
  cookiejar demo                               运行内置虚构数据演示

环境变量:
  COOKIEJAR_DB   数据库路径（默认 ./data/cookiejar.db）
  COOKIEJAR_NOW  固定当前时间（毫秒，便于复现）
`);
}

function demo(): void {
  const path = dbPath().replace(/cookiejar\.db$/, 'demo.db');
  const store = new Store(path);
  const svc = new CookieService(store);
  const t = T0;
  const say = (title: string) => console.log(`\n=== ${title} ===`);

  say('创建独立 jar：shop 与 blog（互不污染）');
  const shop = svc.createJar('shop-demo', t);
  svc.createJar('blog-demo', t);
  console.log(fmt({ shop }));

  say('从 shop.example.test 导入多条 Set-Cookie（独立头，含带逗号的合法日期）');
  const imported = svc.importSetCookies(shop.id, 'https://shop.example.test/cart/checkout', [
    'sid=hostonly123; Path=/cart; HttpOnly',
    'theme=dark; Domain=example.test; Path=/',
    'track=abc; Domain=example.test; Path=/; Secure',
    'sess=alive; Max-Age=3600; Path=/',
    'old=gone; Expires=Sat, 02 Oct 2021 07:10:00 GMT; Path=/',
    'kill=now; Max-Age=0; Path=/',
    'kill=later; Max-Age=600; Path=/',
  ], t);
  console.log(fmt(imported.map((r) => ({ i: r.index, action: r.action, reason: r.reason }))));

  say('对 https://www.example.test/cart/checkout 的请求预览');
  console.log(fmt(svc.previewRequest(shop.id, 'https://www.example.test/cart/checkout', t)));

  say('对 http://example.test/ 的请求预览（Secure 项应被排除）');
  console.log(fmt(svc.previewRequest(shop.id, 'http://example.test/', t).excluded.map((v) => ({ name: v.cookie.name, reason: v.reason, detail: v.detail }))));

  say('对 https://notexample.test/ 的请求预览（域边界：绝不能匹配）');
  console.log(fmt(svc.previewRequest(shop.id, 'https://notexample.test/', t).selected));

  say('时间前进 2 小时后清理过期项（sess Max-Age=3600 将过期）');
  const later = t + 2 * 3600 * 1000;
  console.log(fmt(svc.purge(later)));
  console.log('剩余:', fmt(svc.listCookies(shop.id).map((c) => ({ name: c.name, expires_at: c.expires_at }))));

  say('blog jar 为空，证明 jar 间隔离');
  console.log(fmt(svc.listCookies(2)));

  store.close();
  console.log(`\n演示数据库位于：${path}`);
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const now = () => (process.env.COOKIEJAR_NOW ? Number(process.env.COOKIEJAR_NOW) : Date.now());
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return help();
      case 'serve': {
        const i = rest.indexOf('--port');
        const port = i !== -1 ? Number(rest[i + 1]) : 0;
        void startServer({ port: Number.isFinite(port) ? port : 0, dbPath: dbPath() });
        return;
      }
      case 'demo':
        return demo();
      case 'jar': {
        if (rest[0] === 'create') {
          const name = rest[1];
          if (!name) throw new Error('用法：jar create <名称>');
          return console.log(fmt(withSvc((s) => s.createJar(name, now()))));
        }
        if (rest[0] === 'list') {
          return console.log(fmt(withSvc((s) => s.listJars())));
        }
        throw new Error('未知 jar 子命令');
      }
      case 'cookies': {
        const jarId = Number(rest[0]);
        if (!Number.isInteger(jarId)) throw new Error('用法：cookies <jarId>');
        return console.log(fmt(withSvc((s) => s.listCookies(jarId))));
      }
      case 'import': {
        const [jarIdStr, sourceUrl, ...cookies] = rest;
        const jarId = Number(jarIdStr);
        if (!Number.isInteger(jarId) || !sourceUrl || cookies.length === 0) {
          throw new Error('用法：import <jarId> <来源URL> <Set-Cookie>...');
        }
        return console.log(fmt(withSvc((s) => s.importSetCookies(jarId, sourceUrl, cookies, now()))));
      }
      case 'preview': {
        const [jarIdStr, url] = rest;
        const jarId = Number(jarIdStr);
        if (!Number.isInteger(jarId) || !url) throw new Error('用法：preview <jarId> <请求URL> [--now <毫秒>]');
        const ni = rest.indexOf('--now');
        const t = ni !== -1 ? Number(rest[ni + 1]) : now();
        return console.log(fmt(withSvc((s) => s.previewRequest(jarId, url, t))));
      }
      case 'purge': {
        const ni = rest.indexOf('--now');
        const t = ni !== -1 ? Number(rest[ni + 1]) : now();
        return console.log(fmt(withSvc((s) => s.purge(t))));
      }
      case 'session-end': {
        const jarId = Number(rest[0]);
        if (!Number.isInteger(jarId)) throw new Error('用法：session-end <jarId>');
        return console.log(fmt(withSvc((s) => s.endSession(jarId, now()))));
      }
      case 'operations': {
        const jarId = Number(rest[0]);
        if (!Number.isInteger(jarId)) throw new Error('用法：operations <jarId>');
        return console.log(fmt(withSvc((s) => s.listOperations(jarId))));
      }
      default:
        help();
        throw new Error(`未知命令：${cmd}`);
    }
  } catch (e) {
    const code = (e as Error & { code?: string }).code;
    console.error(`错误${code ? ` [${code}]` : ''}：${(e as Error).message}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
