import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// draw.ioの図を描くページとscriptに付けるヘッダーを静的に確かめる。
// 図を描くページのCSPは外への取得を止める要で、ビューアのscriptはConsole本体から読めてはいけない。
// Caddyfileの編集で崩れたらここで落とす。
const CADDYFILE = readFileSync(
  join(import.meta.dir, "../../infra/Caddyfile"),
  "utf8",
);

/** `(name) {`から対応する`}`までを返す。 */
function snippet(name: string): string {
  return braceBlock(`(${name}) {`);
}

/** `header`で始まる行(`handle ... {`など)から、対応する`}`までのブロックを返す。 */
function braceBlock(opening: string): string {
  const start = CADDYFILE.indexOf(opening);
  if (start < 0) return "";
  let depth = 0;
  for (let index = CADDYFILE.indexOf("{", start); index < CADDYFILE.length; ) {
    const char = CADDYFILE[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return CADDYFILE.slice(start, index + 1);
    }
    index += 1;
  }
  return "";
}

function contentSecurityPolicy(block: string): string {
  return /Content-Security-Policy "([^"]*)"/.exec(block)?.[1] ?? "";
}

/** CSPのディレクティブの値をソースの配列にして返す。無ければ空。 */
function sources(csp: string, directive: string): string[] {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));
  return found === undefined ? [] : found.split(/\s+/).slice(1);
}

const ORIGIN = "{http.request.scheme}://{http.request.hostport}";

/**
 * このCSPのscript-srcが、同じオリジンのパスのscriptを許すかを返す。
 * 末尾が`/`のパス付きのソースは、そのパスの下を許す。パスの無い`'self'`などは、オリジン全体を許す。
 */
function allowsScript(csp: string, pathname: string): boolean {
  const list = sources(csp, "script-src").length
    ? sources(csp, "script-src")
    : sources(csp, "default-src");
  return list.some((source) => {
    if (source === "*" || source === "'self'") return true;
    if (!source.startsWith(ORIGIN)) return false;
    const path = source.slice(ORIGIN.length);
    return path === "" || pathname.startsWith(path);
  });
}

const drawioHeaders = snippet("drawio_headers");
const drawioCsp = contentSecurityPolicy(drawioHeaders);
const consoleCsp = contentSecurityPolicy(snippet("console_headers"));
const pageBlock = braceBlock("handle /console/drawio.html {");
const scriptsBlock = braceBlock("handle_path /console/drawio/* {");

describe("drawio_headers", () => {
  test("makes the page an opaque origin even when opened directly", () => {
    expect(drawioCsp).toContain("sandbox allow-scripts");
  });

  test("does not allow eval", () => {
    expect(drawioCsp).not.toContain("unsafe-eval");
  });

  test("does not allow inline scripts", () => {
    expect(sources(drawioCsp, "script-src")).not.toContain("'unsafe-inline'");
  });

  test("does not allow every origin to serve scripts", () => {
    expect(sources(drawioCsp, "script-src")).not.toContain("*");
  });

  test("limits scripts to the draw.io path of the same origin", () => {
    expect(sources(drawioCsp, "script-src")).toEqual([
      `${ORIGIN}/console/drawio/`,
    ]);
  });

  test("blocks every outgoing connection", () => {
    expect(drawioCsp).toContain("connect-src 'none'");
  });

  test("starts from default-src none", () => {
    expect(drawioCsp).toContain("default-src 'none';");
  });

  test("allows embedding only from the same origin", () => {
    expect(drawioCsp).toContain("frame-ancestors 'self'");
  });

  test("sends X-Frame-Options SAMEORIGIN for browsers that ignore frame-ancestors", () => {
    expect(drawioHeaders).toContain('X-Frame-Options "SAMEORIGIN"');
  });
});

describe("script permissions of the two CSPs", () => {
  test("the draw.io page may load the viewer", () => {
    expect(allowsScript(drawioCsp, "/console/drawio/drawio-viewer-x.js")).toBe(
      true,
    );
  });

  test("the draw.io page may not load the console bundle", () => {
    expect(allowsScript(drawioCsp, "/console/assets/index-x.js")).toBe(false);
  });

  test("the console may load its own bundle", () => {
    expect(allowsScript(consoleCsp, "/console/assets/index-x.js")).toBe(true);
  });

  test("the console may not load the draw.io viewer", () => {
    expect(allowsScript(consoleCsp, "/console/drawio/drawio-viewer-x.js")).toBe(
      false,
    );
  });

  test("the console may not load the draw.io frame script", () => {
    expect(allowsScript(consoleCsp, "/console/drawio/drawio-frame-x.js")).toBe(
      false,
    );
  });
});

describe("draw.io routes", () => {
  test("the page block exists", () => {
    expect(pageBlock).not.toBe("");
  });

  test("the page block imports drawio_headers", () => {
    expect(pageBlock).toContain("import drawio_headers");
  });

  test("the page block does not import console_headers", () => {
    expect(pageBlock).not.toContain("import console_headers");
  });

  test("the page block rewrites the request to drawio.html", () => {
    expect(pageBlock).toContain("rewrite * /drawio.html");
  });

  test("the page block serves the current release", () => {
    expect(pageBlock).toContain("root * /srv/console/current");
  });

  test("the scripts block exists", () => {
    expect(scriptsBlock).not.toBe("");
  });

  test("the scripts block imports drawio_headers", () => {
    expect(scriptsBlock).toContain("import drawio_headers");
  });

  test("the scripts block does not import console_headers", () => {
    expect(scriptsBlock).not.toContain("import console_headers");
  });

  test("the scripts block rejects encoded separators", () => {
    expect(scriptsBlock).toContain("import console_reject_encoded_separator");
  });

  test("the scripts block serves the current release's draw.io directory", () => {
    expect(scriptsBlock).toContain("root * /srv/console/current/drawio");
  });

  test("the scripts block caches hashed files for a long time", () => {
    expect(scriptsBlock).toContain("immutable");
  });

  test("the page route comes before the general console route", () => {
    expect(CADDYFILE.indexOf("handle /console/drawio.html")).toBeLessThan(
      CADDYFILE.indexOf("handle_path /console/*"),
    );
  });

  test("the scripts route comes before the general console route", () => {
    expect(CADDYFILE.indexOf("handle_path /console/drawio/*")).toBeLessThan(
      CADDYFILE.indexOf("handle_path /console/*"),
    );
  });

  test("the page route comes before the catch-all for raw console paths", () => {
    expect(CADDYFILE.indexOf("handle /console/drawio.html")).toBeLessThan(
      CADDYFILE.indexOf("handle @console_raw"),
    );
  });

  test("the scripts route comes before the catch-all for raw console paths", () => {
    expect(CADDYFILE.indexOf("handle_path /console/drawio/*")).toBeLessThan(
      CADDYFILE.indexOf("handle @console_raw"),
    );
  });
});
