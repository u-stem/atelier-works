#!/usr/bin/env bun
// ブランチ版のConsoleを、ローカルのWindmillに繋いで確かめるための検証用サーバー。
// ビルドしたConsole(`--dist`)を`/console/`で配信し、それ以外のパスは`--upstream`(既定は
// ローカルのCaddy、`http://127.0.0.1:8080`)へ中継する。
// ブラウザから見るとConsoleとWindmillが同じオリジンなので、`/console/`のページは、
// `--upstream`で入った運用者のCookieのまま、本物のWindmillのAPIを呼べる。
//
// 既定は読み取りだけである。中継するのは、GET、HEAD、OPTIONSと、読み取り専用の5つのscript
// (`READ_ONLY_SCRIPT_PATHS`)を同期で実行するPOSTだけで、ほかは403にする。
// 5つが読み取り専用であることは、各scriptのソースにINSERT、UPDATE、DELETEと書き込みのAPIが
// 無いことで確かめた。承認、却下、再実行、通知の解決、保留と凍結の解除、監査の起動、
// 手動投入のscriptは、既定では届かない。
// 人が`--allow-writes`を付けたときだけ、POSTを含む書き込みも中継する。
// そのとき、マージ前の変更が、本物のWindmillに書き込める。
//
// ブラウザが送る要求を、次のように絞る。
// - Hostは`127.0.0.1:<port>`か`localhost:<port>`だけを通す。DNSリバインディングで別の名前から
//   届いた要求を断るためである。
// - Originは、このサーバー自身のオリジンのときだけ中継先のオリジンに置き換える。ほかは403にする。
// - 中継の要求のSec-Fetch-Siteがcross-siteかsame-siteなら403にする。
// 待ち受けは127.0.0.1だけで、中継先もこのマシンのアドレスに限る。
//
// 配信は、Caddyの`/console/*`を写す。
// - 無いパスはSPAのindex.htmlに落とす。assets、draw.ioのファイル、status.jsonは落とさず404にする。
// - 符号化した区切り(`%2f`、`%5c`)と`..`を含むパスは400にする。
// - Consoleと同じCSPなどのヘッダーを付ける。値は`infra/Caddyfile`と同じで、テストが一致を確かめる。
//
// 使い方: bun run scripts/console-branch-server.ts --dist console/dist [--port 5174]
//   [--upstream http://127.0.0.1:8080] [--allow-writes]

import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type Route =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "reject" }
  | {
      readonly kind: "file";
      /** dist内の相対パス。 */
      readonly path: string;
      /** ファイルが無いときの扱い。`index`はSPAのindex.html、`not-found`は404。 */
      readonly fallback: "index" | "not-found";
    }
  | { readonly kind: "proxy" };

export type Config = {
  readonly dist: string;
  readonly port: number;
  readonly upstream: string;
  /** 書き込みを中継するか。人が`--allow-writes`を付けたときだけ真にする。 */
  readonly allowWrites: boolean;
};

/**
 * 既定で中継してよい、読み取り専用のscript。Consoleの読み取りの5つと一致する。
 * どれもSELECTと、読み取りのAPI(ジョブ、schedule、変数、リソースの取得)だけを呼ぶ。
 */
export const READ_ONLY_SCRIPT_PATHS: readonly string[] = [
  "f/factory/steps/console_query",
  "f/factory/console_holds",
  "f/factory/console_jobs",
  "f/factory/console_schedules",
  "f/factory/console_config",
];

const RUN_PREFIX = "/api/w/factory/jobs/run_wait_result/p/";
const SAFE_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];

// メソッドを問わず、書き込みを許さないときに断る経路。
// WindmillはGETでもscriptを同期で実行できる(`GET /api/w/{ws}/jobs/run_wait_result/p/{path}`)。
// そのため、実行、再開、取り消し、再実行、ストリーム、エンドポイントの経路とwebhookは、
// GETとHEADでも断る。
const EXECUTING_PATHS: readonly RegExp[] = [
  /\/jobs(?:_u)?\/(?:run|run_wait_result|run_and_stream|run_inline|resume|cancel|restart|openai_sync|flow\/resume|flow\/resume_suspended|queue\/cancel|queue\/cancel_persistent|queue\/force_cancel)(?:\/|$)/i,
  /^\/api\/r\//i,
  /webhook/i,
];

