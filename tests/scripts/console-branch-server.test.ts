import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consoleSecurityHeaders,
  decideWriteConfirmation,
  isAllowedProxyRequest,
  isOwnOrigin,
  isTrustedHost,
  parseArgs,
  READ_ONLY_SCRIPT_PATHS,
  routeFor,
  startServer,
  toClientResponseHeaders,
  toUpstreamRequestHeaders,
} from "../../scripts/console-branch-server.ts";

describe("routeFor", () => {
  test("serves the index for the console root", () => {
    expect(routeFor("/console/")).toEqual({
      kind: "file",
      path: "index.html",
      fallback: "index",
    });
  });

  test("falls back to the index for a client-side route", () => {
    expect(routeFor("/console/items/12")).toEqual({
      kind: "file",
      path: "items/12",
      fallback: "index",
    });
  });

  test("does not fall back for a missing asset", () => {
    expect(routeFor("/console/assets/app.js")).toEqual({
      kind: "file",
      path: "assets/app.js",
      fallback: "not-found",
    });
  });

  test("does not fall back for the draw.io page", () => {
    expect(routeFor("/console/drawio.html")).toEqual({
      kind: "file",
      path: "drawio.html",
      fallback: "not-found",
    });
  });

  test("does not fall back for the draw.io scripts", () => {
    expect(routeFor("/console/drawio/viewer.js")).toEqual({
      kind: "file",
      path: "drawio/viewer.js",
      fallback: "not-found",
    });
  });

  test("does not serve the release status file from the build", () => {
    expect(routeFor("/console/status.json")).toEqual({
      kind: "file",
      path: "status.json",
      fallback: "not-found",
    });
  });

  test("redirects the console path without a trailing slash", () => {
    expect(routeFor("/console")).toEqual({
      kind: "redirect",
      location: "/console/",
    });
  });

  test("rejects an encoded slash under the console", () => {
    expect(routeFor("/console/assets/..%2fsecret")).toEqual({ kind: "reject" });
  });

  test("rejects an encoded backslash under the console", () => {
    expect(routeFor("/console/assets/..%5Csecret")).toEqual({ kind: "reject" });
  });

  test("rejects a parent segment under the console", () => {
    expect(routeFor("/console/assets/../secret")).toEqual({ kind: "reject" });
  });

  test("proxies the Windmill API", () => {
    expect(
      routeFor("/api/w/factory/jobs/run_wait_result/p/f/factory/console_query"),
    ).toEqual({ kind: "proxy" });
  });

  test("proxies the Windmill login page", () => {
    expect(routeFor("/user/login")).toEqual({ kind: "proxy" });
  });

  test("proxies a path that only starts with the console name", () => {
    expect(routeFor("/consolefoo")).toEqual({ kind: "proxy" });
  });
});

describe("parseArgs", () => {
  test("uses the default port", () => {
    const parsed = parseArgs(["--dist", "console/dist"]);

    expect(parsed.ok && parsed.config.port).toBe(5174);
  });

  test("uses the default upstream", () => {
    const parsed = parseArgs(["--dist", "console/dist"]);

    expect(parsed.ok && parsed.config.upstream).toBe("http://127.0.0.1:8080");
  });

  test("reads a flag written with an equals sign", () => {
    const parsed = parseArgs(["--dist=console/dist", "--port=6000"]);

    expect(parsed.ok && parsed.config.port).toBe(6000);
  });

  test("requires the dist directory", () => {
    expect(parseArgs([]).ok).toBe(false);
  });

  test("rejects a port outside the valid range", () => {
    expect(parseArgs(["--dist", "d", "--port", "70000"]).ok).toBe(false);
  });

  test("rejects a port that is not a number", () => {
    expect(parseArgs(["--dist", "d", "--port", "abc"]).ok).toBe(false);
  });

  test("rejects an upstream that is not on this machine", () => {
    expect(
      parseArgs(["--dist", "d", "--upstream", "https://example.com"]).ok,
    ).toBe(false);
  });

  test("rejects an unknown flag", () => {
    expect(parseArgs(["--dist", "d", "--bogus", "1"]).ok).toBe(false);
  });

  test("does not allow writes by default", () => {
    const parsed = parseArgs(["--dist", "d"]);

    expect(parsed.ok && parsed.config.allowWrites).toBe(false);
  });

  test("allows writes only with the explicit flag", () => {
    const parsed = parseArgs(["--dist", "d", "--allow-writes"]);

    expect(parsed.ok && parsed.config.allowWrites).toBe(true);
  });

  test("does not take a value for the writes flag", () => {
    expect(parseArgs(["--dist", "d", "--allow-writes=false"]).ok).toBe(false);
  });
});

