// GitHubの通信層(`lib/github_http.ts`)のテスト。実際には通信せず、`fetch`を差し替える。
// 後半は、トークンを載せる経路がこのモジュールだけにあることを、Factoryのscriptを走査して固定する。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GITHUB_RATE_LIMIT_MAX_WAIT_MS,
  GitHubRateLimitError,
  RATE_LIMIT_HINT_TEXT_LIMIT,
  SECONDARY_RATE_LIMIT_PHRASE,
} from "../../f/factory/lib/github_errors.ts";
import {
  assertGitHubApiPath,
  classifyRateLimit,
  GITHUB_API_ORIGIN,
  type GitHubHttpClient,
  type GitHubSendResult,
  graphqlErrorsRateLimited,
  graphqlRateLimit,
  type HttpFetch,
  requestGitHub,
  runGitHubRequest,
  sendGitHubRequest,
} from "../../f/factory/lib/github_http.ts";
import { codeOf, codeSkeleton } from "../scripts/worker_boundary_scan.ts";

const TOKEN = "github_pat_TESTSECRETVALUE0123456789";
const NOW = new Date("2026-11-01T00:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;

function headersOf(
  entries: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function classify(
  status: number,
  headers: Readonly<Record<string, string>> = {},
  body = "",
) {
  return classifyRateLimit(status, headersOf(headers), body, NOW);
}

function jsonMessage(message: string): string {
  return JSON.stringify({ message });
}

type Sent = { readonly url: string; readonly init: RequestInit };

/** 順に応答を返す`fetch`。`Error`を渡すと、その回は拒否する。 */
function fakeFetch(steps: readonly (Response | Error)[]) {
  const sent: Sent[] = [];
  let index = 0;
  const fetch: HttpFetch = async (url, init) => {
    sent.push({ url, init });
    const step = steps[index] ?? new Response("{}", { status: 200 });
    index += 1;
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetch, sent };
}

function client(fetch: HttpFetch, sleeps: number[] = []): GitHubHttpClient {
  return {
    token: TOKEN,
    fetch,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function headerOf(init: RequestInit | undefined, name: string): unknown {
  const headers = init?.headers;
  return headers instanceof Headers
    ? headers.get(name)
    : Reflect.get(headers ?? {}, name);
}

/** 本文の読み取りの途中で、`error`で失敗する応答。 */
function brokenBody(status: number, error: Error): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      controller.error(error);
    },
  });
  return new Response(stream, { status });
}

describe("classifyRateLimit keeps a permission 403 out of the rate limit", () => {
  // dependabot_prepare、pr_ci_watch、main_ci_watch、dependabot_finishと、github.tsの403の分岐は、
  // 権限不足の403を見て扱い(needs_human、denied、forbidden)を決める。制限と読むと、その分岐を通らない。
  test("a 403 with quota left is not a rate limit", () => {
    expect(
      classify(
        403,
        { "x-ratelimit-remaining": "4999" },
        jsonMessage("Resource not accessible by personal access token"),
      ),
    ).toBeNull();
  });

  test("a 403 with quota left is not a rate limit even when the message names a rate limit", () => {
    expect(
      classify(
        403,
        { "x-ratelimit-remaining": "1" },
        jsonMessage("Must have admin rights; see the rate limit docs"),
      ),
    ).toBeNull();
  });

  test("a 403 with a reset time and quota left is not a rate limit", () => {
    expect(
      classify(
        403,
        {
          "x-ratelimit-remaining": "42",
          "x-ratelimit-reset": String(NOW_SEC + 600),
        },
        jsonMessage("Resource not accessible by integration"),
      ),
    ).toBeNull();
  });

  test("a 403 without any limit hint is not a rate limit", () => {
    expect(classify(403, {}, jsonMessage("Forbidden"))).toBeNull();
  });
});

// 判定の表が使う定数は`github_errors.ts`にあり、保護パスの外である。値をここで固定する。
describe("the constants the table depends on", () => {
  test("the secondary limit phrase", () => {
    expect(SECONDARY_RATE_LIMIT_PHRASE).toBe("secondary rate limit");
  });

  test("the length of the message read for the hints", () => {
    expect(RATE_LIMIT_HINT_TEXT_LIMIT).toBe(4096);
  });

  test("the cap of the wait", () => {
    expect(GITHUB_RATE_LIMIT_MAX_WAIT_MS).toBe(120_000);
  });
});