// `/api/`の下で、GETとHEADとOPTIONSを通す読み取りの経路。
// Consoleの画面が使うのは、読み取りのscriptを実行するPOSTと`/console/status.json`だけで、
// `/api/`のGETは使わない。ここに挙げるのは、ログイン後の画面の確認と、ジョブの画面が読む経路である。
const READABLE_API_PATHS: readonly RegExp[] = [
  /^\/api\/version$/,
  /^\/api\/users\/whoami$/,
  /^\/api\/w\/[^/]+\/jobs_u\/(?:get|get_logs|get_args|getupdate|getupdate_sse|get_root_job_id|get_completed_logs_tail)\/[^/]+$/,
  /^\/api\/w\/[^/]+\/jobs_u\/completed\/(?:get|get_result|get_result_maybe|get_timing)\/[^/]+$/,
];

/**
 * 中継してよい要求か。書き込みは、`allowWrites`のときだけ通す。
 * 書き込みを許さないときは、次の順で決める。
 * 1. 読み取りの5つのscriptを実行するPOSTは通す。
 * 2. 実行などの経路は、メソッドを問わず断る。
 * 3. GET、HEAD、OPTIONSは、`/api/`の外か、読み取りの経路だけを通す。
 */
export function isAllowedProxyRequest(
  method: string,
  pathname: string,
  allowWrites: boolean,
): boolean {
  if (allowWrites) return true;
  if (method === "POST" && pathname.startsWith(RUN_PREFIX)) {
    return READ_ONLY_SCRIPT_PATHS.includes(pathname.slice(RUN_PREFIX.length));
  }
  if (EXECUTING_PATHS.some((pattern) => pattern.test(pathname))) return false;
  if (!SAFE_METHODS.includes(method)) return false;
  if (!pathname.startsWith("/api/")) return true;
  return READABLE_API_PATHS.some((pattern) => pattern.test(pathname));
}

/**
 * `--allow-writes`を有効にしてよいか。
 * 人が端末で「yes」と入力したときだけ有効にする。
 * 端末でない入力(agentの起動やパイプ)では、確認できないので有効にしない。
 */
export function decideWriteConfirmation(
  isTty: boolean,
  answer: string | null,
): "confirmed" | "not-interactive" | "declined" {
  if (!isTty) return "not-interactive";
  return answer !== null && answer.trim() === "yes" ? "confirmed" : "declined";
}

/** Hostが、このサーバーのループバックの名前とポートか。 */
/** Hostが、このサーバーのループバックの名前とポートか。 */
export function isTrustedHost(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Originが、このサーバー自身のオリジンか。 */
export function isOwnOrigin(origin: string, port: number): boolean {
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}

/**
 * `infra/Caddyfile`の`console_headers`と`drawio_headers`と同じヘッダー。
 * CSPのscript-srcなどは、ブラウザが使ったオリジンを入れる。
 */
export function consoleSecurityHeaders(
  origin: string,
  kind: "console" | "drawio",
): Headers {
  if (kind === "drawio") {
    return new Headers({
      "content-security-policy": `default-src 'none'; script-src ${origin}/console/drawio/; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}; sandbox allow-scripts`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "SAMEORIGIN",
    });
  }
  return new Headers({
    "content-security-policy": `default-src 'self'; script-src ${origin}/console/assets/; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'self'; frame-ancestors 'none'; worker-src 'none'`,
    "content-security-policy-report-only": "require-trusted-types-for 'script'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
  });
}

export type ParsedArgs =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly message: string };

const DEFAULT_PORT = 5174;
const DEFAULT_UPSTREAM = "http://127.0.0.1:8080";
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

// ファイルが無くてもindex.htmlに落とさないパス。Caddyが404を返すものと同じ扱いにする。
// status.jsonはConsoleの取り込みが書くファイルで、ビルドの成果物には無い。
function mustExist(path: string): boolean {
  return (
    path.startsWith("assets/") ||
    path.startsWith("drawio/") ||
    path === "drawio.html" ||
    path === "status.json"
  );
}

/** URLのパスから、配信するもの、転送するもの、断るものを決める。 */
export function routeFor(pathname: string): Route {
  if (pathname === "/console") {
    return { kind: "redirect", location: "/console/" };
  }
  if (!pathname.startsWith("/console/")) return { kind: "proxy" };
  if (/%2f|%5c/i.test(pathname) || pathname.includes("\\")) {
    return { kind: "reject" };
  }
  const rest = pathname.slice("/console/".length).replace(/\/$/, "");
  if (rest === "") {
    return { kind: "file", path: "index.html", fallback: "index" };
  }
  const segments = rest.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return { kind: "reject" };
  }
  return {
    kind: "file",
    path: rest,
    fallback: mustExist(rest) ? "not-found" : "index",
  };
}

