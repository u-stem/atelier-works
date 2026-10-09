import { describe, expect, test } from "bun:test";
import {
  ApiFailure,
  classifyRunResponse,
  describeApiError,
  isBannerError,
} from "./errors.ts";

describe("classifyRunResponse on success", () => {
  test("returns the parsed JSON body", () => {
    expect(classifyRunResponse(200, '{"a":1}')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  test("parses an array body", () => {
    expect(classifyRunResponse(200, "[1,2]")).toEqual({
      ok: true,
      value: [1, 2],
    });
  });

  test("accepts a null result", () => {
    expect(classifyRunResponse(200, "null")).toEqual({
      ok: true,
      value: null,
    });
  });

  test("reports invalid_response for a body that is not JSON", () => {
    expect(classifyRunResponse(200, "<html></html>")).toEqual({
      ok: false,
      error: { kind: "invalid_response" },
    });
  });

  test("reports invalid_response for an empty body", () => {
    expect(classifyRunResponse(200, "")).toEqual({
      ok: false,
      error: { kind: "invalid_response" },
    });
  });

  test("treats any 2xx status as success", () => {
    expect(classifyRunResponse(201, "1")).toEqual({
      ok: true,
      value: 1,
    });
  });
});

describe("classifyRunResponse on failure statuses", () => {
  test("reports unauthorized for 401 with a plain text body", () => {
    expect(classifyRunResponse(401, "Unauthorized")).toEqual({
      ok: false,
      error: { kind: "unauthorized" },
    });
  });

  test("reports unauthorized for 401 with a JSON body", () => {
    expect(classifyRunResponse(401, '{"error":"no"}')).toEqual({
      ok: false,
      error: { kind: "unauthorized" },
    });
  });

  test("reports forbidden for 403", () => {
    expect(classifyRunResponse(403, "Forbidden")).toEqual({
      ok: false,
      error: { kind: "forbidden" },
    });
  });

  test("reports timeout_or_unknown for 408", () => {
    expect(classifyRunResponse(408, "")).toEqual({
      ok: false,
      error: { kind: "timeout_or_unknown" },
    });
  });

  test("reports timeout_or_unknown for 504", () => {
    expect(classifyRunResponse(504, "Gateway Timeout")).toEqual({
      ok: false,
      error: { kind: "timeout_or_unknown" },
    });
  });

  test("reports http with the status for 404", () => {
    expect(classifyRunResponse(404, "Not found")).toEqual({
      ok: false,
      error: { kind: "http", status: 404, detail: "Not found" },
    });
  });

  test("reports http with the status for 502", () => {
    expect(classifyRunResponse(502, "Bad Gateway")).toEqual({
      ok: false,
      error: { kind: "http", status: 502, detail: "" },
    });
  });
});

describe("classifyRunResponse on a failed job (500)", () => {
  test("reads error.message from a JSON body", () => {
    expect(
      classifyRunResponse(500, '{"error":{"name":"Error","message":"boom"}}'),
    ).toEqual({ ok: false, error: { kind: "job_failed", message: "boom" } });
  });

  test("reads a top-level message from a JSON body", () => {
    expect(classifyRunResponse(500, '{"message":"bad"}')).toEqual({
      ok: false,
      error: { kind: "job_failed", message: "bad" },
    });
  });

  test("reads a string error from a JSON body", () => {
    expect(classifyRunResponse(500, '{"error":"plain"}')).toEqual({
      ok: false,
      error: { kind: "job_failed", message: "plain" },
    });
  });

  test("reads a JSON string body", () => {
    expect(classifyRunResponse(500, '"oops"')).toEqual({
      ok: false,
      error: { kind: "job_failed", message: "oops" },
    });
  });

  test("uses a text body as the message", () => {
    expect(classifyRunResponse(500, "  it broke\n")).toEqual({
      ok: false,
      error: { kind: "job_failed", message: "it broke" },
    });
  });

  test("uses a body that is not JSON as the message", () => {
    expect(classifyRunResponse(500, "not json at all")).toEqual({
      ok: false,
      error: { kind: "job_failed", message: "not json at all" },
    });
  });

  test("returns an empty message for an empty body", () => {
    expect(classifyRunResponse(500, "")).toEqual({
      ok: false,
      error: { kind: "job_failed", message: "" },
    });
  });

  test("returns an empty message for JSON of an unexpected shape", () => {
    expect(classifyRunResponse(500, '{"x":1}')).toEqual({
      ok: false,
      error: { kind: "job_failed", message: "" },
    });
  });

  test("truncates a long message", () => {
    const result = classifyRunResponse(500, "x".repeat(2000));
    const message =
      !result.ok && result.error.kind === "job_failed"
        ? result.error.message
        : "";
    expect(message.length).toBe(500);
  });
});

describe("describeApiError", () => {
  test("asks the operator to log in again for unauthorized", () => {
    expect(describeApiError({ kind: "unauthorized" })).toContain("ログイン");
  });

  test("says the result is unknown for a timeout", () => {
    expect(describeApiError({ kind: "timeout_or_unknown" })).toContain(
      "結果が分かりません",
    );
  });

  test("includes the server message for a failed job", () => {
    expect(describeApiError({ kind: "job_failed", message: "boom" })).toContain(
      "boom",
    );
  });

  test("does not expose the status code as the only text for http", () => {
    expect(
      describeApiError({ kind: "http", status: 502, detail: "" }),
    ).toContain("502");
  });

  test("adds the server detail for http", () => {
    expect(
      describeApiError({ kind: "http", status: 400, detail: "Bad request: x" }),
    ).toContain("Bad request: x");
  });

  test("keeps a failed job message on reads", () => {
    expect(
      describeApiError({ kind: "job_failed", message: "boom" }, "read"),
    ).not.toContain("結果が分かりません");
  });

  test("says the result is unknown for a failed job on writes", () => {
    expect(
      describeApiError({ kind: "job_failed", message: "boom" }, "write"),
    ).toContain("結果が分かりません。一覧を読み直して確かめてください");
  });

  test("keeps the job message on writes", () => {
    expect(
      describeApiError({ kind: "job_failed", message: "boom" }, "write"),
    ).toContain("boom");
  });

  test("says the result is unknown for a timeout on writes", () => {
    expect(describeApiError({ kind: "timeout_or_unknown" }, "write")).toContain(
      "結果が分かりません。一覧を読み直して確かめてください",
    );
  });

  test("tells a read that a timeout left the list stale", () => {
    expect(describeApiError({ kind: "timeout_or_unknown" }, "read")).toContain(
      "一覧を読み直して",
    );
  });
});

describe("classifyRunResponse on a failed job result shape", () => {
  const BODY = JSON.stringify({
    error: {
      name: "Error",
      message: "db down",
      stack: "Error: db down\n    at /internal/path/x.ts:10:3",
    },
  });

  test("keeps the message", () => {
    const result = classifyRunResponse(500, BODY);
    expect(
      !result.ok && result.error.kind === "job_failed" && result.error.message,
    ).toBe("db down");
  });

  test("never carries the stack", () => {
    expect(JSON.stringify(classifyRunResponse(500, BODY))).not.toContain(
      "/internal/path",
    );
  });

  test("shows only the message on screen", () => {
    const result = classifyRunResponse(500, BODY);
    expect(!result.ok && describeApiError(result.error, "read")).not.toContain(
      "internal",
    );
  });
});

describe("classifyRunResponse on a timeout message", () => {
  test.each([
    ["timeout after 30s", '{"error":{"message":"timeout after 30 seconds"}}'],
    ["timed out", '{"error":{"message":"Request timed out"}}'],
    ["a text body", "Timeout after 20s waiting for the job"],
  ])("reports timeout_or_unknown for a 500 with %s", (_name, body) => {
    expect(classifyRunResponse(500, body)).toEqual({
      ok: false,
      error: { kind: "timeout_or_unknown" },
    });
  });

  test("keeps job_failed for a message that only mentions timeout", () => {
    const result = classifyRunResponse(
      500,
      '{"error":{"message":"timeout option missing"}}',
    );
    expect(!result.ok && result.error.kind).toBe("job_failed");
  });

  test("keeps job_failed for an unrelated message", () => {
    const result = classifyRunResponse(500, '{"error":{"message":"boom"}}');
    expect(!result.ok && result.error.kind).toBe("job_failed");
  });

  test("keeps http for a timeout phrase outside a 500", () => {
    const result = classifyRunResponse(400, "timed out");
    expect(!result.ok && result.error.kind).toBe("http");
  });
});

describe("classifyRunResponse on a rejected tag (400)", () => {
  const BODY =
    '"Bad request: Tag console is not included in the allowed CUSTOM_TAGS, which only super admins can go beyond: x"';

  test("reports http 400", () => {
    const result = classifyRunResponse(400, BODY);
    expect(
      !result.ok && result.error.kind === "http" && result.error.status,
    ).toBe(400);
  });

  test("carries the JSON string as the detail", () => {
    const result = classifyRunResponse(400, BODY);
    expect(
      !result.ok && result.error.kind === "http" && result.error.detail,
    ).toBe(
      "Bad request: Tag console is not included in the allowed CUSTOM_TAGS, which only super admins can go beyond: x",
    );
  });

  test("truncates a long detail", () => {
    const result = classifyRunResponse(400, "y".repeat(2000));
    const detail =
      !result.ok && result.error.kind === "http" ? result.error.detail : "";
    expect(detail.length).toBe(200);
  });
});

describe("isBannerError", () => {
  test("is true for unauthorized", () => {
    expect(isBannerError({ kind: "unauthorized" })).toBe(true);
  });

  test("is false for forbidden", () => {
    expect(isBannerError({ kind: "forbidden" })).toBe(false);
  });
});

describe("ApiFailure", () => {
  test("carries the classified error", () => {
    expect(new ApiFailure({ kind: "network" }).apiError).toEqual({
      kind: "network",
    });
  });

  test("is an Error", () => {
    expect(new ApiFailure({ kind: "network" })).toBeInstanceOf(Error);
  });
});
