import { describe, expect, test } from "bun:test";
import type { InvalidateQueryFilters } from "@tanstack/react-query";
import { ApiFailure, type RunResult } from "../api/errors.ts";
import { createAuthStore } from "./authState.ts";
import { createConnectionStore } from "./connectionState.ts";
import { createQueryClient, watchConnectionRecovery } from "./queryClient.ts";

describe("createQueryClient", () => {
  test("shows the banner when a query gets a 401", async () => {
    const store = createAuthStore();
    const client = createQueryClient(store);
    await client
      .fetchQuery({
        queryKey: ["x"],
        queryFn: () => Promise.reject(new ApiFailure({ kind: "unauthorized" })),
      })
      .catch(() => undefined);
    expect(store.getSnapshot().unauthorized).toBe(true);
  });

  test("shows the banner when a mutation gets a 401", async () => {
    const store = createAuthStore();
    const client = createQueryClient(store);
    await client
      .getMutationCache()
      .build(client, {
        mutationFn: () =>
          Promise.reject(new ApiFailure({ kind: "unauthorized" })),
      })
      .execute(undefined)
      .catch(() => undefined);
    expect(store.getSnapshot().unauthorized).toBe(true);
  });

  test("does not show the banner for another mutation failure", async () => {
    const store = createAuthStore();
    const client = createQueryClient(store);
    await client
      .getMutationCache()
      .build(client, {
        mutationFn: () => Promise.reject(new ApiFailure({ kind: "network" })),
      })
      .execute(undefined)
      .catch(() => undefined);
    expect(store.getSnapshot().unauthorized).toBe(false);
  });

  test("clears the banner after a query succeeds", async () => {
    const store = createAuthStore();
    store.reportError(new ApiFailure({ kind: "unauthorized" }));
    const client = createQueryClient(store);
    await client.fetchQuery({ queryKey: ["y"], queryFn: () => 1 });
    expect(store.getSnapshot().unauthorized).toBe(false);
  });

  test("never retries a mutation", () => {
    const client = createQueryClient(createAuthStore());
    expect(client.getDefaultOptions().mutations?.retry).toBe(0);
  });

  test("keeps the default cache lifetime so a revisit shows held data at once", () => {
    const client = createQueryClient(createAuthStore());
    expect(client.getDefaultOptions().queries?.gcTime).toBeUndefined();
  });

  test("runs queries whatever the browser says about the connection", () => {
    const client = createQueryClient(createAuthStore());
    expect(client.getDefaultOptions().queries?.networkMode).toBe("always");
  });
});

describe("watchConnectionRecovery", () => {
  const NETWORK: RunResult = { ok: false, error: { kind: "network" } };
  const OK: RunResult = { ok: true, value: [] };

  async function setup() {
    const store = createConnectionStore();
    const real = createQueryClient(createAuthStore());
    await real
      .fetchQuery({
        queryKey: ["failed"],
        queryFn: () =>
          Promise.reject(
            new ApiFailure({ kind: "http", status: 500, detail: "" }),
          ),
        retry: false,
      })
      .catch(() => undefined);
    await real.fetchQuery({ queryKey: ["fine"], queryFn: () => 1 });
    const filters: (InvalidateQueryFilters | undefined)[] = [];
    const stop = watchConnectionRecovery(store, {
      invalidateQueries: (given) => {
        filters.push(given);
        return Promise.resolve();
      },
    });
    const selects = (key: string): boolean => {
      const query = real.getQueryCache().find({ queryKey: [key] });
      const predicate = filters[0]?.predicate;
      return query !== undefined && predicate?.(query) === true;
    };
    return { store, filters, stop, selects };
  }

  test("reads the queries again when Windmill becomes reachable", async () => {
    const { store, filters } = await setup();
    store.report(NETWORK);
    store.report(OK);
    expect(filters).toHaveLength(1);
  });

  test("selects the queries that failed", async () => {
    const { store, selects } = await setup();
    store.report(NETWORK);
    store.report(OK);
    expect(selects("failed")).toBe(true);
  });

  test("leaves the queries that succeeded alone", async () => {
    const { store, selects } = await setup();
    store.report(NETWORK);
    store.report(OK);
    expect(selects("fine")).toBe(false);
  });

  test("reads nothing again while Windmill stays unreachable", async () => {
    const { store, filters } = await setup();
    store.report(NETWORK);
    expect(filters).toHaveLength(0);
  });

  test("reads nothing again when Windmill was never unreachable", async () => {
    const { store, filters } = await setup();
    store.report(OK);
    expect(filters).toHaveLength(0);
  });

  test("reads once for a run of successes after the recovery", async () => {
    const { store, filters } = await setup();
    store.report(NETWORK);
    store.report(OK);
    store.report(OK);
    expect(filters).toHaveLength(1);
  });

  test("stops watching after the cleanup", async () => {
    const { store, filters, stop } = await setup();
    stop();
    store.report(NETWORK);
    store.report(OK);
    expect(filters).toHaveLength(0);
  });
});