function flagValue(
  argv: readonly string[],
  index: number,
): { name: string; value: string | null; consumed: number } {
  const token = argv[index] ?? "";
  const equals = token.indexOf("=");
  if (equals !== -1) {
    return {
      name: token.slice(0, equals),
      value: token.slice(equals + 1),
      consumed: 1,
    };
  }
  const next = argv[index + 1];
  return {
    name: token,
    value: next === undefined ? null : next,
    consumed: 2,
  };
}

function parseUpstream(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return null;
    if (!LOOPBACK_HOSTS.includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 引数を読む。中継先はこのマシンのアドレスに限る。 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let dist: string | null = null;
  let port = DEFAULT_PORT;
  let upstream = DEFAULT_UPSTREAM;
  let allowWrites = false;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--allow-writes") {
      allowWrites = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--allow-writes=")) {
      return { ok: false, message: "--allow-writes takes no value" };
    }
    const { name, value, consumed } = flagValue(argv, index);
    index += consumed;
    if (value === null || value === "") {
      return { ok: false, message: `${name} needs a value` };
    }
    if (name === "--dist") {
      dist = value;
    } else if (name === "--port") {
      const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return {
          ok: false,
          message: "--port must be an integer from 1 to 65535",
        };
      }
      port = parsed;
    } else if (name === "--upstream") {
      const origin = parseUpstream(value);
      if (origin === null) {
        return {
          ok: false,
          message:
            "--upstream must be an http URL on this machine (127.0.0.1, localhost, or [::1])",
        };
      }
      upstream = origin;
    } else {
      return { ok: false, message: `unknown option: ${name}` };
    }
  }
  if (dist === null) return { ok: false, message: "--dist is required" };
  return { ok: true, config: { dist, port, upstream, allowWrites } };
}

// 中継先に渡さないヘッダー。転送元の偽装に使われる名前と、hop-by-hopのヘッダーである。
const DROPPED_REQUEST_HEADERS: readonly string[] = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-real-ip",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * 中継先へ送るヘッダー。Hostを中継先にする。
 * Originは、呼び出し側が自身のオリジンだと確かめたものを、中継先のオリジンに置き換える。
 * 中継先のCaddyが、Originを開いたオリジンと比べて断らないようにするためである。
 * 転送元を名乗るヘッダーとhop-by-hopのヘッダーは外す。`Connection`が名指しするヘッダーも外す。
 */