describe("classifyRateLimit table", () => {
  test("row 1: a 403 with retry-after is a secondary limit that waits the retry-after", () => {
    expect(classify(403, { "retry-after": "30" })).toMatchObject({
      kind: "secondary",
      waitMs: 30_000,
      retryAfterSec: 30,
    });
  });

  test("row 1: a 429 with retry-after is a secondary limit", () => {
    expect(classify(429, { "retry-after": "5" })?.kind).toBe("secondary");
  });

  test("row 1: a retry-after that is not a number is ignored", () => {
    expect(
      classify(403, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    ).toBeNull();
  });

  test("row 2: a 403 with no quota left is a primary limit that waits until the reset plus a second", () => {
    expect(
      classify(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(NOW_SEC + 30),
      }),
    ).toMatchObject({ kind: "primary", waitMs: 31_000 });
  });

  test("row 2: a 429 with no quota left is a primary limit", () => {
    expect(classify(429, { "x-ratelimit-remaining": "0" })?.kind).toBe(
      "primary",
    );
  });

  test("row 2: a reset in the past waits only the margin", () => {
    expect(
      classify(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(NOW_SEC - 10),
      })?.waitMs,
    ).toBe(1000);
  });

  test("row 3: a 403 whose message names a secondary rate limit waits a minute", () => {
    expect(
      classify(
        403,
        {},
        jsonMessage("You have exceeded a secondary rate limit."),
      ),
    ).toMatchObject({ kind: "secondary", waitMs: 60_000 });
  });

  test("row 3: a 429 whose message names a secondary rate limit is a secondary limit", () => {
    expect(classify(429, {}, jsonMessage("secondary rate limit"))?.kind).toBe(
      "secondary",
    );
  });

  test("row 3: the phrase is matched regardless of letter case", () => {
    expect(
      classify(403, {}, jsonMessage("SECONDARY Rate Limit exceeded"))?.kind,
    ).toBe("secondary");
  });

  test("row 3: the phrase counts even with quota left", () => {
    expect(
      classify(
        403,
        { "x-ratelimit-remaining": "42" },
        jsonMessage("secondary rate limit"),
      )?.kind,
    ).toBe("secondary");
  });

  test("row 3: the phrase outside the message field does not count", () => {
    expect(
      classify(
        403,
        {},
        JSON.stringify({ message: "Forbidden", note: "secondary rate limit" }),
      ),
    ).toBeNull();
  });

  test("row 3: a body that is not JSON does not count", () => {
    expect(
      classify(403, {}, "You have exceeded a secondary rate limit."),
    ).toBeNull();
  });

  test("row 4: a 403 that names a rate limit without the remaining header is a primary limit", () => {
    expect(
      classify(403, {}, jsonMessage("API rate limit exceeded for user ID 1."))
        ?.kind,
    ).toBe("primary");
  });

  test("row 4: without a reset time it has no wait", () => {
    expect(
      classify(403, {}, jsonMessage("API rate limit exceeded for user ID 1."))
        ?.waitMs,
    ).toBeNull();
  });

  test("row 4: with a reset time it waits until the reset", () => {
    expect(
      classify(
        403,
        { "x-ratelimit-reset": String(NOW_SEC + 60) },
        jsonMessage("API rate limit exceeded"),
      )?.waitMs,
    ).toBe(61_000);
  });

  test("row 5: a bare 429 is a secondary limit that waits a minute", () => {
    expect(classify(429)).toMatchObject({ kind: "secondary", waitMs: 60_000 });
  });

  test("row 5: a 429 with quota left is still a secondary limit", () => {
    expect(classify(429, { "x-ratelimit-remaining": "10" })?.kind).toBe(
      "secondary",
    );
  });

  test("row 6: a 404 is not a rate limit", () => {
    expect(classify(404, { "retry-after": "1" })).toBeNull();
  });

  test("row 6: a 200 is not a rate limit", () => {
    expect(classify(200, { "x-ratelimit-remaining": "0" })).toBeNull();
  });

  test("keeps the resource of the limit", () => {
    expect(
      classify(403, { "retry-after": "1", "x-ratelimit-resource": "core" })
        ?.resource,
    ).toBe("core");
  });

  test("keeps the reset time of the limit", () => {
    expect(
      classify(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1790000000",
      })?.resetAtSec,
    ).toBe(1790000000);
  });

  test("row 7: a GraphQL RATE_LIMITED error is a rate limit", () => {
    expect(
      graphqlErrorsRateLimited([
        { type: "NOT_FOUND" },
        { type: "RATE_LIMITED" },
      ]),
    ).toBe(true);
  });

  test("row 7: other GraphQL errors are not a rate limit", () => {
    expect(graphqlErrorsRateLimited([{ type: "NOT_FOUND" }])).toBe(false);
  });

  test("row 7: the GraphQL limit is primary and waits until the reset", () => {
    expect(
      graphqlRateLimit(
        headersOf({ "x-ratelimit-reset": String(NOW_SEC + 600) }),
        NOW,
      ),
    ).toMatchObject({ kind: "primary", waitMs: 601_000 });
  });
});

