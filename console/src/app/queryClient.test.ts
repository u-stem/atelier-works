import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../api/errors.ts";
import { createAuthStore } from "./authState.ts";
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
});
