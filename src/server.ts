/** HTTP API 服务（node:http，无外部依赖）。 */
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "./store.ts";
import { CookieService } from "./service.ts";
import { CookieError } from "./cookie.ts";

export function parseNow(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    const t = Date.parse(input);
    if (!Number.isNaN(t)) return t;
    const n = Number(input);
    if (Number.isFinite(n)) return n;
  }
  throw new CookieError("BAD_REQUEST", `now 参数无法解析为时间: ${String(input)}`);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof CookieError) {
    send(res, 400, { error: { code: err.code, message: err.message } });
  } else if (err && typeof err === "object" && "code" in err) {
    const e = err as { code: string; message: string };
    send(res, 400, { error: { code: e.code, message: e.message } });
  } else {
    send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CookieError("BAD_JSON", "请求体不是合法 JSON");
  }
}

export function createServer(service: CookieService): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const now = parseNow(url.searchParams.get("now")) ?? Date.now();

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/jars") {
        const body = await readBody(req);
        return send(res, 201, service.createJar(String(body.name ?? ""), parseNow(body.now) ?? now));
      }
      if (req.method === "GET" && url.pathname === "/jars") {
        return send(res, 200, { jars: service.listJars() });
      }
      if (parts[0] === "jars" && parts.length >= 2) {
        const jarId = decodeURIComponent(parts[1]);
        if (req.method === "DELETE" && parts.length === 2) {
          service.deleteJar(jarId, now);
          return send(res, 200, { deleted: jarId });
        }
        if (req.method === "POST" && parts[2] === "cookies" && parts.length === 3) {
          const body = await readBody(req);
          const results = service.importCookies(
            jarId,
            String(body.url ?? ""),
            body.setCookies as string[],
            parseNow(body.now) ?? now
          );
          return send(res, 200, { results });
        }
        if (req.method === "GET" && parts[2] === "cookies" && parts.length === 3) {
          return send(res, 200, { cookies: service.listCookies(jarId) });
        }
        if (req.method === "POST" && parts[2] === "match" && parts.length === 3) {
          const body = await readBody(req);
          return send(res, 200, service.preview(jarId, String(body.url ?? ""), parseNow(body.now) ?? now));
        }
        if (req.method === "POST" && parts[2] === "purge" && parts.length === 3) {
          const removed = service.purgeExpired(jarId, parseNow((await readBody(req)).now) ?? now);
          return send(res, 200, { removed });
        }
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname} 不存在` } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export async function startServer(dbPath: string, port: number): Promise<{ port: number; close: () => void }> {
  const store = new Store(dbPath);
  const service = new CookieService(store);
  const server = createServer(service);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: actualPort,
    close: () => {
      server.close();
      store.close();
    },
  };
}

// 直接运行：node dist/server.js [--port N] [--data PATH]
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const getArg = (name: string, def: string): string => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
  };
  const port = Number(process.env.PORT ?? getArg("--port", "0")); // 0 = 自动选择空闲端口
  const dbPath = getArg("--data", path.join("data", "cookies.db"));
  const { port: actual } = await startServer(dbPath, port);
  console.log(`Cookie jar 实验服务已启动: http://127.0.0.1:${actual}  (数据: ${dbPath})`);
}
