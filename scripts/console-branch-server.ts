#!/usr/bin/env bun
// ブランチ版のConsoleを、ローカルのWindmillに繋いで確かめるための検証用サーバー。
// ビルドしたConsole(`--dist`)を`/console/`で配信し、それ以外のパスは`--upstream`(既定は
// ローカルのCaddy、`http://127.0.0.1:8080`)へそのまま中継する。
// ブラウザから見るとConsoleとWindmillが同じオリジンなので、`/console/`のページは、
// `--upstream`で入った運用者のCookieのまま、本物のWindmillのAPIを呼べる。
//
// 注意: POSTを含む書き込みも中継する。マージ前の変更が、本物のWindmillに書き込める。
// 承認、却下、再実行、通知の解決、保留と凍結の解除、監査の起動、手動投入のボタンを押すと、
// 実際に実行される。確認では、読むだけにするか、書き込みを試す前に対象を確かめる。
// 待ち受けは127.0.0.1だけで、中継先もこのマシンのアドレスに限る。
//
// 配信は、Caddyの`/console/*`のうち動作に必要な部分だけを写す。
// - 無いパスはSPAのindex.htmlに落とす。assets、draw.ioのファイル、status.jsonは落とさず404にする。
// - 符号化した区切り(`%2f`、`%5c`)と`..`を含むパスは400にする。
// CSPなどの安全のためのヘッダーは付けない。CSPの確認は、反映した後の実機で行う。
//
// 使い方: bun run scripts/console-branch-server.ts --dist console/dist [--port 5174] [--upstream http://127.0.0.1:8080]

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
};

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
  let index = 0;
  while (index < argv.length) {
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
  return { ok: true, config: { dist, port, upstream } };
}

/** 中継先へ送るヘッダー。Originを外し、Hostを中継先にして、同一オリジンの検査を通す。 */
export function toUpstreamRequestHeaders(
  headers: Headers,
  upstream: string,
): Headers {
  const result = new Headers(headers);
  result.delete("origin");
  result.set("host", new URL(upstream).host);
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
        result.set(
          "location",
          `${target.pathname}${target.search}${target.hash}`,
        );
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
    headers: {
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
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

/** サーバーを起動する。待ち受けは127.0.0.1だけにする。 */
export function startServer(config: Config): { port: number; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    async fetch(req) {
      const route = routeFor(new URL(req.url).pathname);
      if (route.kind === "reject") {
        return new Response("Bad Request", { status: 400 });
      }
      if (route.kind === "redirect") {
        return Response.redirect(
          new URL(route.location + new URL(req.url).search, req.url).toString(),
          308,
        );
      }
      if (route.kind === "file") {
        const direct = serveFile(config.dist, route.path);
        if (direct.status !== 404 || route.fallback === "not-found") {
          return direct;
        }
        return serveFile(config.dist, "index.html");
      }
      return proxy(req, config.upstream);
    },
  });
  return { port: server.port ?? config.port, stop: () => server.stop(true) };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error(
      "usage: bun run scripts/console-branch-server.ts --dist <dir> [--port <n>] [--upstream <url>]",
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
  const server = startServer(config);
  console.log(
    `Serving ${config.dist} at http://127.0.0.1:${server.port}/console/ and proxying other paths to ${config.upstream}`,
  );
  console.warn(
    "Warning: writes (POST) reach the real Windmill. Do not press the action buttons unless you mean it.",
  );
}

if (import.meta.main) {
  main();
}
