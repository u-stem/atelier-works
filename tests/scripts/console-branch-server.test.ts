import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
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
});

describe("toUpstreamRequestHeaders", () => {
  test("drops the origin header", () => {
    const headers = toUpstreamRequestHeaders(
      new Headers({ origin: "http://127.0.0.1:5174" }),
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

  let root: string;
  let upstream: ReturnType<typeof Bun.serve>;
  let server: { port: number; stop(): void };
  const seen: Seen[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "console-branch-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html>branch index</html>");
    writeFileSync(join(root, "assets", "app.js"), "console.log('branch');");
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        seen.push({
          method: req.method,
          url: new URL(req.url).pathname + new URL(req.url).search,
          cookie: req.headers.get("cookie"),
          origin: req.headers.get("origin"),
          body: await req.text(),
        });
        return new Response("upstream reply", { status: 201 });
      },
    });
    server = startServer({
      dist: root,
      port: 0,
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
  });

  afterAll(() => {
    server.stop();
    upstream.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  function url(path: string): string {
    return `http://127.0.0.1:${server.port}${path}`;
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

  test("forwards an API call to the upstream with the response status", async () => {
    const response = await fetch(url("/api/w/factory/jobs/x"), {
      method: "POST",
      headers: {
        cookie: "token=abc",
        origin: `http://127.0.0.1:${server.port}`,
      },
      body: '{"a":1}',
    });

    expect(response.status).toBe(201);
  });

  test("forwards the method, path, cookie, and body to the upstream", async () => {
    seen.length = 0;

    await fetch(url("/api/w/factory/jobs/y?z=1"), {
      method: "POST",
      headers: {
        cookie: "token=abc",
        origin: `http://127.0.0.1:${server.port}`,
      },
      body: '{"b":2}',
    });

    expect(seen[0]).toEqual({
      method: "POST",
      url: "/api/w/factory/jobs/y?z=1",
      cookie: "token=abc",
      origin: null,
      body: '{"b":2}',
    });
  });
});
