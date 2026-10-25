import { describe, expect, test } from "bun:test";
import type { RunResult } from "../api/errors.ts";
import {
  createConnectionStore,
  INITIAL_CONNECTION_STATE,
  reduceConnection,
} from "./connectionState.ts";

const NETWORK: RunResult = { ok: false, error: { kind: "network" } };
const OK: RunResult = { ok: true, value: [] };

function http(status: number): RunResult {
  return { ok: false, error: { kind: "http", status, detail: "" } };
}

describe("reduceConnection", () => {
  test("marks Windmill unreachable after a network failure", () => {
    expect(
      reduceConnection(INITIAL_CONNECTION_STATE, {
        type: "failed",
        error: { kind: "network" },
      }),
    ).toEqual({ unreachable: true });
  });

  test("marks Windmill unreachable after a 502 from the proxy", () => {
    expect(
      reduceConnection(INITIAL_CONNECTION_STATE, {
        type: "failed",
        error: { kind: "http", status: 502, detail: "" },
      }),
    ).toEqual({ unreachable: true });
  });

  test("marks Windmill unreachable after a 503 from the proxy", () => {
    expect(
      reduceConnection(INITIAL_CONNECTION_STATE, {
        type: "failed",
        error: { kind: "http", status: 503, detail: "" },
      }),
    ).toEqual({ unreachable: true });
  });

  test("clears the mark when a call succeeds", () => {
    expect(
      reduceConnection({ unreachable: true }, { type: "succeeded" }),
    ).toEqual({ unreachable: false });
  });

  test("clears the mark when Windmill answers with a 500", () => {
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

  test("clears the mark for a job that failed, because Windmill answered", () => {
    expect(
      reduceConnection(
        { unreachable: true },
        { type: "failed", error: { kind: "job_failed", message: "x" } },
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
    store.report(NETWORK);
    expect(store.getSnapshot().unreachable).toBe(true);
  });

  test("becomes unreachable after a 502", () => {
    const store = createConnectionStore();
    store.report(http(502));
    expect(store.getSnapshot().unreachable).toBe(true);
  });

  test("stays reachable after a 500", () => {
    const store = createConnectionStore();
    store.report(http(500));
    expect(store.getSnapshot().unreachable).toBe(false);
  });

  test("becomes reachable after a success", () => {
    const store = createConnectionStore();
    store.report(NETWORK);
    store.report(OK);
    expect(store.getSnapshot().unreachable).toBe(false);
  });

  test("tells the listeners when the state changes", () => {
    const store = createConnectionStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.report(NETWORK);
    expect(calls).toBe(1);
  });

  test("does not tell the listeners when nothing changes", () => {
    const store = createConnectionStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.report(OK);
    expect(calls).toBe(0);
  });

  test("stops telling a listener that unsubscribed", () => {
    const store = createConnectionStore();
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
    });
    stop();
    store.report(NETWORK);
    expect(calls).toBe(0);
  });
});
