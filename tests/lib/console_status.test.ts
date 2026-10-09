import { describe, expect, test } from "bun:test";
import {
  CONSOLE_STATUS_PATH,
  classifyFetcherStatus,
  type FetcherStatus,
  loadFetcherStatus,
  nextActionFor,
  nextActionForAssessment,
  parseFetcherStatus,
} from "../../f/factory/lib/console_status.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");

function status(overrides: Partial<FetcherStatus> = {}): FetcherStatus {
  return {
    state: "ok",
    sha: "0123456789abcdef0123456789abcdef01234567",
    checked_at: "2026-10-09T11:58:00.000Z",
    error: null,
    ...overrides,
  };
}

describe("CONSOLE_STATUS_PATH", () => {
  test("is the file console_fetcher writes in the console volume", () => {
    expect(CONSOLE_STATUS_PATH).toBe("/srv/console/status.json");
  });
});

describe("parseFetcherStatus", () => {
  test("parses a well-formed status", () => {
    expect(parseFetcherStatus(status())).toEqual(status());
  });

  test("keeps an unknown error code as a string", () => {
    expect(
      parseFetcherStatus(status({ state: "failed", error: "future_code" })),
    ).toMatchObject({ error: "future_code" });
  });

  test("accepts a null sha", () => {
    expect(parseFetcherStatus(status({ sha: null }))).toMatchObject({
      sha: null,
    });
  });

  test("rejects null", () => {
    expect(parseFetcherStatus(null)).toBeNull();
  });

  test("rejects an array", () => {
    expect(parseFetcherStatus([])).toBeNull();
  });

  test("rejects an unknown state", () => {
    expect(parseFetcherStatus({ ...status(), state: "broken" })).toBeNull();
  });

  test("rejects a missing checked_at", () => {
    expect(
      parseFetcherStatus({ state: "ok", sha: null, error: null }),
    ).toBeNull();
  });

  test("rejects a checked_at that is not a date", () => {
    expect(
      parseFetcherStatus({ ...status(), checked_at: "yesterday" }),
    ).toBeNull();
  });

  test("rejects a numeric checked_at", () => {
    expect(parseFetcherStatus({ ...status(), checked_at: 1 })).toBeNull();
  });

  test("rejects a non-string sha", () => {
    expect(parseFetcherStatus({ ...status(), sha: 5 })).toBeNull();
  });

  test("rejects a non-string error", () => {
    expect(parseFetcherStatus({ ...status(), error: 5 })).toBeNull();
  });

  test("rejects a missing error field", () => {
    expect(
      parseFetcherStatus({
        state: "ok",
        sha: null,
        checked_at: "2026-10-09T11:58:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("classifyFetcherStatus", () => {
  test("treats a fresh ok status as ok", () => {
    expect(classifyFetcherStatus(status(), NOW)).toEqual({ verdict: "ok" });
  });

  test("treats a fresh pinned status as ok", () => {
    expect(classifyFetcherStatus(status({ state: "pinned" }), NOW)).toEqual({
      verdict: "ok",
    });
  });

  test("reports a fresh failed status with its code", () => {
    expect(
      classifyFetcherStatus(
        status({ state: "failed", error: "auth_failed" }),
        NOW,
      ),
    ).toEqual({ verdict: "failed", code: "auth_failed" });
  });

  test("reports a failed status without a code as unknown", () => {
    expect(
      classifyFetcherStatus(status({ state: "failed", error: null }), NOW),
    ).toEqual({ verdict: "failed", code: "unknown" });
  });

  test("does not report exactly thirty minutes as stale", () => {
    expect(
      classifyFetcherStatus(
        status({ checked_at: "2026-10-09T11:30:00.000Z" }),
        NOW,
      ),
    ).toEqual({ verdict: "ok" });
  });

  test("reports a status older than thirty minutes as stale", () => {
    expect(
      classifyFetcherStatus(
        status({ checked_at: "2026-10-09T11:29:00.000Z" }),
        NOW,
      ),
    ).toEqual({ verdict: "stale", minutes_since_check: 31 });
  });

  test("reports stale before failed when both hold", () => {
    expect(
      classifyFetcherStatus(
        status({
          state: "failed",
          error: "auth_failed",
          checked_at: "2026-10-09T08:00:00.000Z",
        }),
        NOW,
      ),
    ).toEqual({ verdict: "stale", minutes_since_check: 240 });
  });

  test("reports a stale pinned status as stale", () => {
    expect(
      classifyFetcherStatus(
        status({ state: "pinned", checked_at: "2026-10-09T08:00:00.000Z" }),
        NOW,
      ),
    ).toEqual({ verdict: "stale", minutes_since_check: 240 });
  });

  test("treats a checked_at in the future as fresh", () => {
    expect(
      classifyFetcherStatus(
        status({ checked_at: "2026-10-09T12:05:00.000Z" }),
        NOW,
      ),
    ).toEqual({ verdict: "ok" });
  });
});

describe("nextActionFor", () => {
  test("gives the token advice for auth_failed", () => {
    expect(nextActionFor("auth_failed")).toContain("トークン");
  });

  test("gives a generic action for an unknown code", () => {
    expect(nextActionFor("future_code")).toContain("ログ");
  });

  test("says nothing needs doing for rate_limited", () => {
    expect(nextActionFor("rate_limited")).toContain("何もしなくてよい");
  });

  test("does not read a prototype property as a code", () => {
    expect(nextActionFor("constructor")).toContain("ログ");
  });
});

describe("loadFetcherStatus", () => {
  test("reads the status file at CONSOLE_STATUS_PATH", async () => {
    const paths: string[] = [];
    await loadFetcherStatus(async (path) => {
      paths.push(path);
      return JSON.stringify(status());
    });
    expect(paths).toEqual(["/srv/console/status.json"]);
  });

  test("returns the parsed status", async () => {
    const result = await loadFetcherStatus(async () =>
      JSON.stringify(status()),
    );
    expect(result).toEqual({ kind: "status", status: status() });
  });

  test("returns missing when the file cannot be read", async () => {
    const result = await loadFetcherStatus(async () => {
      throw new Error("ENOENT");
    });
    expect(result).toEqual({ kind: "missing" });
  });

  test("returns invalid for text that is not JSON", async () => {
    const result = await loadFetcherStatus(async () => "not json");
    expect(result).toEqual({ kind: "invalid" });
  });

  test("returns invalid for JSON of the wrong shape", async () => {
    const result = await loadFetcherStatus(async () => '{"state":"ok"}');
    expect(result).toEqual({ kind: "invalid" });
  });
});

describe("nextActionForAssessment", () => {
  test("returns null for an ok assessment", () => {
    expect(nextActionForAssessment({ verdict: "ok" })).toBeNull();
  });

  test("returns the action of the failure code", () => {
    expect(
      nextActionForAssessment({ verdict: "failed", code: "auth_failed" }),
    ).toBe(nextActionFor("auth_failed"));
  });

  test("tells the operator to check the container when stale", () => {
    expect(
      nextActionForAssessment({ verdict: "stale", minutes_since_check: 40 }),
    ).toContain("動いているか");
  });
});
