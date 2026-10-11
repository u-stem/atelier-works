import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../api/errors.ts";
import { refreshStatusOf, refreshStatusOfAll } from "./refreshStatus.ts";

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

describe("refreshStatusOf with an interval", () => {
  test("has no auto-refresh interval by default", () => {
    expect(refreshStatusOf(fakeQuery()).autoRefreshMs).toBeNull();
  });

  test("carries the auto-refresh interval it is given", () => {
    expect(
      refreshStatusOf(fakeQuery(), { autoRefreshMs: 120_000 }).autoRefreshMs,
    ).toBe(120_000);
  });
});

describe("refreshStatusOfAll", () => {
  test("uses the oldest update time among fetched queries", () => {
    const status = refreshStatusOfAll([
      fakeQuery({ dataUpdatedAt: 3000 }),
      fakeQuery({ dataUpdatedAt: 1000 }),
    ]);
    expect(status.updatedAt).toBe(1000);
  });

  test("ignores queries that have not fetched anything", () => {
    const status = refreshStatusOfAll([
      fakeQuery({ dataUpdatedAt: 0 }),
      fakeQuery({ dataUpdatedAt: 2000 }),
    ]);
    expect(status.updatedAt).toBe(2000);
  });

  test("has no update time when nothing has been fetched", () => {
    const status = refreshStatusOfAll([fakeQuery({ dataUpdatedAt: 0 })]);
    expect(status.updatedAt).toBe(0);
  });

  test("is fetching while any query is fetching", () => {
    const status = refreshStatusOfAll([
      fakeQuery({ isFetching: false }),
      fakeQuery({ isFetching: true }),
    ]);
    expect(status.isFetching).toBe(true);
  });

  test("is not fetching when every query is idle", () => {
    const status = refreshStatusOfAll([
      fakeQuery({ isFetching: false }),
      fakeQuery({ isFetching: false }),
    ]);
    expect(status.isFetching).toBe(false);
  });

  test("reports an error when any query failed", () => {
    const status = refreshStatusOfAll([
      fakeQuery(),
      fakeQuery({ isError: true, error: new ApiFailure({ kind: "network" }) }),
    ]);
    expect(status.isError).toBe(true);
  });

  test("does not report a 401 that the banner covers", () => {
    const status = refreshStatusOfAll([
      fakeQuery({
        isError: true,
        error: new ApiFailure({ kind: "unauthorized" }),
      }),
    ]);
    expect(status.isError).toBe(false);
  });

  test("refetches every query when refreshed", () => {
    let calls = 0;
    const counting = fakeQuery({
      refetch: () => {
        calls += 1;
        return Promise.resolve(undefined);
      },
    });
    refreshStatusOfAll([counting, counting, counting]).onRefresh();
    expect(calls).toBe(3);
  });

  test("has no auto-refresh interval unless one is given", () => {
    expect(refreshStatusOfAll([fakeQuery()]).autoRefreshMs).toBeNull();
  });

  test("carries the auto-refresh interval it is given", () => {
    expect(
      refreshStatusOfAll([fakeQuery()], { autoRefreshMs: 60_000 })
        .autoRefreshMs,
    ).toBe(60_000);
  });
});
