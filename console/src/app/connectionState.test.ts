import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../api/errors.ts";
import {
  createConnectionStore,
  INITIAL_CONNECTION_STATE,
  reduceConnection,
} from "./connectionState.ts";

describe("reduceConnection", () => {
  test("marks Windmill unreachable after a network failure", () => {
    expect(
      reduceConnection(INITIAL_CONNECTION_STATE, {
        type: "failed",
        error: { kind: "network" },
      }),
    ).toEqual({ unreachable: true });
  });

  test("clears the mark when a fetch succeeds", () => {
    expect(
      reduceConnection({ unreachable: true }, { type: "succeeded" }),
    ).toEqual({ unreachable: false });
  });

  test("clears the mark when Windmill answers with a failure", () => {
    expect(
      reduceConnection(
        { unreachable: true },
        { type: "failed", error: { kind: "http", status: 500, detail: "" } },
      ),
    ).toEqual({ unreachable: false });
  });

  test("clears the mark for an unauthorized answer", () => {
    expect(
      reduceConnection(
        { unreachable: true },
        { type: "failed", error: { kind: "unauthorized" } },
      ),
    ).toEqual({ unreachable: false });
  });

  test("clears the mark for a job that timed out, because Windmill answered", () => {
    expect(
      reduceConnection(
        { unreachable: true },
        { type: "failed", error: { kind: "timeout_or_unknown" } },
      ),
    ).toEqual({ unreachable: false });
  });

  test("keeps the same state object when nothing changes", () => {
    expect(
      reduceConnection(INITIAL_CONNECTION_STATE, { type: "succeeded" }),
    ).toBe(INITIAL_CONNECTION_STATE);
  });
});

describe("createConnectionStore", () => {
  test("starts reachable", () => {
    expect(createConnectionStore().getSnapshot().unreachable).toBe(false);
  });

  test("becomes unreachable after a network failure", () => {
    const store = createConnectionStore();
    store.reportError(new ApiFailure({ kind: "network" }));
    expect(store.getSnapshot().unreachable).toBe(true);
  });

  test("becomes reachable after a success", () => {
    const store = createConnectionStore();
    store.reportError(new ApiFailure({ kind: "network" }));
    store.reportSuccess();
    expect(store.getSnapshot().unreachable).toBe(false);
  });

  test("ignores an error that is not an API failure", () => {
    const store = createConnectionStore();
    store.reportError(new Error("boom"));
    expect(store.getSnapshot().unreachable).toBe(false);
  });

  test("tells the listeners when the state changes", () => {
    const store = createConnectionStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.reportError(new ApiFailure({ kind: "network" }));
    expect(calls).toBe(1);
  });

  test("does not tell the listeners when nothing changes", () => {
    const store = createConnectionStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.reportSuccess();
    expect(calls).toBe(0);
  });

  test("stops telling a listener that unsubscribed", () => {
    const store = createConnectionStore();
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
    });
    stop();
    store.reportError(new ApiFailure({ kind: "network" }));
    expect(calls).toBe(0);
  });
});
