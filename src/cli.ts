/** CLI：创建 jar、导入、列表、预览、清理、演示。 */
import path from "node:path";
import { Store } from "./store.ts";
import { CookieService } from "./service.ts";
import { parseNow } from "./server.ts";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function nowFrom(args: string[]): number {
  const v = argValue(args, "--now");
  return v !== undefined ? (parseNow(v) as number) : Date.now();
}

function openService(): { service: CookieService; store: Store } {
  const dbPath = argValue(process.argv.slice(2), "--data") ?? path.join("data", "cookies.db");
  const store = new Store(dbPath);
  return { service: new CookieService(store), store };
}

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

const USAGE = `用法: node dist/cli.js <命令> [参数]
  create-jar --name NAME
  list-jars
  import --jar JAR --url URL --set-cookie "a=1; Path=/" [--set-cookie ...] [--now T]
  list --jar JAR
  preview --jar JAR --url URL [--now T]
  purge --jar JAR [--now T]
  delete-jar --jar JAR
  demo
通用: --data PATH 指定数据库文件（默认 data/cookies.db）；--now 支持 ISO 时间或毫秒。`;

export function runCli(argv: string[]): void {
  const [cmd, ...args] = argv;
  const { service, store } = openService();
  try {
    switch (cmd) {
      case "create-jar":
        print(service.createJar(String(argValue(args, "--name") ?? ""), nowFrom(args)));
        break;
      case "list-jars":
        print(service.listJars());
        break;
      case "import": {
        const setCookies: string[] = [];
        args.forEach((a, i) => {
          if (a === "--set-cookie" && args[i + 1]) setCookies.push(args[i + 1]);
        });
        print(service.importCookies(String(argValue(args, "--jar")), String(argValue(args, "--url")), setCookies, nowFrom(args)));
        break;
      }
      case "list":
        print(service.listCookies(String(argValue(args, "--jar"))));
        break;
      case "preview":
        print(service.preview(String(argValue(args, "--jar")), String(argValue(args, "--url")), nowFrom(args)));
        break;
      case "purge":
        print({ removed: service.purgeExpired(String(argValue(args, "--jar")), nowFrom(args)) });
        break;
      case "delete-jar":
        service.deleteJar(String(argValue(args, "--jar")), nowFrom(args));
        print({ deleted: argValue(args, "--jar") });
        break;
      case "demo":
        runDemo(service);
        break;
      default:
        console.log(USAGE);
        if (cmd && cmd !== "help") process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

/** 使用 example.test 虚构子域的演示场景（固定时间，全部本地）。 */
function runDemo(service: CookieService): void {
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const jar = service.createJar(`demo-${T0}`, T0);
  const J = jar.name;
  const say = (title: string, x: unknown) => {
    console.log(`\n=== ${title} ===`);
    print(x);
  };

  say("1. host-only（无 Domain）与 Domain 导入", service.importCookies(J, "https://app.example.test/login", [
    "sid=abc; Path=/; Secure",
    "pref=dark; Domain=example.test; Path=/",
    "deep=x; Domain=api.example.test; Path=/v1; Max-Age=3600",
    "wide=y; Domain=example.test; Path=/; Max-Age=10",
    "sess=tmp",
  ], T0));

  say("2. host-only 不发给子域（app.example.test 的 sid 不发给 other.example.test）",
    service.preview(J, "https://other.example.test/", T0));

  say("3. Domain=example.test 发给子域；Secure 只在 HTTPS 出现（对比 http）",
    service.preview(J, "http://app.example.test/", T0));

  say("4. 路径边界：/v1 匹配 /v1/x，但不匹配 /v10",
    service.preview(J, "https://api.example.test/v10", T0));

  say("5. 过期后不再发送（wide 的 Max-Age=10，11 秒后失效）",
    service.preview(J, "https://app.example.test/", T0 + 11_000));

  say("6. 清理过期项", { removed: service.purgeExpired(J, T0 + 11_000) });
  console.log("\n演示完成。会话 Cookie 'sess' 未设期限，服务重启后将被清除。");
}

runCli(process.argv.slice(2));
