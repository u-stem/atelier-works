// Consoleの保留と凍結の画面(console/)が、backendのconsole_holdsと食い違わないことを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import * as consoleHolds from "../../console/src/api/guards/holds.ts";
import {
  holdItems,
  holdsFailureView,
} from "../../console/src/lib/holdsView.ts";
import {
  holderKindLabel,
  holdScopeLabel,
} from "../../console/src/lib/labels.ts";
import {
  type HoldsSnapshotDeps,
  loadHoldsSnapshot,
} from "../../f/factory/console_holds.ts";
import type * as support from "../../f/factory/lib/console_holds_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { serializeFreezeState } from "../../f/factory/lib/freezes.ts";
import {
  HOLD_SCOPES,
  HOLDER_KINDS,
  listActiveHolds,
} from "../../f/factory/lib/holds.ts";

const NOW = new Date("2026-10-24T03:00:00.000Z");

function sqlReturning(response: SqlRow[] | Error): SqlClient {
  return () => ({
    fetch: () =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response),
    execute: async () => {},
  });
}

function holdRow(scope: string, id: number, holderKind: string): SqlRow {
  return {
    id,
    scope,
    target: scope === "merge" ? "octo/repo" : "octo/repo#1",
    reason: "r",
    holder_kind: holderKind,
    holder: holderKind === "human" ? "human" : `${holderKind}:x`,
    created_at: new Date("2026-10-24T02:00:00.000Z"),
    expires_at: new Date("2026-10-24T04:00:00.000Z"),
    released_at: null,
    released_by: null,
  };
}

const VARIABLE = serializeFreezeState({
  version: 1,
  freezes: [
    {
      id: "0a1b2c3d",
      target: "f/factory/poll_issues",
      reason: "r",
      holder_kind: "session",
      holder: "session:x",
      created_at: "2026-10-24T02:00:00.000Z",
      expires_at: "2026-10-24T04:00:00.000Z",
      released_at: null,
    },
  ],
  deploy_freezes: [
    {
      id: "1b2c3d4e",
      reason: "r",
      holder_kind: "human",
      holder: "human",
      created_at: "2026-10-24T02:00:00.000Z",
      expires_at: "2026-10-24T04:00:00.000Z",
      released_at: null,
    },
  ],
});

function depsFor(
  holds: SqlRow[] | Error,
  variable: string | null,
): HoldsSnapshotDeps {
  return {
    listHolds: () => listActiveHolds({}, sqlReturning(holds)),
    ports: {
      readVariable: async () => variable,
      writeVariable: async () => {},
      now: () => NOW,
    },
  };
}

async function snapshotOver(wire: unknown): Promise<unknown> {
  return JSON.parse(JSON.stringify(wire));
}

describe("what console_holds returns", () => {
  test("a full snapshot passes the guard", async () => {
    const snapshot = await loadHoldsSnapshot(
      depsFor(
        [
          holdRow("merge", 1, "session"),
          holdRow("claim", 2, "factory"),
          holdRow("merge", 3, "human"),
        ],
        VARIABLE,
      ),
    );
    expect(consoleHolds.isHoldsSnapshot(await snapshotOver(snapshot))).toBe(
      true,
    );
  });

  test("an empty snapshot passes the guard", async () => {
    const snapshot = await loadHoldsSnapshot(depsFor([], null));
    expect(consoleHolds.isHoldsSnapshot(await snapshotOver(snapshot))).toBe(
      true,
    );
  });

  const FAILURES: [string, SqlRow[] | Error][] = [
    ["a missing table", Object.assign(new Error("x"), { code: "42P01" })],
    ["an unreadable table", new Error("connection refused")],
    ["a corrupt row", [holdRow("other", 1, "session")]],
  ];

  test.each(FAILURES)("%s passes the guard", async (_name, failure) => {
    const snapshot = await loadHoldsSnapshot(depsFor(failure, VARIABLE));
    expect(consoleHolds.isHoldsSnapshot(await snapshotOver(snapshot))).toBe(
      true,
    );
  });

  test("a corrupt variable passes the guard", async () => {
    const snapshot = await loadHoldsSnapshot(depsFor([], "{not json"));
    expect(consoleHolds.isHoldsSnapshot(await snapshotOver(snapshot))).toBe(
      true,
    );
  });

  test("the backend snapshot fits the console type", () => {
    const backend: support.HoldsSnapshot = {
      holds: { ok: true, rows: [] },
      freezes: { ok: true, schedule: [], deploy: [] },
    };
    const consoleSide: consoleHolds.HoldsSnapshot = backend;
    expect(consoleHolds.isHoldsSnapshot(consoleSide)).toBe(true);
  });
});

describe("what the labels cover", () => {
  test.each([...HOLD_SCOPES])("labels the hold scope %s", (scope) => {
    expect(holdScopeLabel(scope)).not.toBe("不明な種類の保留");
  });

  test.each([...HOLDER_KINDS])("labels the holder kind %s", (kind) => {
    expect(holderKindLabel(kind)).not.toBe("不明な主体");
  });

  test.each(["missing_table", "read_failed", "corrupt"] as const)(
    "has its own words for the failure %s",
    (kind) => {
      expect(holdsFailureView({ ok: false, kind, reason: "r" }).title).toMatch(
        /[ぁ-んァ-ヶ一-龠]/,
      );
    },
  );

  test("the failure kinds do not share a title", () => {
    const titles = (["missing_table", "read_failed", "corrupt"] as const).map(
      (kind) => holdsFailureView({ ok: false, kind, reason: "r" }).title,
    );
    expect(new Set(titles).size).toBe(3);
  });

  test("every scope of a real snapshot becomes a row", async () => {
    const snapshot = await loadHoldsSnapshot(
      depsFor(
        [holdRow("merge", 1, "session"), holdRow("claim", 2, "human")],
        null,
      ),
    );
    const wire = await snapshotOver(snapshot);
    expect(
      consoleHolds.isHoldsSnapshot(wire) && wire.holds.ok
        ? holdItems(wire.holds.rows).map((item) => item.category)
        : [],
    ).toEqual(["merge", "claim"]);
  });
});
