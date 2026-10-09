import { describe, expect, test } from "bun:test";
import { type FetchLike, runScript, SCRIPT_PATHS } from "./windmill.ts";

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
    expect(Object.keys(SCRIPT_PATHS).sort()).toEqual([
      "approval_decide",
      "console_query",
    ]);
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

  test("uses the approval_decide path", async () => {
    const { fetchFn, calls } = recordingFetch(jsonResponse({}));
    await runScript("approval_decide", {}, { fetchFn });
    expect(calls[0]?.input).toBe(
      "/api/w/factory/jobs/run_wait_result/p/f/factory/approval_decide",
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
