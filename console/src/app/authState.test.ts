import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../api/errors.ts";
import {
  createAuthStore,
  INITIAL_AUTH_STATE,
  isUnauthorizedError,
  reduceAuth,
} from "./authState.ts";

describe("reduceAuth", () => {
  test("starts signed in", () => {
    expect(INITIAL_AUTH_STATE.unauthorized).toBe(false);
  });

  test("marks unauthorized on an unauthorized error", () => {
    expect(
      reduceAuth(INITIAL_AUTH_STATE, {
        type: "failed",
        error: { kind: "unauthorized" },
      }).unauthorized,
    ).toBe(true);
  });

  test("ignores other errors", () => {
    expect(
      reduceAuth(INITIAL_AUTH_STATE, {
        type: "failed",
        error: { kind: "network" },
      }).unauthorized,
    ).toBe(false);
  });

  test("keeps the banner when another error follows", () => {
    expect(
      reduceAuth(
        { unauthorized: true },
        { type: "failed", error: { kind: "network" } },
      ).unauthorized,
    ).toBe(true);
  });

  test("clears the banner after a success", () => {
    expect(reduceAuth({ unauthorized: true }, { type: "succeeded" })).toEqual({
      unauthorized: false,
    });
  });

  test("returns the same object when nothing changes", () => {
    expect(reduceAuth(INITIAL_AUTH_STATE, { type: "succeeded" })).toBe(
      INITIAL_AUTH_STATE,
    );
  });
});

describe("isUnauthorizedError", () => {
  test("recognises an unauthorized ApiFailure", () => {
    expect(isUnauthorizedError(new ApiFailure({ kind: "unauthorized" }))).toBe(
      true,
    );
  });

  test("rejects another ApiFailure", () => {
    expect(isUnauthorizedError(new ApiFailure({ kind: "forbidden" }))).toBe(
      false,
    );
  });

  test("rejects a plain Error", () => {
    expect(isUnauthorizedError(new Error("unauthorized"))).toBe(false);
  });

  test("rejects a non-error value", () => {
    expect(isUnauthorizedError("unauthorized")).toBe(false);
  });
});

describe("createAuthStore", () => {
  test("reports the initial state", () => {
    expect(createAuthStore().getSnapshot().unauthorized).toBe(false);
  });

  test("updates the snapshot when an unauthorized error is reported", () => {
    const store = createAuthStore();
    store.reportError(new ApiFailure({ kind: "unauthorized" }));
    expect(store.getSnapshot().unauthorized).toBe(true);
  });

  test("ignores an unrelated error", () => {
    const store = createAuthStore();
    store.reportError(new Error("boom"));
    expect(store.getSnapshot().unauthorized).toBe(false);
  });

  test("clears the state on success", () => {
    const store = createAuthStore();
    store.reportError(new ApiFailure({ kind: "unauthorized" }));
    store.reportSuccess();
    expect(store.getSnapshot().unauthorized).toBe(false);
  });

  test("notifies subscribers on a change", () => {
    const store = createAuthStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.reportError(new ApiFailure({ kind: "unauthorized" }));
    expect(calls).toBe(1);
  });

  test("does not notify when nothing changes", () => {
    const store = createAuthStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.reportSuccess();
    expect(calls).toBe(0);
  });

  test("stops notifying after unsubscribe", () => {
    const store = createAuthStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    store.reportError(new ApiFailure({ kind: "unauthorized" }));
    expect(calls).toBe(0);
  });
});
