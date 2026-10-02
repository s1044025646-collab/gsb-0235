import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Store } from './db.js';
import { CookieService } from './service.js';
import { ApiError } from './types.js';

interface StartOptions {
  port?: number; // 不传或 0 表示由系统选择空闲端口
  dbPath?: string;
  clockOffsetMs?: number; // 演示用时间偏移
}

function errCode(e: unknown): string {
  return (e as Error & { code?: string }).code ?? 'INTERNAL';
}

export function createApp(dbPath: string, clockOffsetMs = 0) {
  const store = new Store(dbPath);
  const service = new CookieService(store);
  const fixedNow = process.env.COOKIEJAR_NOW
    ? Number(process.env.COOKIEJAR_NOW)
    : null;
  const now = () => (fixedNow !== null && !Number.isNaN(fixedNow) ? fixedNow : Date.now() + clockOffsetMs);

  const readJson = (req: IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1_000_000) reject(new ApiError('BODY_TOO_LARGE', '请求体超过 1MB', 413));
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)); }
        catch { reject(new ApiError('JSON_INVALID', '请求体不是合法 JSON', 400)); }
      });
      req.on('error', reject);
    });

  const send = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload, null, 2));
  };

  const errorStatus = (code: string): number => {
    switch (code) {
      case 'JAR_NOT_FOUND': return 404;
      case 'JAR_EXISTS': return 409;
      case 'VALIDATION':
      case 'URL_EMPTY': case 'URL_INVALID': case 'URL_SCHEME_UNSUPPORTED':
      case 'URL_CREDENTIALS_UNSUPPORTED': case 'URL_IDN_UNSUPPORTED':
      case 'URL_IP_UNSUPPORTED': case 'URL_HOST_INVALID':
      case 'SETCOOKIE_EMPTY': case 'SETCOOKIE_NO_NAME_VALUE':
      case 'SETCOOKIE_NAME_EMPTY': case 'SETCOOKIE_NAME_INVALID':
        return 400;
      default: return 500;
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, now: now(), db: dbPath });
      }
      if (method === 'GET' && path === '/jars') {
        return send(res, 200, { jars: service.listJars() });
      }
      if (method === 'POST' && path === '/jars') {
        const body = await readJson(req);
        if (typeof body.name !== 'string') throw new ApiError('VALIDATION', '字段 name 必须是字符串', 400);
        return send(res, 201, { jar: service.createJar(body.name, now()) });
      }

      const mCookie = path.match(/^\/jars\/(\d+)\/cookies$/);
      const mImport = path.match(/^\/jars\/(\d+)\/import$/);
      const mPreview = path.match(/^\/jars\/(\d+)\/preview$/);
      const mPurge = path.match(/^\/jars\/(\d+)\/purge$/);
      const mSession = path.match(/^\/jars\/(\d+)\/session$/);
      const mOps = path.match(/^\/jars\/(\d+)\/operations$/);

      if (mCookie && method === 'GET') {
        return send(res, 200, { cookies: service.listCookies(Number(mCookie[1])) });
      }
      if (mOps && method === 'GET') {
        return send(res, 200, { operations: service.listOperations(Number(mOps[1])) });
      }
      if (mImport && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.sourceUrl !== 'string') throw new ApiError('VALIDATION', '字段 sourceUrl 必须是字符串', 400);
        if (!Array.isArray(body.setCookies)) throw new ApiError('VALIDATION', '字段 setCookies 必须是字符串数组', 400);
        const t = typeof body.now === 'number' ? body.now : now();
        return send(res, 200, { results: service.importSetCookies(Number(mImport[1]), body.sourceUrl, body.setCookies, t) });
      }
      if (mPreview && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.requestUrl !== 'string') throw new ApiError('VALIDATION', '字段 requestUrl 必须是字符串', 400);
        const t = typeof body.now === 'number' ? body.now : now();
        return send(res, 200, service.previewRequest(Number(mPreview[1]), body.requestUrl, t));
      }
      if (mPurge && method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const t = typeof body.now === 'number' ? body.now : now();
        return send(res, 200, service.purge(t));
      }
      if (mSession && method === 'DELETE') {
        const t = now();
        return send(res, 200, service.endSession(Number(mSession[1]), t));
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${method} ${path}` } });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : errCode(e);
      const status = e instanceof ApiError ? e.status : errorStatus(code);
      if (status >= 500) console.error(e);
      send(res, status, { error: { code, message: (e as Error).message } });
    }
  });

  return { server, store, service, now };
}

export function startServer(opts: StartOptions = {}): Promise<{ server: Server; port: number; close: () => void }> {
  const dbPath = opts.dbPath ?? join(process.cwd(), 'data', 'cookiejar.db');
  const app = createApp(dbPath);
  return new Promise((resolve) => {
    app.server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
      console.log(`[cookie-jar-lab] 监听 http://127.0.0.1:${port}`);
      console.log(`[cookie-jar-lab] 数据库：${dbPath}`);
      resolve({
        server: app.server,
        port,
        close: () => app.store.close(),
      });
    });
  });
}

// 直接运行时启动服务。
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0);
  startServer({ port: Number.isFinite(port) ? port : 0 }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
