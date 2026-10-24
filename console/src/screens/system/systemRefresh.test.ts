import { describe, expect, test } from "bun:test";
import { refreshStatusOfSystem } from "./systemRefresh.ts";

type Fake = {
  dataUpdatedAt: number;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  refetched: () => number;
};

function fake(overrides: Partial<Fake> = {}): Fake {
  let count = 0;
  return {
    dataUpdatedAt: 1000,
    isFetching: false,
    isError: false,
    error: null,
    refetch: () => {
      count += 1;
      return Promise.resolve();
    },
    refetched: () => count,
    ...overrides,
  };
}

describe("refreshStatusOfSystem", () => {
  test("refreshes the holds with the other queries", () => {
    const queries = {
      status: fake(),
      deployments: fake(),
      summary: fake(),
      holds: fake(),
    };
    refreshStatusOfSystem(queries).onRefresh();
    expect(queries.holds.refetched()).toBe(1);
  });

  test("refreshes the other queries too", () => {
    const queries = {
      status: fake(),
      deployments: fake(),
      summary: fake(),
      holds: fake(),
    };
    refreshStatusOfSystem(queries).onRefresh();
    expect([
      queries.status.refetched(),
      queries.deployments.refetched(),
      queries.summary.refetched(),
    ]).toEqual([1, 1, 1]);
  });

  test("is fetching while only the holds are fetching", () => {
    expect(
      refreshStatusOfSystem({
        status: fake(),
        deployments: fake(),
        summary: fake(),
        holds: fake({ isFetching: true }),
      }).isFetching,
    ).toBe(true);
  });

  test("shows the oldest update, which may be the holds", () => {
    expect(
      refreshStatusOfSystem({
        status: fake({ dataUpdatedAt: 3000 }),
        deployments: fake({ dataUpdatedAt: 3000 }),
        summary: fake({ dataUpdatedAt: 3000 }),
        holds: fake({ dataUpdatedAt: 2000 }),
      }).updatedAt,
    ).toBe(2000);
  });

  test("does not claim an automatic refresh for the whole screen", () => {
    expect(
      refreshStatusOfSystem({
        status: fake(),
        deployments: fake(),
        summary: fake(),
        holds: fake(),
      }).autoRefreshMs,
    ).toBeNull();
  });
});