describe("assertGitHubApiPath", () => {
  test.each([
    ["an absolute URL", "https://evil.example/repos/o/r"],
    ["a scheme", "javascript:alert(1)"],
    ["a protocol-relative path", "//evil.example/repos"],
    ["a leading slash", "/repos/o/r"],
    ["a backslash", "repos\\o\\r"],
    ["a fragment", "repos/o/r#x"],
    ["a dot segment", "repos/o/./r"],
    ["a dot-dot segment", "repos/o/../r"],
    ["an encoded dot segment", "repos/o/%2e%2e/r"],
    ["an encoded dot in a segment", "repos/o/a%2Eb"],
    ["the search API", "search/issues?q=x"],
    ["the search API in capitals", "SEARCH/code"],
    ["the bare search path with a query", "search?q=x"],
    ["an empty path", ""],
    ["a path that URL would rewrite", "repos/o/r/a b"],
  ])("rejects %s", (_name, path) => {
    expect(() => assertGitHubApiPath(path)).toThrow();
  });

  test("accepts a name that contains two dots", () => {
    expect(() =>
      assertGitHubApiPath("repos/o/r/contents/a..b.md"),
    ).not.toThrow();
  });

  test("accepts the compare form with three dots", () => {
    expect(() =>
      assertGitHubApiPath("repos/o/r/compare/main...feature"),
    ).not.toThrow();
  });

  test("accepts graphql", () => {
    expect(() => assertGitHubApiPath("graphql")).not.toThrow();
  });

  test("accepts a query string", () => {
    expect(() =>
      assertGitHubApiPath("repos/o/r/issues?labels=a%20b&per_page=100"),
    ).not.toThrow();
  });

  test("does not put the path in the error", () => {
    let message = "";
    try {
      assertGitHubApiPath("repos/o/../secret-query-value");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("secret-query-value");
  });
});

describe("sendGitHubRequest request shape", () => {
  test("sends to the fixed origin", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent[0]?.url).toBe(`${GITHUB_API_ORIGIN}/repos/o/r`);
  });

  test("the fixed origin is api.github.com over https", () => {
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
  });

  test("carries the token in the Authorization header", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(headerOf(f.sent[0]?.init, "Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("keeps the token out of the url and the body", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), {
      path: "graphql",
      method: "POST",
      body: { query: "q" },
    });
    expect(`${f.sent[0]?.url}${String(f.sent[0]?.init.body)}`).not.toContain(
      TOKEN,
    );
  });

  test("never lets fetch follow a redirect by itself", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent[0]?.init.redirect).toBe("manual");
  });

  test("sets a deadline signal", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("names the client in the User-Agent", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(headerOf(f.sent[0]?.init, "User-Agent")).toBe(
      "atelier-works-factory",
    );
  });

  test("sends the body as JSON", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), {
      path: "graphql",
      method: "POST",
      body: { query: "q" },
    });
    expect(JSON.parse(String(f.sent[0]?.init.body))).toEqual({ query: "q" });
  });

  test("uses the method of the request", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r/issues/1",
      method: "PATCH",
      body: {},
    });
    expect(f.sent[0]?.init.method).toBe("PATCH");
  });

  test("rejects the search API without sending", async () => {
    const f = fakeFetch([]);
    await sendGitHubRequest(client(f.fetch), { path: "search/issues" }).catch(
      () => undefined,
    );
    expect(f.sent).toHaveLength(0);
  });
});