describe("READ_ONLY_SCRIPT_PATHS", () => {
  test("lists the five read scripts of the console", () => {
    expect([...READ_ONLY_SCRIPT_PATHS].sort()).toEqual([
      "f/factory/console_config",
      "f/factory/console_holds",
      "f/factory/console_jobs",
      "f/factory/console_schedules",
      "f/factory/steps/console_query",
    ]);
  });
});

describe("isAllowedProxyRequest", () => {
  const RUN = "/api/w/factory/jobs/run_wait_result/p";

  test("allows a GET", () => {
    expect(isAllowedProxyRequest("GET", "/api/version", false)).toBe(true);
  });

  test("allows a HEAD", () => {
    expect(isAllowedProxyRequest("HEAD", "/api/version", false)).toBe(true);
  });

  test("allows an OPTIONS", () => {
    expect(isAllowedProxyRequest("OPTIONS", "/api/version", false)).toBe(true);
  });

  test("allows a POST that runs a read script", () => {
    expect(
      isAllowedProxyRequest("POST", `${RUN}/f/factory/console_holds`, false),
    ).toBe(true);
  });

  test("allows a POST that runs the read script under steps", () => {
    expect(
      isAllowedProxyRequest(
        "POST",
        `${RUN}/f/factory/steps/console_query`,
        false,
      ),
    ).toBe(true);
  });

  test("refuses a POST that runs a write script", () => {
    expect(
      isAllowedProxyRequest("POST", `${RUN}/f/factory/approval_decide`, false),
    ).toBe(false);
  });

  test("refuses a POST to a path that only starts with a read script", () => {
    expect(
      isAllowedProxyRequest(
        "POST",
        `${RUN}/f/factory/console_query_extra`,
        false,
      ),
    ).toBe(false);
  });

  test("refuses a POST to another API path", () => {
    expect(
      isAllowedProxyRequest("POST", "/api/w/factory/jobs/run/p/f/x", false),
    ).toBe(false);
  });

  test("refuses a PUT", () => {
    expect(isAllowedProxyRequest("PUT", "/api/anything", false)).toBe(false);
  });

  test("refuses a DELETE", () => {
    expect(isAllowedProxyRequest("DELETE", "/api/anything", false)).toBe(false);
  });

  test("refuses a GET that would run a write script", () => {
    expect(
      isAllowedProxyRequest("GET", `${RUN}/f/factory/approval_decide`, false),
    ).toBe(false);
  });

  test("refuses a HEAD that would run a write script", () => {
    expect(
      isAllowedProxyRequest("HEAD", `${RUN}/f/factory/approval_decide`, false),
    ).toBe(false);
  });

  test("refuses a GET that would run even a read script", () => {
    expect(
      isAllowedProxyRequest("GET", `${RUN}/f/factory/console_holds`, false),
    ).toBe(false);
  });

  test("refuses a GET to the async run path", () => {
    expect(
      isAllowedProxyRequest("GET", "/api/w/factory/jobs/run/p/f/x", false),
    ).toBe(false);
  });

  test("refuses a GET to the streaming run path", () => {
    expect(
      isAllowedProxyRequest(
        "GET",
        "/api/w/factory/jobs/run_and_stream/p/f/x",
        false,
      ),
    ).toBe(false);
  });

  test("refuses a GET that resumes a job", () => {
    expect(
      isAllowedProxyRequest(
        "GET",
        "/api/w/factory/jobs_u/resume/1/2/sig",
        false,
      ),
    ).toBe(false);
  });

  test("refuses a GET that cancels a job", () => {
    expect(
      isAllowedProxyRequest(
        "GET",
        "/api/w/factory/jobs_u/queue/cancel/abc",
        false,
      ),
    ).toBe(false);
  });

  test("refuses a GET to an endpoint route", () => {
    expect(isAllowedProxyRequest("GET", "/api/r/anything", false)).toBe(false);
  });

  test("refuses a GET to a webhook path", () => {
    expect(
      isAllowedProxyRequest("GET", "/api/w/factory/x/webhook/abc", false),
    ).toBe(false);
  });

  test("refuses a GET to an API path that is not listed", () => {
    expect(
      isAllowedProxyRequest("GET", "/api/w/factory/variables/get/x", false),
    ).toBe(false);
  });

  test("allows a GET that reads one job", () => {
    expect(
      isAllowedProxyRequest("GET", "/api/w/factory/jobs_u/get/abc", false),
    ).toBe(true);
  });

  test("allows a GET that reads the signed-in user", () => {
    expect(isAllowedProxyRequest("GET", "/api/users/whoami", false)).toBe(true);
  });

  test("allows a GET to a page outside the API", () => {
    expect(isAllowedProxyRequest("GET", "/user/login", false)).toBe(true);
  });

  test("allows a GET that would run a write script when writes are enabled", () => {
    expect(
      isAllowedProxyRequest("GET", `${RUN}/f/factory/approval_decide`, true),
    ).toBe(true);
  });

  test("allows a write script when writes are enabled", () => {
    expect(
      isAllowedProxyRequest("POST", `${RUN}/f/factory/approval_decide`, true),
    ).toBe(true);
  });
});

