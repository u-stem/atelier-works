import { describe, expect, test } from "bun:test";
import { refreshFailureOf } from "./refreshFailure.ts";

const retry = (): void => undefined;

describe("refreshFailureOf", () => {
  test("is null while the refresh has not failed", () => {
    expect(
      refreshFailureOf(
        { isError: false, error: null, isFetching: false },
        retry,
      ),
    ).toBeNull();
  });

  test("carries the error after a failed refresh", () => {
    const error = new Error("x");
    expect(
      refreshFailureOf({ isError: true, error, isFetching: false }, retry)
        ?.error,
    ).toBe(error);
  });

  test("carries the fetching flag after a failed refresh", () => {
    expect(
      refreshFailureOf(
        { isError: true, error: new Error("x"), isFetching: true },
        retry,
      )?.isFetching,
    ).toBe(true);
  });

  test("carries the retry after a failed refresh", () => {
    expect(
      refreshFailureOf(
        { isError: true, error: new Error("x"), isFetching: false },
        retry,
      )?.onRetry,
    ).toBe(retry);
  });
});
