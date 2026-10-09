import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../api/errors.ts";
import { refreshStatusOf } from "./refreshStatus.ts";

type FakeQuery = {
  dataUpdatedAt: number;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

function fakeQuery(overrides: Partial<FakeQuery> = {}): FakeQuery {
  return {
    dataUpdatedAt: 1234,
    isFetching: true,
    isError: false,
    error: null,
    refetch: () => Promise.resolve(undefined),
    ...overrides,
  };
}

describe("refreshStatusOf", () => {
  test("copies the update time", () => {
    expect(refreshStatusOf(fakeQuery()).updatedAt).toBe(1234);
  });

  test("copies the fetching flag", () => {
    expect(refreshStatusOf(fakeQuery()).isFetching).toBe(true);
  });

  test("copies the error flag", () => {
    expect(refreshStatusOf(fakeQuery()).isError).toBe(false);
  });

  test("refetches when refreshed", () => {
    let calls = 0;
    const status = refreshStatusOf(
      fakeQuery({
        refetch: () => {
          calls += 1;
          return Promise.resolve(undefined);
        },
      }),
    );
    status.onRefresh();
    expect(calls).toBe(1);
  });
});

describe("refreshStatusOf with errors", () => {
  test("reports a failure that the banner does not cover", () => {
    expect(
      refreshStatusOf(
        fakeQuery({
          isError: true,
          error: new ApiFailure({ kind: "network" }),
        }),
      ).isError,
    ).toBe(true);
  });

  test("does not report a 401 that the banner covers", () => {
    expect(
      refreshStatusOf(
        fakeQuery({
          isError: true,
          error: new ApiFailure({ kind: "unauthorized" }),
        }),
      ).isError,
    ).toBe(false);
  });

  test("reports an error of an unknown kind", () => {
    expect(
      refreshStatusOf(fakeQuery({ isError: true, error: new Error("x") }))
        .isError,
    ).toBe(true);
  });
});