describe("decideWriteConfirmation", () => {
  test("refuses when the input is not a terminal", () => {
    expect(decideWriteConfirmation(false, "yes")).toBe("not-interactive");
  });

  test("confirms when a person types yes at a terminal", () => {
    expect(decideWriteConfirmation(true, "yes")).toBe("confirmed");
  });

  test("ignores spaces around the answer", () => {
    expect(decideWriteConfirmation(true, " yes \n")).toBe("confirmed");
  });

  test("declines a short answer", () => {
    expect(decideWriteConfirmation(true, "y")).toBe("declined");
  });

  test("declines a different case", () => {
    expect(decideWriteConfirmation(true, "YES")).toBe("declined");
  });

  test("declines when there is no answer", () => {
    expect(decideWriteConfirmation(true, null)).toBe("declined");
  });
});

describe("--allow-writes without a terminal", () => {
  test("fails to start", async () => {
    const dist = mkdtempSync(join(tmpdir(), "console-branch-dist-"));
    writeFileSync(join(dist, "index.html"), "<html></html>");
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(""),
    });
    const port = probe.port;
    probe.stop(true);

    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../../scripts/console-branch-server.ts", import.meta.url)
          .pathname,
        "--dist",
        dist,
        "--port",
        String(port),
        "--allow-writes",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    const code = await child.exited;
    rmSync(dist, { recursive: true, force: true });

    expect(code).toBe(2);
  });

  test("says that a terminal is needed", async () => {
    const dist = mkdtempSync(join(tmpdir(), "console-branch-dist-"));
    writeFileSync(join(dist, "index.html"), "<html></html>");
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../../scripts/console-branch-server.ts", import.meta.url)
          .pathname,
        "--dist",
        dist,
        "--port",
        "59999",
        "--allow-writes",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    const text = await new Response(child.stderr).text();
    await child.exited;
    rmSync(dist, { recursive: true, force: true });

    expect(text).toContain("terminal");
  });
});

describe("isTrustedHost", () => {
  test("accepts the loopback address with the port", () => {
    expect(isTrustedHost("127.0.0.1:5174", 5174)).toBe(true);
  });

  test("accepts localhost with the port", () => {
    expect(isTrustedHost("localhost:5174", 5174)).toBe(true);
  });

  test("refuses another host name", () => {
    expect(isTrustedHost("evil.example:5174", 5174)).toBe(false);
  });

  test("refuses the loopback address with another port", () => {
    expect(isTrustedHost("127.0.0.1:8080", 5174)).toBe(false);
  });

  test("refuses a missing host", () => {
    expect(isTrustedHost(null, 5174)).toBe(false);
  });
});

