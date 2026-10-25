import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../api/errors.ts";
import { createAuthStore } from "./authState.ts";
import { createConnectionStore } from "./connectionState.ts";
import { createQueryClient } from "./queryClient.ts";

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

describe("createQueryClient connection state", () => {
  function setup() {
    const connection = createConnectionStore();
    const client = createQueryClient(createAuthStore(), connection);
    return { connection, client };
  }

  test("marks Windmill unreachable when a query fails with a network error", async () => {
    const { connection, client } = setup();
    await client
      .fetchQuery({
        queryKey: ["net"],
        queryFn: () => Promise.reject(new ApiFailure({ kind: "network" })),
      })
      .catch(() => undefined);
    expect(connection.getSnapshot().unreachable).toBe(true);
  });

  test("clears the mark when the next query succeeds", async () => {
    const { connection, client } = setup();
    await client
      .fetchQuery({
        queryKey: ["net"],
        queryFn: () => Promise.reject(new ApiFailure({ kind: "network" })),
      })
      .catch(() => undefined);
    await client.fetchQuery({ queryKey: ["ok"], queryFn: () => 1 });
    expect(connection.getSnapshot().unreachable).toBe(false);
  });

  test("does not mark Windmill unreachable for a failure Windmill answered", async () => {
    const { connection, client } = setup();
    await client
      .fetchQuery({
        queryKey: ["http"],
        queryFn: () =>
          Promise.reject(
            new ApiFailure({ kind: "http", status: 500, detail: "" }),
          ),
      })
      .catch(() => undefined);
    expect(connection.getSnapshot().unreachable).toBe(false);
  });

  test("does not mark Windmill unreachable for a mutation failure", async () => {
    const { connection, client } = setup();
    await client
      .getMutationCache()
      .build(client, {
        mutationFn: () => Promise.reject(new ApiFailure({ kind: "network" })),
      })
      .execute(undefined)
      .catch(() => undefined);
    expect(connection.getSnapshot().unreachable).toBe(false);
  });
});