describe("sendGitHubRequest results", () => {
  test("returns the status, the lower-cased headers, and the body", async () => {
    const f = fakeFetch([
      new Response('{"a":1}', {
        status: 201,
        headers: { "X-RateLimit-Remaining": "5" },
      }),
    ]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect({
      status: response.status,
      remaining: response.headers.get("x-ratelimit-remaining"),
      body: response.bodyText,
    }).toEqual({ status: 201, remaining: "5", body: '{"a":1}' });
  });

  test("returns status 0 when fetch rejects", async () => {
    const f = fakeFetch([new TypeError("connection refused")]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect(response.status).toBe(0);
  });

  test("keeps the text of the rejection out of the response", async () => {
    const f = fakeFetch([
      new TypeError(`failed for https://api.github.com/x?token=${TOKEN}`),
    ]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect(JSON.stringify(response)).not.toContain(TOKEN);
  });

  test("marks a rejection by the deadline as timed out", async () => {
    const f = fakeFetch([new DOMException("timed out", "TimeoutError")]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect([response.status, response.timedOut]).toEqual([0, true]);
  });

  test("marks a body cut in the middle as incomplete and keeps the status", async () => {
    const f = fakeFetch([brokenBody(200, new TypeError("cut"))]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect([response.status, response.incomplete]).toEqual([200, true]);
  });

  test("marks a body cut by the deadline as timed out", async () => {
    const f = fakeFetch([
      brokenBody(200, new DOMException("timed out", "TimeoutError")),
    ]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect(response.timedOut).toBe(true);
  });

  test("classifies a 429 whose body could not be read as a secondary limit", async () => {
    const f = fakeFetch([brokenBody(429, new TypeError("cut"))]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect(response.rateLimit?.kind).toBe("secondary");
  });

  test("classifies the rate limit of the response", async () => {
    const f = fakeFetch([
      new Response("{}", { status: 403, headers: { "Retry-After": "7" } }),
    ]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect(response.rateLimit?.waitMs).toBe(7000);
  });
});

describe("sendGitHubRequest redirects", () => {
  function redirect(location: string, status = 301): Response {
    return new Response(null, { status, headers: { Location: location } });
  }

  test("follows a GET to the same origin", async () => {
    const f = fakeFetch([
      redirect("https://api.github.com/repositories/1/issues/2"),
      new Response('{"ok":true}', { status: 200 }),
    ]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r/issues/2",
    });
    expect([response.status, f.sent[1]?.url]).toEqual([
      200,
      "https://api.github.com/repositories/1/issues/2",
    ]);
  });

  test("carries the token on the followed request", async () => {
    const f = fakeFetch([
      redirect("https://api.github.com/repositories/1"),
      new Response("{}", { status: 200 }),
    ]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(headerOf(f.sent[1]?.init, "Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("resolves a relative Location against the current URL", async () => {
    const f = fakeFetch([
      redirect("/repositories/1"),
      new Response("{}", { status: 200 }),
    ]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent[1]?.url).toBe("https://api.github.com/repositories/1");
  });

  test("does not follow to another host", async () => {
    const f = fakeFetch([redirect("https://evil.example/repos/o/r")]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect([response.status, f.sent.length]).toEqual([301, 1]);
  });

  test("does not follow to a protocol-relative Location on another host", async () => {
    const f = fakeFetch([redirect("//evil.example/repos/o/r")]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent.length).toBe(1);
  });

  test("does not follow to the same host over http", async () => {
    const f = fakeFetch([redirect("http://api.github.com/repos/o/r")]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent.length).toBe(1);
  });

  test("does not follow to the same host on another port", async () => {
    const f = fakeFetch([redirect("https://api.github.com:8443/repos/o/r")]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent.length).toBe(1);
  });

  test("does not follow to the search API", async () => {
    const f = fakeFetch([redirect("https://api.github.com/search/issues")]);
    await sendGitHubRequest(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent.length).toBe(1);
  });

  test("does not follow when the request says never", async () => {
    const f = fakeFetch([redirect("https://api.github.com/repositories/1")]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r/issues/1",
      redirect: "never",
    });
    expect([response.status, f.sent.length]).toEqual([301, 1]);
  });

  test("does not follow a POST", async () => {
    const f = fakeFetch([
      redirect("https://api.github.com/repositories/1", 307),
    ]);
    await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r/issues",
      method: "POST",
      body: {},
    });
    expect(f.sent.length).toBe(1);
  });

  test("follows at most three times", async () => {
    const f = fakeFetch([
      redirect("/a"),
      redirect("/b"),
      redirect("/c"),
      redirect("/d"),
    ]);
    const response = await sendGitHubRequest(client(f.fetch), {
      path: "repos/o/r",
    });
    expect([response.status, f.sent.length]).toEqual([301, 4]);
  });
});

describe("requestGitHub retries", () => {
  test("retries a GET once after a 5xx", async () => {
    const f = fakeFetch([
      new Response("", { status: 502 }),
      new Response("{}", { status: 200 }),
    ]);
    const response = await requestGitHub(client(f.fetch), {
      path: "repos/o/r",
    });
    expect([response.status, f.sent.length]).toEqual([200, 2]);
  });

  test("waits the transient delay before the retry", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([
      new Response("", { status: 502 }),
      new Response("{}", { status: 200 }),
    ]);
    await requestGitHub(client(f.fetch, sleeps), { path: "repos/o/r" });
    expect(sleeps).toEqual([2000]);
  });

  test("returns the second 5xx without a third request", async () => {
    const f = fakeFetch([
      new Response("", { status: 502 }),
      new Response("", { status: 503 }),
      new Response("{}", { status: 200 }),
    ]);
    const response = await requestGitHub(client(f.fetch), {
      path: "repos/o/r",
    });
    expect([response.status, f.sent.length]).toEqual([503, 2]);
  });

  test("retries a GET once after a lost response", async () => {
    const f = fakeFetch([
      new TypeError("reset"),
      new Response("{}", { status: 200 }),
    ]);
    const response = await requestGitHub(client(f.fetch), {
      path: "repos/o/r",
    });
    expect(response.status).toBe(200);
  });

  test("does not retry a POST after a 5xx", async () => {
    const f = fakeFetch([new Response("", { status: 502 })]);
    await requestGitHub(client(f.fetch), {
      path: "repos/o/r/issues",
      method: "POST",
      body: {},
    });
    expect(f.sent.length).toBe(1);
  });

  test("retries a POST that is marked idempotent", async () => {
    const f = fakeFetch([
      new Response("", { status: 502 }),
      new Response("{}", { status: 200 }),
    ]);
    await requestGitHub(client(f.fetch), {
      path: "graphql",
      method: "POST",
      body: {},
      idempotent: true,
    });
    expect(f.sent.length).toBe(2);
  });

  test("does not retry a request that timed out", async () => {
    const f = fakeFetch([new DOMException("timed out", "TimeoutError")]);
    await requestGitHub(client(f.fetch), { path: "repos/o/r" });
    expect(f.sent.length).toBe(1);
  });

  test("does not retry when the request says never", async () => {
    const f = fakeFetch([new Response("", { status: 502 })]);
    await requestGitHub(client(f.fetch), { path: "repos/o/r", retry: "never" });
    expect(f.sent.length).toBe(1);
  });

  test("reads a GET again once after an incomplete body", async () => {
    const f = fakeFetch([
      brokenBody(200, new TypeError("cut")),
      new Response('{"ok":true}', { status: 200 }),
    ]);
    const response = await requestGitHub(client(f.fetch), {
      path: "repos/o/r",
    });
    expect([response.bodyText, f.sent.length]).toEqual(['{"ok":true}', 2]);
  });

  test("does not read a GET again when the deadline cut the body", async () => {
    const f = fakeFetch([
      brokenBody(200, new DOMException("timed out", "TimeoutError")),
      new Response('{"ok":true}', { status: 200 }),
    ]);
    const response = await requestGitHub(client(f.fetch), {
      path: "repos/o/r",
    });
    expect([response.timedOut, f.sent.length]).toEqual([true, 1]);
  });

  test("does not read a POST again after an incomplete body", async () => {
    const f = fakeFetch([brokenBody(200, new TypeError("cut"))]);
    const response = await requestGitHub(client(f.fetch), {
      path: "repos/o/r/issues",
      method: "POST",
      body: {},
    });
    expect([response.incomplete, f.sent.length]).toEqual([true, 1]);
  });
});

describe("requestGitHub rate limits", () => {
  const secondary = (seconds: number) =>
    new Response("{}", {
      status: 403,
      headers: { "Retry-After": String(seconds) },
    });

  test("waits once and returns the retry", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([secondary(30), new Response("{}", { status: 200 })]);
    const response = await requestGitHub(client(f.fetch, sleeps), {
      path: "repos/o/r",
    });
    expect([response.status, sleeps]).toEqual([200, [30_000]]);
  });

  test("throws without waiting when the wait is beyond the cap", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([secondary(121)]);
    const error = await requestGitHub(client(f.fetch, sleeps), {
      path: "repos/o/r",
    }).catch((err: unknown) => err);
    expect([error instanceof GitHubRateLimitError, sleeps]).toEqual([true, []]);
  });

  test("throws a retried error when the retry is limited again", async () => {
    const f = fakeFetch([secondary(1), secondary(1)]);
    const error = await requestGitHub(client(f.fetch), {
      path: "repos/o/r",
    }).catch((err: unknown) => err);
    expect(error instanceof GitHubRateLimitError && error.retried).toBe(true);
  });

  test("throws at once when the policy is throw", async () => {
    const f = fakeFetch([secondary(1)]);
    const error = await requestGitHub(
      client(f.fetch),
      { path: "repos/o/r" },
      { mode: "throw" },
    ).catch((err: unknown) => err);
    expect([error instanceof GitHubRateLimitError, f.sent.length]).toEqual([
      true,
      1,
    ]);
  });

  test("returns the limited response when the policy is report", async () => {
    const f = fakeFetch([secondary(1)]);
    const response = await requestGitHub(
      client(f.fetch),
      { path: "repos/o/r" },
      { mode: "report" },
    );
    expect([response.status, response.rateLimit?.kind]).toEqual([
      403,
      "secondary",
    ]);
  });

  test("throws at once for a primary limit without a reset time", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([
      new Response(jsonMessage("API rate limit exceeded"), { status: 403 }),
    ]);
    const error = await requestGitHub(client(f.fetch, sleeps), {
      path: "repos/o/r",
    }).catch((err: unknown) => err);
    expect([error instanceof GitHubRateLimitError, sleeps]).toEqual([true, []]);
  });

  // ヘッダーの無い429と、`remaining`の無い403は、制限かどうかの確かさが低い。
  // 冪等でない要求を送り直すと、制限でなかったときに二重に効くので、待たずに投げる。
  test("throws at once without resending a POST after a bare 429", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([new Response("{}", { status: 429 })]);
    const error = await requestGitHub(client(f.fetch, sleeps), {
      path: "repos/o/r/issues",
      method: "POST",
      body: {},
    }).catch((err: unknown) => err);
    expect([
      error instanceof GitHubRateLimitError,
      sleeps,
      f.sent.length,
    ]).toEqual([true, [], 1]);
  });

  test("throws at once without resending a POST after a 403 that names a rate limit without the remaining header", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([
      new Response(jsonMessage("API rate limit exceeded"), {
        status: 403,
        headers: { "X-RateLimit-Reset": String(NOW_SEC + 30) },
      }),
    ]);
    const error = await requestGitHub(client(f.fetch, sleeps), {
      path: "repos/o/r/issues",
      method: "POST",
      body: {},
    }).catch((err: unknown) => err);
    expect([
      error instanceof GitHubRateLimitError,
      sleeps,
      f.sent.length,
    ]).toEqual([true, [], 1]);
  });

  test("waits and resends a GET after a bare 429", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([
      new Response("{}", { status: 429 }),
      new Response("{}", { status: 200 }),
    ]);
    await requestGitHub(client(f.fetch, sleeps), { path: "repos/o/r" });
    expect([sleeps, f.sent.length]).toEqual([[60_000], 2]);
  });

  test("waits and resends a POST after a retry-after", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([secondary(5), new Response("{}", { status: 200 })]);
    await requestGitHub(client(f.fetch, sleeps), {
      path: "repos/o/r/issues",
      method: "POST",
      body: {},
    });
    expect([sleeps, f.sent.length]).toEqual([[5000], 2]);
  });

  test("keeps the query out of the error message", async () => {
    const f = fakeFetch([secondary(999)]);
    const error = await requestGitHub(client(f.fetch), {
      path: "repos/o/r/issues?labels=secret-label",
    }).catch((err: unknown) => err);
    expect(String(error)).not.toContain("secret-label");
  });
});

