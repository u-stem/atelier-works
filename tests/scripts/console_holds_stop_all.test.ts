import { describe, expect, test } from "bun:test";
import * as consoleHolds from "../../console/src/api/guards/holds.ts";
import {
  type HoldsSnapshotDeps,
  loadHoldsSnapshot,
} from "../../f/factory/console_holds.ts";
import type { SqlClient } from "../../f/factory/lib/db.ts";
import { listActiveHolds } from "../../f/factory/lib/holds.ts";

const NOW = new Date("2026-11-05T03:00:00.000Z");

const emptySql: SqlClient = () => ({
  fetch: () => Promise.resolve([]),
  execute: async () => {},
});

function deps(variable: string | null | Error): HoldsSnapshotDeps {
  return {
    listHolds: () => listActiveHolds({}, emptySql),
    ports: {
      readVariable: async () => null,
      writeVariable: async () => {},
      now: () => NOW,
    },
    listPendingDeployApprovals: async () => [],
    stopAll: {
      readVariable: async () => {
        if (variable instanceof Error) throw variable;
        return variable;
      },
    },
  };
}

function placed(reason: string, placedBy = "operator"): string {
  return JSON.stringify({
    placed_at: "2026-11-05T02:00:00+00:00",
    placed_by: placedBy,
    reason,
  });
}

describe("loadHoldsSnapshot stop_all", () => {
  test("reports no stop when the variable is missing", async () => {
    expect((await loadHoldsSnapshot(deps(null))).stop_all).toEqual({
      kind: "clear",
    });
  });

  test("returns the placed stop", async () => {
    expect((await loadHoldsSnapshot(deps(placed("loop")))).stop_all).toEqual({
      kind: "active",
      placed_at: "2026-11-05T02:00:00.000Z",
      placed_by: "operator",
      reason: "loop",
    });
  });

  test("reports a corrupt variable", async () => {
    expect((await loadHoldsSnapshot(deps("{not json"))).stop_all.kind).toBe(
      "corrupt",
    );
  });

  test("reports a variable it cannot read", async () => {
    expect(
      (await loadHoldsSnapshot(deps(new Error("api down")))).stop_all.kind,
    ).toBe("unreadable");
  });

  test("still returns the holds when the stop cannot be read", async () => {
    expect(
      (await loadHoldsSnapshot(deps(new Error("api down")))).holds,
    ).toEqual({ ok: true, rows: [] });
  });

  test("passes the console guard with a placed stop", async () => {
    const snapshot = await loadHoldsSnapshot(deps(placed("loop")));
    expect(
      consoleHolds.isHoldsSnapshot(JSON.parse(JSON.stringify(snapshot))),
    ).toBe(true);
  });
});
