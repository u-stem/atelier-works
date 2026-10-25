import { describe, expect, test } from "bun:test";
import type { RunResult } from "./errors.ts";
import {
  type FetchLike,
  isScriptName,
  runScript,
  SCRIPT_PATHS,
  setConnectionReporter,
} from "./windmill.ts";

type Recorded = { input: string; init: RequestInit };

function recordingFetch(response: Response | Error): {
  fetchFn: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchFn: FetchLike = (input, init) => {
    calls.push({ input, init });
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  };
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SCRIPT_PATHS", () => {
  test("allows only the scripts the console calls", () => {
    expect(Object.keys(SCRIPT_PATHS)).toEqual([
      "console_query",
      "console_holds",
      "approval_decide",
      "retry_work_item",
      "audit_kickoff",
      "manual_intake_submit",
      "notice_resolve",
      "hold_release",
      "freeze_release",
    ]);
  });

  test("maps each name to its Windmill path", () => {
    expect(SCRIPT_PATHS).toEqual({
      console_query: "f/factory/steps/console_query",
      approval_decide: "f/factory/approval_decide",
      retry_work_item: "f/factory/retry_work_item",
      audit_kickoff: "f/factory/audit_kickoff",
      manual_intake_submit: "f/factory/manual_intake_submit",
      notice_resolve: "f/factory/notice_resolve",
      console_holds: "f/factory/console_holds",
      hold_release: "f/factory/hold_release",
      freeze_release: "f/factory/freeze_release",
    });
  });
});

describe("isScriptName", () => {
  test.each([
    "console_query",
    "approval_decide",
    "retry_work_item",
    "audit_kickoff",
    "notice_resolve",
    "console_holds",
    "hold_release",
    "freeze_release",
  ])("accepts the allowed name %s", (name) => {
    expect(isScriptName(name)).toBe(true);
  });

  test.each([
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "f/factory/steps/console_query",
    "f/factory/approval_decide",
    "cleanup_db",
    "hold_place",
    "placeHold",
    "",
  ])("rejects %s", (name) => {
    expect(isScriptName(name)).toBe(false);
  });
});

describe("runScript request", () => {
  test("posts to run_wait_result for the allowed path", async () => {
    const { fetchFn, calls } = recordingFetch(jsonResponse({}));
    await runScript("console_query", { view: "summary" }, { fetchFn });
    expect(calls[0]?.input).toBe(
      "/api/w/factory/jobs/run_wait_result/p/f/factory/steps/console_query",
    );
  });

  test("uses the POST method", async () => {
    const { fetchFn, calls } = recordingFetch(jsonResponse({}));
    await runScript("console_query", {}, { fetchFn });
    expect(calls[0]?.init.method).toBe("POST");
  });

  test("sends cookies only to the same origin", async () => {
    const { fetchFn, calls } = recordingFetch(jsonResponse({}));
    await runScript("console_query", {}, { fetchFn });
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });

  test("sends the arguments as a JSON body", async () => {
    const { fetchFn, calls } = recordingFetch(jsonResponse({}));
    await runScript(
      "console_query",
      { view: "summary", limit: 5 },
      { fetchFn },
    );
    expect(calls[0]?.init.body).toBe('{"view":"summary","limit":5}');
  });

  test("declares the JSON content type", async () => {
    const { fetchFn, calls } = recordingFetch(jsonResponse({}));
    await runScript("console_query", {}, { fetchFn });
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  test("does not let the browser cache the result", async () => {
    const { fetchFn, calls } = recordingFetch(jsonResponse({}));
    await runScript("console_query", {}, { fetchFn });
    expect(calls[0]?.init.cache).toBe("no-store");
  });

  test("passes the abort signal on", async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = recordingFetch(jsonResponse({}));
    await runScript(
      "console_query",
      {},
      { fetchFn, signal: controller.signal },
    );
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });
});

describe("runScript result", () => {
  test("returns the parsed result", async () => {
    const { fetchFn } = recordingFetch(jsonResponse({ a: 1 }));
    expect(await runScript("console_query", {}, { fetchFn })).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  test("classifies a 401 as unauthorized", async () => {
    const { fetchFn } = recordingFetch(
      new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
    expect(await runScript("console_query", {}, { fetchFn })).toEqual({
      ok: false,
      error: { kind: "unauthorized" },
    });
  });

  test("classifies a failed job with its message", async () => {
    const { fetchFn } = recordingFetch(
      jsonResponse({ error: { message: "boom" } }, 500),
    );
    expect(await runScript("console_query", {}, { fetchFn })).toEqual({
      ok: false,
      error: { kind: "job_failed", message: "boom" },
    });
  });

  test("classifies a rejected fetch as a network error", async () => {
    const { fetchFn } = recordingFetch(new TypeError("Failed to fetch"));
    expect(await runScript("console_query", {}, { fetchFn })).toEqual({
      ok: false,
      error: { kind: "network" },
    });
  });

  test("rethrows when the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchFn } = recordingFetch(new Error("aborted"));
    await expect(
      runScript("console_query", {}, { fetchFn, signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });
});

describe("runScript connection report", () => {
  async function reported(
    response: Response | Error,
    options: { signal?: AbortSignal } = {},
  ): Promise<RunResult[]> {
    const results: RunResult[] = [];
    setConnectionReporter((result) => {
      results.push(result);
    });
    try {
      await runScript(
        "console_query",
        {},
        {
          fetchFn: recordingFetch(response).fetchFn,
          ...options,
        },
      ).catch(() => undefined);
    } finally {
      setConnectionReporter(null);
    }
    return results;
  }

  test("reports a success", async () => {
    expect((await reported(jsonResponse([]))).map((r) => r.ok)).toEqual([true]);
  });

  test("reports a network failure as a failure of kind network", async () => {
    const results = await reported(new TypeError("Failed to fetch"));
    expect(results.map((r) => (r.ok ? "ok" : r.error.kind))).toEqual([
      "network",
    ]);
  });

  test("reports a 502 from the proxy as an http failure", async () => {
    const results = await reported(
      new Response("Bad Gateway", { status: 502 }),
    );
    expect(results.map((r) => (r.ok ? "ok" : r.error.kind))).toEqual(["http"]);
  });

  test("reports a 401 so the connection state can tell Windmill answered", async () => {
    const results = await reported(new Response("no", { status: 401 }));
    expect(results.map((r) => (r.ok ? "ok" : r.error.kind))).toEqual([
      "unauthorized",
    ]);
  });

  test("does not report an aborted call", async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await reported(new DOMException("aborted", "AbortError"), {
      signal: controller.signal,
    });
    expect(results).toEqual([]);
  });

  test("reports to the reporter set last", async () => {
    const first: RunResult[] = [];
    setConnectionReporter((result) => {
      first.push(result);
    });
    const second: RunResult[] = [];
    setConnectionReporter((result) => {
      second.push(result);
    });
    await runScript(
      "console_query",
      {},
      {
        fetchFn: recordingFetch(jsonResponse([])).fetchFn,
      },
    );
    setConnectionReporter(null);
    expect([first.length, second.length]).toEqual([0, 1]);
  });

  test("runs without a reporter", async () => {
    setConnectionReporter(null);
    const result = await runScript(
      "console_query",
      {},
      {
        fetchFn: recordingFetch(jsonResponse([])).fetchFn,
      },
    );
    expect(result.ok).toBe(true);
  });
});