describe("runGitHubRequest with a sender that may not send", () => {
  const ok = {
    status: 200,
    headers: new Map<string, string>(),
    bodyText: "{}",
  };

  test("retries a request that was not sent, even a POST", async () => {
    const results: GitHubSendResult<typeof ok>[] = [
      { kind: "not_sent", error: new Error("EAGAIN") },
      { kind: "response", response: ok, noResponse: false },
    ];
    let calls = 0;
    const response = await runGitHubRequest(
      { sleep: async () => {} },
      { endpoint: "repos/o/r/issues", method: "POST" },
      { mode: "wait_once" },
      async () => {
        const next = results[calls] ?? results[0];
        calls += 1;
        if (next === undefined) throw new Error("no result");
        return next;
      },
    );
    expect([response.status, calls]).toEqual([200, 2]);
  });

  test("does not read again a response whose body the deadline cut", async () => {
    let calls = 0;
    await runGitHubRequest(
      { sleep: async () => {} },
      { endpoint: "repos/o/r" },
      { mode: "wait_once" },
      async () => {
        calls += 1;
        return {
          kind: "response",
          response: { ...ok, incomplete: true, timedOut: true },
          noResponse: false,
        };
      },
    );
    expect(calls).toBe(1);
  });

  test("throws the error when the retry is not sent either", async () => {
    const error = new Error("EAGAIN");
    const thrown = await runGitHubRequest<typeof ok>(
      { sleep: async () => {} },
      { endpoint: "repos/o/r" },
      { mode: "wait_once" },
      async () => ({ kind: "not_sent", error }),
    ).catch((err: unknown) => err);
    expect(thrown).toBe(error);
  });
});