describe("isOwnOrigin", () => {
  test("accepts this server's origin", () => {
    expect(isOwnOrigin("http://127.0.0.1:5174", 5174)).toBe(true);
  });

  test("accepts this server's origin written with localhost", () => {
    expect(isOwnOrigin("http://localhost:5174", 5174)).toBe(true);
  });

  test("refuses the upstream's origin", () => {
    expect(isOwnOrigin("http://127.0.0.1:8080", 5174)).toBe(false);
  });

  test("refuses another site", () => {
    expect(isOwnOrigin("https://evil.example", 5174)).toBe(false);
  });

  test("refuses the opaque origin", () => {
    expect(isOwnOrigin("null", 5174)).toBe(false);
  });
});

async function caddyPolicy(
  marker: string,
  until: string | null,
  origin: string,
): Promise<string> {
  const caddyfile = await Bun.file(
    new URL("../../infra/Caddyfile", import.meta.url).pathname,
  ).text();
  const start = caddyfile.indexOf(marker);
  const block = caddyfile.slice(
    start,
    until === null ? undefined : caddyfile.indexOf(until),
  );
  const line = block
    .split("\n")
    .find((l) => l.trim().startsWith("Content-Security-Policy "));
  return (line ?? "")
    .trim()
    .replace(/^Content-Security-Policy "/, "")
    .replace(/"$/, "")
    .replaceAll("{http.request.scheme}://{http.request.hostport}", origin);
}

describe("consoleSecurityHeaders", () => {
  const ORIGIN = "http://127.0.0.1:5174";

  test("restricts the console scripts to the assets directory", () => {
    const csp = consoleSecurityHeaders(ORIGIN, "console").get(
      "content-security-policy",
    );

    expect(csp).toContain(`script-src ${ORIGIN}/console/assets/;`);
  });

  test("forbids embedding the console", () => {
    expect(
      consoleSecurityHeaders(ORIGIN, "console").get("x-frame-options"),
    ).toBe("DENY");
  });

  test("sandboxes the draw.io page", () => {
    const csp = consoleSecurityHeaders(ORIGIN, "drawio").get(
      "content-security-policy",
    );

    expect(csp).toContain("sandbox allow-scripts");
  });

  test("matches the policy the Caddyfile sends for the console", async () => {
    expect(
      consoleSecurityHeaders(ORIGIN, "console").get("content-security-policy"),
    ).toBe(await caddyPolicy("(console_headers)", "(drawio_headers)", ORIGIN));
  });

  test("matches the policy the Caddyfile sends for the draw.io page", async () => {
    expect(
      consoleSecurityHeaders(ORIGIN, "drawio").get("content-security-policy"),
    ).toBe(await caddyPolicy("(drawio_headers)", null, ORIGIN));
  });
});

describe("toUpstreamRequestHeaders", () => {
  test("replaces this server's origin with the upstream origin", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ origin: "http://127.0.0.1:5174" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.get("origin")).toBe("http://127.0.0.1:8080");
  });

  test("drops the forwarded header", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ forwarded: "for=1.2.3.4" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("forwarded")).toBe(false);
  });

  test("drops the x-forwarded-for header", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ "x-forwarded-for": "1.2.3.4" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("x-forwarded-for")).toBe(false);
  });

  test("drops the x-forwarded-host header", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ "x-forwarded-host": "evil.example" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("x-forwarded-host")).toBe(false);
  });

  test("drops the x-real-ip header", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ "x-real-ip": "1.2.3.4" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("x-real-ip")).toBe(false);
  });

  test("drops a hop-by-hop header", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ upgrade: "websocket" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("upgrade")).toBe(false);
  });

  test("drops a header that the connection header names", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ connection: "x-secret", "x-secret": "1" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("x-secret")).toBe(false);
  });

  test("adds no origin when the request has none", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers(),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("origin")).toBe(false);
  });

  test("sets the host to the upstream", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ host: "127.0.0.1:5174" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.get("host")).toBe("127.0.0.1:8080");
  });

  test("keeps the cookie", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ cookie: "token=abc" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.get("cookie")).toBe("token=abc");
  });
});

