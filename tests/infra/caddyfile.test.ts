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
const redirectBlock = braceBlock("handle /console {");
const fallbackBlock = braceBlock("handle_path /console/* {");

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
    expect(sources(drawioCsp, "frame-ancestors")).toEqual([ORIGIN]);
  });

  test("does not rely on 'self', which an opaque origin never matches", () => {
    expect(drawioCsp).not.toContain("'self'");
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

describe("redirect from /console", () => {
  test("keeps the query string, such as ?approval=<id>", () => {
    expect(redirectBlock).toContain("redir * /console/{?query} 308");
  });

  test("redirects permanently", () => {
    expect(redirectBlock).toContain("308");
  });
});

describe("the console fallback", () => {
  test("refuses the draw.io page and scripts, which only drawio_headers may serve", () => {
    expect(fallbackBlock).toContain("error @drawio 404");
  });

  test("matches drawio.html and the drawio directory", () => {
    expect(fallbackBlock).toMatch(
      /@drawio path [^\n]*\/drawio\.html[^\n]*\/drawio\/\*/,
    );
  });

  test("refuses them before serving any file", () => {
    expect(fallbackBlock.indexOf("error @drawio 404")).toBeLessThan(
      fallbackBlock.indexOf("file_server"),
    );
  });

  test("does not import drawio_headers", () => {
    expect(fallbackBlock).not.toContain("import drawio_headers");
  });

  test("still serves with console_headers", () => {
    expect(fallbackBlock).toContain("import console_headers");
  });
});

// /api/*で、他のサイトからの要求を止める規則を静的に確かめる。
// Sec-Fetch-Siteを送らない古いブラウザでも、Originの不一致で止める。
const crossSiteMatcher = braceBlock("@cross_site_api {");
const crossSiteHandler = braceBlock("handle @cross_site_api {");
const crossOriginMatcher = braceBlock("@cross_origin_api {");
const crossOriginHandler = braceBlock("handle @cross_origin_api {");

describe("the Sec-Fetch-Site rule on /api/*", () => {
  test("matches cross-site requests", () => {
    expect(crossSiteMatcher).toContain("header Sec-Fetch-Site cross-site");
  });

  test("matches same-site requests", () => {
    expect(crossSiteMatcher).toContain("header Sec-Fetch-Site same-site");
  });

  test("responds 403", () => {
    expect(crossSiteHandler).toContain("respond 403");
  });
});

describe("the Origin rule on /api/*", () => {
  test("the matcher exists", () => {
    expect(crossOriginMatcher).not.toBe("");
  });

  test("the matcher is limited to /api/*", () => {
    expect(crossOriginMatcher).toContain("path /api/*");
  });

  test("the matcher ignores requests without an Origin header", () => {
    expect(crossOriginMatcher).toContain('{http.request.header.Origin} != ""');
  });

  test("the matcher allows the http origin of the host the browser used", () => {
    expect(crossOriginMatcher).toContain(
      '{http.request.header.Origin} != "http://" + {http.request.hostport}',
    );
  });

  test("the matcher allows the https origin of the host the browser used", () => {
    expect(crossOriginMatcher).toContain(
      '{http.request.header.Origin} != "https://" + {http.request.hostport}',
    );
  });

  test("the handler responds 403", () => {
    expect(crossOriginHandler).toContain("respond 403");
  });

  test("the handler comes before the default reverse proxy", () => {
    expect(CADDYFILE.indexOf("handle @cross_origin_api")).toBeLessThan(
      CADDYFILE.indexOf("reverse_proxy http://windmill_server:8000"),
    );
  });

  test("the handler comes after the console routes", () => {
    expect(CADDYFILE.indexOf("handle @cross_origin_api")).toBeGreaterThan(
      CADDYFILE.indexOf("handle @console_raw"),
    );
  });
});

// GETなのに副作用を起こすAPIを、fetch以外の読み込み(img、document、iframeなど)から呼ばせない規則を静的に確かめる。
// 同じオリジンの<img>はSec-Fetch-Site: same-originでOriginも付かないので、上の2規則では止まらない。
const sideEffectMatcher = braceBlock("@side_effect_get_api {");
const sideEffectHandler = braceBlock("handle @side_effect_get_api {");

describe("the rule for GET requests with side effects", () => {
  test("the matcher exists", () => {
    expect(sideEffectMatcher).not.toBe("");
  });

  test("the matcher is limited to GET and HEAD", () => {
    expect(sideEffectMatcher).toContain("method GET HEAD");
  });

  test.each([
    "run_wait_result",
    "run_and_stream",
    "slack_approval",
    "teams_approval",
  ])("the matcher covers jobs/%s", (name) => {
    expect(sideEffectMatcher).toMatch(
      new RegExp(`path_regexp [^\\n]*jobs/\\+\\([^)]*\\b${name}\\b`),
    );
  });

  test("the matcher covers job_helpers/move_s3_file with its end anchored like the others", () => {
    expect(sideEffectMatcher).toContain("move_s3_file)(/|$)");
  });

  test("the matcher lets the workspace part cross a slash", () => {
    expect(sideEffectMatcher).toContain("^/+api/+w/.+/");
  });

  test("the matcher ignores case", () => {
    expect(sideEffectMatcher).toContain("(?i)");
  });

  test("the matcher lets fetch through", () => {
    expect(sideEffectMatcher).toContain(
      '{http.request.header.Sec-Fetch-Dest} != "empty"',
    );
  });

  test("the matcher also stops a cookie request without Sec-Fetch-Dest", () => {
    expect(sideEffectMatcher).toContain(
      '{http.request.header.Sec-Fetch-Dest} != "" || {http.request.header.Cookie} != ""',
    );
  });

  test("the handler responds 403", () => {
    expect(sideEffectHandler).toContain("respond 403");
  });

  test("the handler comes before the default reverse proxy", () => {
    expect(CADDYFILE.indexOf("handle @side_effect_get_api")).toBeLessThan(
      CADDYFILE.indexOf("reverse_proxy http://windmill_server:8000"),
    );
  });

  test("the handler comes after the console routes", () => {
    expect(CADDYFILE.indexOf("handle @side_effect_get_api")).toBeGreaterThan(
      CADDYFILE.indexOf("handle @console_raw"),
    );
  });
});

// フォームのPOSTのように、ページの移動(navigate)で送られる書き込みを止める規則を静的に確かめる。
// ConsoleとWindmillのUIのAPI呼び出しはfetchなので、Sec-Fetch-Modeはcorsかsame-originになる。
const navigateMatcher = braceBlock("@navigate_write_api {");
const navigateHandler = braceBlock("handle @navigate_write_api {");

describe("the rule for writes sent by navigation", () => {
  test("the matcher exists", () => {
    expect(navigateMatcher).not.toBe("");
  });

  test("the matcher is limited to /api/*", () => {
    expect(navigateMatcher).toContain("path /api/*");
  });

  test("the matcher leaves GET and HEAD to the other rules", () => {
    expect(navigateMatcher).toMatch(/not \{[^}]*method GET HEAD/);
  });

  test("the matcher matches Sec-Fetch-Mode navigate", () => {
    expect(navigateMatcher).toContain("header Sec-Fetch-Mode navigate\n");
  });

  test("the matcher matches Sec-Fetch-Mode nested-navigate", () => {
    expect(navigateMatcher).toContain("header Sec-Fetch-Mode nested-navigate");
  });

  test("the handler responds 403", () => {
    expect(navigateHandler).toContain("respond 403");
  });

  test("the handler comes before the default reverse proxy", () => {
    expect(CADDYFILE.indexOf("handle @navigate_write_api")).toBeLessThan(
      CADDYFILE.indexOf("reverse_proxy http://windmill_server:8000"),
    );
  });

  test("the handler comes after the console routes", () => {
    expect(CADDYFILE.indexOf("handle @navigate_write_api")).toBeGreaterThan(
      CADDYFILE.indexOf("handle @console_raw"),
    );
  });
});