// ---------------------------------------------------------------------------
// トークンを載せる経路の走査
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "../..");
const FACTORY_DIR = join(ROOT, "f/factory");
const HTTP_MODULE = "lib/github_http.ts";

type Source = { readonly path: string; readonly code: string };

/** `f/factory`の、テストでないTypeScript。コメントと型を落とし、文字列の中身を残した本文。 */
function factorySources(): Source[] {
  return readdirSync(FACTORY_DIR, { recursive: true })
    .map(String)
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts") &&
        !path.split("/").includes("node_modules"),
    )
    .sort()
    .map((path) => ({
      path,
      code: codeOf(readFileSync(join(FACTORY_DIR, path), "utf8")),
    }));
}

/**
 * 自分でトークンをAPIへ載せるファイル。artifactの取得の最初の要求で、通信層を通さずに送る。
 * 取得の手順を`github_http.ts`へ移したら、一覧から外す。
 * 保護パスのファイルなので、この一覧から外さずに経路を足す変更は人のレビューを経る。
 */
const AUTHORIZATION_EXCEPTIONS: Readonly<Record<string, string>> = {
  "lib/metadata_patch_download.ts":
    "the artifact download sends its first request itself until it moves to github_http.ts",
};

/**
 * `github_http.ts`の外で、グローバルの`fetch`を参照するファイルと理由。
 * GitHubへ送るものは、`fetch`を値として通信層に渡すだけで、自分ではトークンを載せない(上の走査が固定する)。
 * 一覧と実際がずれると落ちる。足すときは、送り先とトークンの有無を理由に書く。
 */
