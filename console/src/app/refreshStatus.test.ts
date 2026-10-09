import { describe, expect, test } from "bun:test";
import { refreshStatusOf } from "./refreshStatus.ts";

function fakeQuery(overrides: { refetch?: () => Promise<unknown> } = {}) {
  return {
    dataUpdatedAt: 1234,
    isFetching: true,
    isError: false,
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
