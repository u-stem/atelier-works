import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import { shouldRetryQuery } from "./queryPolicy.ts";

describe("shouldRetryQuery", () => {
  test("does not retry after a 401", () => {
    expect(shouldRetryQuery(0, new ApiFailure({ kind: "unauthorized" }))).toBe(
      false,
    );
  });

  test("does not retry after a 403", () => {
    expect(shouldRetryQuery(0, new ApiFailure({ kind: "forbidden" }))).toBe(
      false,
    );
  });

  test("does not retry a response that failed validation", () => {
    expect(
      shouldRetryQuery(0, new ApiFailure({ kind: "invalid_response" })),
    ).toBe(false);
  });

  test("retries a network error at first", () => {
    expect(shouldRetryQuery(0, new ApiFailure({ kind: "network" }))).toBe(true);
  });

  test("retries a 5xx http error", () => {
    expect(
      shouldRetryQuery(
        1,
        new ApiFailure({ kind: "http", status: 502, detail: "" }),
      ),
    ).toBe(true);
  });

  test("does not retry a 4xx http error", () => {
    expect(
      shouldRetryQuery(
        0,
        new ApiFailure({ kind: "http", status: 400, detail: "bad" }),
      ),
    ).toBe(false);
  });

  test("does not retry a failed job", () => {
    expect(
      shouldRetryQuery(0, new ApiFailure({ kind: "job_failed", message: "x" })),
    ).toBe(false);
  });

  test("retries a timeout", () => {
    expect(
      shouldRetryQuery(0, new ApiFailure({ kind: "timeout_or_unknown" })),
    ).toBe(true);
  });

  test("gives up after two retries", () => {
    expect(shouldRetryQuery(2, new ApiFailure({ kind: "network" }))).toBe(
      false,
    );
  });

  test("does not retry an unclassified error", () => {
    expect(shouldRetryQuery(0, new Error("boom"))).toBe(false);
  });
});