export function toUpstreamRequestHeaders(
  headers: Headers,
  upstream: string,
): Headers {
  const result = new Headers(headers);
  const named = (headers.get("connection") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  for (const name of [...DROPPED_REQUEST_HEADERS, ...named]) {
    result.delete(name);
  }
  const target = new URL(upstream);
  if (result.has("origin")) result.set("origin", target.origin);
  result.set("host", target.host);
  return result;
}

/**
 * ブラウザへ返すヘッダー。
 * fetchが本文を展開済みなので、圧縮と長さの情報を外す。
 * 中継先の絶対URLへのリダイレクトは、このサーバーのパスに直す。
 */
export function toClientResponseHeaders(
  headers: Headers,
  upstream: string,
): Headers {
  const result = new Headers(headers);
  result.delete("content-encoding");
  result.delete("content-length");
  result.delete("transfer-encoding");
  const location = result.get("location");
  if (location !== null) {
    try {
      const target = new URL(location);
      if (target.origin === new URL(upstream).origin) {
        // 先頭の`/`を1つにそろえる。`//host`はプロトコル相対になり、別のサイトへ飛ぶため。
        const path = target.pathname.replace(/^[/\\]+/, "/");
        result.set("location", `${path}${target.search}${target.hash}`);
      }
    } catch {
      // 相対のLocationはそのまま返す。
    }
  }
  return result;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function serveFile(dist: string, path: string): Response {
  const root = resolve(dist);
  const target = resolve(join(root, path));
  if (!target.startsWith(root + sep) || !isFile(target)) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(Bun.file(target), {
    headers: { "cache-control": "no-cache" },
  });
}

/** Consoleの応答に、Caddyが付けるのと同じ安全のためのヘッダーを足す。 */
function withSecurityHeaders(
  response: Response,
  origin: string,
  path: string,
): Response {
  const kind =
    path === "drawio.html" || path.startsWith("drawio/") ? "drawio" : "console";
  const headers = new Headers(response.headers);
  for (const [name, value] of consoleSecurityHeaders(origin, kind)) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function refuse(status: number, reason: string): Response {
  return new Response(reason, { status });
}

async function proxy(req: Request, upstream: string): Promise<Response> {
  const source = new URL(req.url);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  try {
    const response = await fetch(
      `${upstream}${source.pathname}${source.search}`,
      {
        method: req.method,
        headers: toUpstreamRequestHeaders(req.headers, upstream),
        body: hasBody ? await req.arrayBuffer() : null,
        redirect: "manual",
      },
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: toClientResponseHeaders(response.headers, upstream),
    });
  } catch {
    return new Response(`Cannot reach the upstream ${upstream}`, {
      status: 502,
    });
  }
}

/** 書き込みを許しているサーバーの応答に、その印を付ける。 */
function markWrites(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-branch-server-writes", "on");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** サーバーを起動する。待ち受けは127.0.0.1だけにする。 */
export function startServer(config: Config): { port: number; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    async fetch(req) {
      const response = await handle(req);
      return config.allowWrites ? markWrites(response) : response;
    },
  });

  async function handle(req: Request): Promise<Response> {
    const port = server.port ?? config.port;
    const url = new URL(req.url);
    const host = req.headers.get("host");
    if (!isTrustedHost(host, port)) return refuse(403, "Forbidden host");
    const origin = req.headers.get("origin");
    if (origin !== null && !isOwnOrigin(origin, port)) {
      return refuse(403, "Forbidden origin");
    }
    const route = routeFor(url.pathname);
    if (route.kind === "reject") return refuse(400, "Bad Request");
    if (route.kind === "redirect") {
      return Response.redirect(
        new URL(route.location + url.search, req.url).toString(),
        308,
      );
    }
    if (route.kind === "file") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return refuse(405, "Method Not Allowed");
      }
      const direct = serveFile(config.dist, route.path);
      const found = direct.status !== 404 || route.fallback === "not-found";
      const served = found ? direct : serveFile(config.dist, "index.html");
      return withSecurityHeaders(
        served,
        `http://${host}`,
        found ? route.path : "index.html",
      );
    }
    const site = req.headers.get("sec-fetch-site");
    if (site === "cross-site" || site === "same-site") {
      return refuse(403, "Forbidden cross-site request");
    }
    if (!isAllowedProxyRequest(req.method, url.pathname, config.allowWrites)) {
      return refuse(
        403,
        "Forbidden: only reads are relayed (start with --allow-writes to relay writes)",
      );
    }
    return proxy(req, config.upstream);
  }

  return { port: server.port ?? config.port, stop: () => server.stop(true) };
}

const WRITES_BANNER = [
  "============================================================",
  "  --allow-writes: WRITES REACH THE REAL WINDMILL",
  "  Approve, reject, retry, resolve, release, kickoff, and intake",
  "  buttons in the branch build will run for real.",
  "============================================================",
].join("\n");

/** `--allow-writes`を、端末で人が確認したときだけ有効にする。確認できなければ終了する。 */
function confirmWrites(): void {
  const isTty = process.stdin.isTTY === true;
  let answer: string | null = null;
  if (isTty) {
    console.warn(WRITES_BANNER);
    answer = prompt('Type "yes" to relay writes to the real Windmill:');
  }
  const decision = decideWriteConfirmation(isTty, answer);
  if (decision === "not-interactive") {
    console.error(
      "--allow-writes needs an interactive terminal: stdin is not a terminal, so a person cannot confirm it.",
    );
    process.exit(2);
  }
  if (decision === "declined") {
    console.error(
      "Writes were not confirmed. Start again without --allow-writes, or answer yes.",
    );
    process.exit(2);
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error(
      "usage: bun run scripts/console-branch-server.ts --dist <dir> [--port <n>] [--upstream <url>] [--allow-writes]",
    );
    process.exit(2);
  }
  const { config } = parsed;
  if (!isFile(join(config.dist, "index.html"))) {
    console.error(
      `${config.dist}/index.html not found. Build the console first.`,
    );
    process.exit(1);
  }
  if (config.allowWrites) confirmWrites();
  const server = startServer(config);
  console.log(
    `Serving ${config.dist} at http://127.0.0.1:${server.port}/console/ and proxying other paths to ${config.upstream}`,
  );
  if (config.allowWrites) {
    console.warn(WRITES_BANNER);
    console.warn(
      "Every response carries the header x-branch-server-writes: on.",
    );
  } else {
    console.log(
      "Read-only: GET, HEAD, OPTIONS on listed read paths and the read scripts are relayed. Other requests get 403.",
    );
  }
}

if (import.meta.main) {
  main();
}