const GLOBAL_FETCH_USERS: Readonly<Record<string, string>> = {
  "approval_decide.ts":
    "passes fetch to fetchIssueContent, which sends through github_http.ts",
  "retry_work_item.ts":
    "passes fetch to fetchIssueState and fetchIssueContent, which send through github_http.ts",
  "collect_github.ts":
    "passes fetch to graphqlRequest, which sends through github_http.ts",
  "detect_schedule_failures.ts":
    "pings the heartbeat URL without a GitHub token",
  "drawio_viewer_bump.ts": "downloads the viewer without a GitHub token",
  "poll_dependabot.ts": "reads the npm registry without a GitHub token",
  "steps/dependabot_prepare.ts":
    "reads the npm registry without a GitHub token",
  "self_update.ts": "posts to the Discord webhook without a GitHub token",
  "lib/discord.ts": "posts to the Discord webhook without a GitHub token",
};

/**
 * `github_http.ts`から値をimportしてよいファイル。ほかのファイルは`import type`だけを使う。
 * 通信層の関数を呼ぶファイルを増やす変更を、この保護されたテストの変更として人のレビューに回すため。
 */
const HTTP_VALUE_IMPORTERS: readonly string[] = [
  "lib/github.ts",
  "lib/gh_graphql.ts",
  "lib/metadata_patch_download.ts",
];

/** `Authorization`ヘッダーを組み立てる書き方。オブジェクトのキー、`Headers`への設定、組の配列。 */
const AUTHORIZATION_HEADER =
  /["']?\bauthorization["']?\s*:|\.\s*(?:set|append)\s*\(\s*["']authorization["']|\[\s*["']authorization["']\s*,/i;

