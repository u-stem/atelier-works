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

  test("retries an http error at first", () => {
    expect(
      shouldRetryQuery(1, new ApiFailure({ kind: "http", status: 502 })),
    ).toBe(true);
  });

  test("gives up after two retries", () => {
    expect(shouldRetryQuery(2, new ApiFailure({ kind: "network" }))).toBe(
      false,
    );
  });

  test("retries an unclassified error at first", () => {
    expect(shouldRetryQuery(0, new Error("boom"))).toBe(true);
  });
});