describe("toClientResponseHeaders", () => {
  test("drops the content encoding the fetch already decoded", () => {
    const headers = toClientResponseHeaders(
      new Headers({ "content-encoding": "gzip", "content-length": "10" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("content-encoding")).toBe(false);
  });

  test("drops the content length of the decoded body", () => {
    const headers = toClientResponseHeaders(
      new Headers({ "content-encoding": "gzip", "content-length": "10" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.has("content-length")).toBe(false);
  });

  test("turns an absolute redirect to the upstream into a relative one", () => {
    const headers = toClientResponseHeaders(
      new Headers({ location: "http://127.0.0.1:8080/user/login?rd=%2F" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.get("location")).toBe("/user/login?rd=%2F");
  });

  test("keeps a double slash from becoming a protocol-relative redirect", () => {
    const headers = toClientResponseHeaders(
      new Headers({ location: "http://127.0.0.1:8080//evil.example/x" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.get("location")).toBe("/evil.example/x");
  });

  test("keeps a slash and backslash from becoming a protocol-relative redirect", () => {
    const headers = toClientResponseHeaders(
      new Headers({ location: "http://127.0.0.1:8080/\\evil.example/x" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.get("location")).toBe("/evil.example/x");
  });

  test("keeps a redirect to another origin", () => {
    const headers = toClientResponseHeaders(
      new Headers({ location: "https://example.com/x" }),
      "http://127.0.0.1:8080",
    );

    expect(headers.get("location")).toBe("https://example.com/x");
  });
});

describe("startServer", () => {
  type Seen = {
    method: string;
    url: string;
    cookie: string | null;
    origin: string | null;
    body: string;
  };

  const RUN = "/api/w/factory/jobs/run_wait_result/p";
  let root: string;
  let upstream: ReturnType<typeof Bun.serve>;
  let server: { port: number; stop(): void };
  let writer: { port: number; stop(): void };
  const seen: Seen[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "console-branch-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html>branch index</html>");
    writeFileSync(join(root, "drawio.html"), "<html>drawio</html>");
    writeFileSync(join(root, "assets", "app.js"), "console.log('branch');");
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({
          method: req.method,
          url: url.pathname + url.search,
          cookie: req.headers.get("cookie"),
          origin: req.headers.get("origin"),
          body: await req.text(),
        });
        return new Response("upstream reply", { status: 201 });
      },
    });
    const base = {
      dist: root,
      port: 0,
      upstream: `http://127.0.0.1:${upstream.port}`,
    };
    server = startServer({ ...base, allowWrites: false });
    writer = startServer({ ...base, allowWrites: true });
  });

  afterAll(() => {
    server.stop();
    writer.stop();
    upstream.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  function url(path: string, target = server): string {
    return `http://127.0.0.1:${target.port}${path}`;
  }

  test("serves the built index at the console root", async () => {
    const response = await fetch(url("/console/"));

    expect(await response.text()).toBe("<html>branch index</html>");
  });

  test("serves the index for a client-side route", async () => {
    const response = await fetch(url("/console/items/12?tab=requirements"));

    expect(await response.text()).toBe("<html>branch index</html>");
  });

  test("serves a built asset", async () => {
    const response = await fetch(url("/console/assets/app.js"));

    expect(await response.text()).toBe("console.log('branch');");
  });

  test("answers 404 for a missing asset", async () => {
    const response = await fetch(url("/console/assets/missing.js"));

    expect(response.status).toBe(404);
  });

  test("answers 400 for an encoded separator", async () => {
    const response = await fetch(url("/console/assets/..%2fsecret"));

    expect(response.status).toBe(400);
  });

  test("sends the console security policy with the index", async () => {
    const response = await fetch(url("/console/"));

    expect(response.headers.get("content-security-policy")).toContain(
      `script-src http://127.0.0.1:${server.port}/console/assets/;`,
    );
  });

  test("sends the sandbox policy with the draw.io page", async () => {
    const response = await fetch(url("/console/drawio.html"));

    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
  });

  test("relays a read script call with the upstream status", async () => {
    const response = await fetch(url(`${RUN}/f/factory/steps/console_query`), {
      method: "POST",
      body: '{"view":"summary"}',
    });

    expect(response.status).toBe(201);
  });

  test("relays the method, path, cookie, and body of a read call", async () => {
    seen.length = 0;

    await fetch(url(`${RUN}/f/factory/console_jobs?z=1`), {
      method: "POST",
      headers: {
        cookie: "token=abc",
        origin: `http://127.0.0.1:${server.port}`,
      },
      body: '{"b":2}',
    });

    expect(seen[0]).toEqual({
      method: "POST",
      url: `${RUN}/f/factory/console_jobs?z=1`,
      cookie: "token=abc",
      origin: `http://127.0.0.1:${upstream.port}`,
      body: '{"b":2}',
    });
  });

  test("relays a GET", async () => {
    const response = await fetch(url("/api/version"));

    expect(response.status).toBe(201);
  });

  test("refuses a GET that would run a write script", async () => {
    const response = await fetch(url(`${RUN}/f/factory/approval_decide`));

    expect(response.status).toBe(403);
  });

  test("refuses a HEAD that would run a write script", async () => {
    const response = await fetch(url(`${RUN}/f/factory/approval_decide`), {
      method: "HEAD",
    });

    expect(response.status).toBe(403);
  });

  test("does not reach the upstream with a refused GET", async () => {
    seen.length = 0;

    await fetch(url(`${RUN}/f/factory/approval_decide?payload=e30`));

    expect(seen).toEqual([]);
  });

  test("relays a GET that would run a write script when writes are enabled", async () => {
    seen.length = 0;

    await fetch(url(`${RUN}/f/factory/approval_decide?payload=e30`, writer));

    expect(seen.map((entry) => entry.method)).toEqual(["GET"]);
  });

  test("marks every response while writes are enabled", async () => {
    const response = await fetch(url("/console/", writer));

    expect(response.headers.get("x-branch-server-writes")).toBe("on");
  });

  test("marks a relayed response while writes are enabled", async () => {
    const response = await fetch(url("/api/version", writer));

    expect(response.headers.get("x-branch-server-writes")).toBe("on");
  });

  test("marks a refusal while writes are enabled", async () => {
    const response = await fetch(url("/api/version", writer), {
      headers: { origin: "https://evil.example" },
    });

    expect(response.headers.get("x-branch-server-writes")).toBe("on");
  });

  test("does not mark responses while writes are off", async () => {
    const response = await fetch(url("/console/"));

    expect(response.headers.get("x-branch-server-writes")).toBeNull();
  });

  test("refuses a write script call by default", async () => {
    const response = await fetch(url(`${RUN}/f/factory/approval_decide`), {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  test("does not reach the upstream with a refused write", async () => {
    seen.length = 0;

    await fetch(url(`${RUN}/f/factory/notice_resolve`), {
      method: "POST",
      body: "{}",
    });

    expect(seen).toEqual([]);
  });

  test("refuses a DELETE by default", async () => {
    const response = await fetch(url("/api/w/factory/variables/delete/x"), {
      method: "DELETE",
    });

    expect(response.status).toBe(403);
  });

  test("refuses a request with another host name", async () => {
    const response = await fetch(url("/api/version"), {
      headers: { host: "evil.example" },
    });

    expect(response.status).toBe(403);
  });

  test("accepts the localhost host name with this port", async () => {
    const response = await fetch(url("/api/version"), {
      headers: { host: `localhost:${server.port}` },
    });

    expect(response.status).toBe(201);
  });

  test("refuses a request from another origin", async () => {
    const response = await fetch(url("/api/version"), {
      headers: { origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
  });

  test("refuses a request the browser marks as cross-site", async () => {
    const response = await fetch(url("/api/version"), {
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(response.status).toBe(403);
  });

  test("relays a write script call when writes are enabled", async () => {
    seen.length = 0;

    const response = await fetch(
      url(`${RUN}/f/factory/approval_decide`, writer),
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(201);
  });

  test("reaches the upstream with an enabled write", async () => {
    seen.length = 0;

    await fetch(url(`${RUN}/f/factory/notice_resolve`, writer), {
      method: "POST",
      body: "{}",
    });

    expect(seen.map((entry) => entry.url)).toEqual([
      `${RUN}/f/factory/notice_resolve`,
    ]);
  });
});