/** グローバルの`fetch`の参照。プロパティ(`.fetch`)とオブジェクトのキー(`fetch:`)は除く。 */
const GLOBAL_FETCH = /(?<![.\w$])fetch\b(?!\s*:)/;
const GLOBAL_FETCH_THROUGH_OBJECT =
  /\b(?:globalThis|global|self|window|Bun)\s*(?:\.\s*fetch\b|\[)/;

/**
 * `github_http.ts`から値を読み込む書き方。import、再エクスポート(`export ... from`、`export * from`)、動的import。
 * `import type`と`export type`は除く。
 */
const HTTP_VALUE_IMPORT =
  /(?:\b(?:import|export)\s+(?!type\s)[^;]*?from\s*|\bimport\s*\(\s*)["'][^"']*github_http\.ts["']/s;

describe("only github_http.ts carries the token to the GitHub API", () => {
  const sources = factorySources();

  test("scans the Factory scripts", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  test("the header pattern sees an Authorization key", () => {
    expect(AUTHORIZATION_HEADER.test('{ Authorization: "x" }')).toBe(true);
  });

  test("the header pattern sees a Headers set", () => {
    expect(
      AUTHORIZATION_HEADER.test('headers.set("authorization", value)'),
    ).toBe(true);
  });

  test("the header pattern does not see the redaction pattern", () => {
    expect(
      AUTHORIZATION_HEADER.test(
        String.raw`/(\bAuthorization["']?\s*[=:]\s*)/gi`,
      ),
    ).toBe(false);
  });

  test("no other file builds an Authorization header", () => {
    const offenders = sources
      .filter(
        (source) =>
          source.path !== HTTP_MODULE &&
          !(source.path in AUTHORIZATION_EXCEPTIONS) &&
          AUTHORIZATION_HEADER.test(source.code),
      )
      .map((source) => source.path);
    expect(offenders).toEqual([]);
  });

  test("github_http.ts builds the Authorization header", () => {
    const http = sources.find((source) => source.path === HTTP_MODULE);
    expect(AUTHORIZATION_HEADER.test(http?.code ?? "")).toBe(true);
  });

  test("no other file names the API host", () => {
    const offenders = sources
      .filter(
        (source) =>
          source.path !== HTTP_MODULE &&
          !(source.path in AUTHORIZATION_EXCEPTIONS) &&
          /api\.github\.com/i.test(source.code),
      )
      .map((source) => source.path);
    expect(offenders).toEqual([]);
  });

  test("the files that refer to the global fetch are the listed ones", () => {
    const users = sources
      .filter((source) => {
        if (source.path === HTTP_MODULE) return false;
        const skeleton = codeSkeleton(source.code);
        return (
          GLOBAL_FETCH.test(skeleton) ||
          GLOBAL_FETCH_THROUGH_OBJECT.test(skeleton)
        );
      })
      .map((source) => source.path)
      .sort();
    expect(users).toEqual(Object.keys(GLOBAL_FETCH_USERS).sort());
  });

  test("github_http.ts refers to the global fetch", () => {
    const http = sources.find((source) => source.path === HTTP_MODULE);
    expect(GLOBAL_FETCH.test(codeSkeleton(http?.code ?? ""))).toBe(true);
  });

  test("only the listed files import values from github_http.ts", () => {
    const importers = sources
      .filter((source) => HTTP_VALUE_IMPORT.test(source.code))
      .map((source) => source.path)
      .filter((path) => !HTTP_VALUE_IMPORTERS.includes(path));
    expect(importers).toEqual([]);
  });

  test("the import pattern sees a named re-export", () => {
    expect(
      HTTP_VALUE_IMPORT.test(
        'export { requestGitHub } from "./github_http.ts";',
      ),
    ).toBe(true);
  });

  test("the import pattern sees a star re-export", () => {
    expect(HTTP_VALUE_IMPORT.test('export * from "./github_http.ts";')).toBe(
      true,
    );
  });

  test("the import pattern sees a dynamic import", () => {
    expect(
      HTTP_VALUE_IMPORT.test('const m = await import("./github_http.ts");'),
    ).toBe(true);
  });

  test("the import pattern does not see a type-only re-export", () => {
    expect(
      HTTP_VALUE_IMPORT.test(
        'export type { HttpFetch } from "./github_http.ts";',
      ),
    ).toBe(false);
  });

  test("the fetch pattern sees fetch reached through Bun", () => {
    expect(GLOBAL_FETCH_THROUGH_OBJECT.test('await Bun.fetch("x");')).toBe(
      true,
    );
  });

  test("the fetch pattern sees a subscript of Bun", () => {
    expect(GLOBAL_FETCH_THROUGH_OBJECT.test("await Bun[name]('x');")).toBe(
      true,
    );
  });

  test("the import pattern does not see a type-only import", () => {
    expect(
      HTTP_VALUE_IMPORT.test(
        'import type { HttpFetch } from "./lib/github_http.ts";',
      ),
    ).toBe(false);
  });
});

describe("github_http.ts depends on nothing that runs a tool", () => {
  const source = readFileSync(join(FACTORY_DIR, HTTP_MODULE), "utf8");

  test("imports only github_errors.ts, log.ts, and types.ts", () => {
    const imports = new Bun.Transpiler({ loader: "ts" })
      .scanImports(source)
      .map((entry) => entry.path)
      .sort();
    expect(imports).toEqual(["./github_errors.ts", "./log.ts", "./types.ts"]);
  });

  test("does not use Buffer, Bun, or process", () => {
    expect(
      /\b(?:Buffer|Bun|process)\b/.test(codeSkeleton(codeOf(source))),
    ).toBe(false);
  });
});
