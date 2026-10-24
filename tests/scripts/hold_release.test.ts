import { describe, expect, test } from "bun:test";
import {
  ALREADY_RELEASED_REASON,
  type HoldReleaseDeps,
  releaseHoldFromConsole,
} from "../../f/factory/hold_release.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  type HoldActor,
  type HoldReadOutcome,
  type HoldRow,
  type Outcome,
  releaseHold,
} from "../../f/factory/lib/holds.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = new Date("2026-10-24T03:04:05.000Z");

function activeRow(overrides: Partial<HoldRow> = {}): HoldRow {
  return {
    id: 12,
    scope: "merge",
    target: "octo/repo",
    reason: "SECRET-REASON",
    holder_kind: "session",
    holder: "session:SECRET-HOLDER",
    created_at: "2026-10-24T02:00:00.000Z",
    expires_at: "2026-10-24T04:00:00.000Z",
    released_at: null,
    released_by: null,
    ...overrides,
  };
}

type Harness = {
  readonly deps: HoldReleaseDeps;
  readonly calls: string[];
  readonly released: { id: number; actor: HoldActor }[];
  readonly notices: NoticeRecord[];
  readonly warnings: string[];
};

type Options = {
  readonly active?: HoldReadOutcome<readonly HoldRow[]>;
  readonly release?: Outcome<{ readonly id: number }> | null;
  readonly approver?: () => string;
  readonly noticeFails?: boolean;
};

function harness(options: Options = {}): Harness {
  const calls: string[] = [];
  const released: { id: number; actor: HoldActor }[] = [];
  const notices: NoticeRecord[] = [];
  const warnings: string[] = [];
  const deps: HoldReleaseDeps = {
    deriveApprover:
      options.approver ??
      (() => {
        calls.push("deriveApprover");
        return "operator";
      }),
    listActiveHolds: async () => {
      calls.push("list");
      return options.active ?? { ok: true, value: [activeRow()] };
    },
    releaseHold: async (id, actor) => {
      calls.push("release");
      released.push({ id, actor });
      return options.release ?? { ok: true, value: { id } };
    },
    addNotice: async (record) => {
      calls.push("notice");
      if (options.noticeFails === true) throw new Error("notice down");
      notices.push(record);
      return 1;
    },
    now: () => NOW,
    warn: (message, fields) => {
      warnings.push(JSON.stringify({ message, fields }));
    },
  };
  return { deps, calls, released, notices, warnings };
}

describe("releaseHoldFromConsole input", () => {
  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    "rejects the id %p",
    async (id) => {
      const h = harness();

      await expect(releaseHoldFromConsole(id, h.deps)).rejects.toThrow(
        "hold_release:",
      );
    },
  );

  test("calls nothing for an invalid id", async () => {
    const h = harness();

    await releaseHoldFromConsole(0, h.deps).catch(() => undefined);

    expect(h.calls).toEqual([]);
  });
});

describe("releaseHoldFromConsole operator", () => {
  test("refuses when the operator cannot be derived", async () => {
    const h = harness({
      approver: () => {
        throw new Error("cannot determine approver identity");
      },
    });

    await expect(releaseHoldFromConsole(12, h.deps)).rejects.toThrow(
      "approver",
    );
  });

  test("calls nothing when the operator cannot be derived", async () => {
    const h = harness({
      approver: () => {
        throw new Error("cannot determine approver identity");
      },
    });

    await releaseHoldFromConsole(12, h.deps).catch(() => undefined);

    expect(h.calls).toEqual([]);
  });
});

describe("releaseHoldFromConsole release", () => {
  test("releases as the human actor", async () => {
    const h = harness();

    await releaseHoldFromConsole(12, h.deps);

    expect(h.released).toEqual([
      { id: 12, actor: { kind: "human", holder: "human" } },
    ]);
  });

  test("returns the id and the released status", async () => {
    const h = harness();

    const result = await releaseHoldFromConsole(12, h.deps);

    expect([result.ok, result.status, result.hold_id]).toEqual([
      true,
      "released",
      12,
    ]);
  });

  test("reports that the hold was active", async () => {
    const h = harness();

    expect((await releaseHoldFromConsole(12, h.deps)).was_active).toBe(true);
  });

  test("releases a hold that a session placed", async () => {
    const h = harness({
      active: { ok: true, value: [activeRow({ holder_kind: "session" })] },
    });

    expect((await releaseHoldFromConsole(12, h.deps)).status).toBe("released");
  });

  test("reports an expired row as not active", async () => {
    const h = harness({ active: { ok: true, value: [] } });

    expect((await releaseHoldFromConsole(12, h.deps)).was_active).toBe(false);
  });

  test("leaves no notice for an expired row", async () => {
    const h = harness({ active: { ok: true, value: [] } });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices).toEqual([]);
  });

  test("does not claim an audit for an expired row", async () => {
    const h = harness({ active: { ok: true, value: [] } });

    expect((await releaseHoldFromConsole(12, h.deps)).audit).toBeUndefined();
  });

  test("does not report the hold as active when the list cannot be read", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    expect((await releaseHoldFromConsole(12, h.deps)).was_active).toBe(false);
  });

  test("marks the activity as unknown when the list cannot be read", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    expect((await releaseHoldFromConsole(12, h.deps)).active_unknown).toBe(
      true,
    );
  });

  test("does not mark the activity as unknown when the list is read", async () => {
    const h = harness();

    expect(
      (await releaseHoldFromConsole(12, h.deps)).active_unknown,
    ).toBeUndefined();
  });

  test("does not claim a release in the notice when the list cannot be read", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).not.toContain("解除しました");
  });

  test("says that it could not tell whether the hold was active", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).toContain("確認できませんでした");
  });

  test("names the operator in that notice", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).toContain("operator");
  });

  test("names the id in that notice", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).toContain("id 12");
  });

  test("reports the audit when the list cannot be read", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    expect((await releaseHoldFromConsole(12, h.deps)).audit).toBe("recorded");
  });

  test("still releases when the list cannot be read", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.released.length).toBe(1);
  });

  test("releases only once for one call", async () => {
    const h = harness();

    await releaseHoldFromConsole(12, h.deps);

    expect(h.calls.filter((call) => call === "release").length).toBe(1);
  });
});

describe("releaseHoldFromConsole outcomes", () => {
  test("returns already_released as a success", async () => {
    const h = harness({
      release: { ok: false, reason: ALREADY_RELEASED_REASON },
    });

    const result = await releaseHoldFromConsole(12, h.deps);

    expect([result.ok, result.status, result.hold_id]).toEqual([
      true,
      "already_released",
      12,
    ]);
  });

  test("leaves no notice for already_released", async () => {
    const h = harness({
      release: { ok: false, reason: ALREADY_RELEASED_REASON },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices).toEqual([]);
  });

  test("throws for another failure with the script prefix", async () => {
    const h = harness({
      release: { ok: false, reason: "no hold has that id" },
    });

    await expect(releaseHoldFromConsole(12, h.deps)).rejects.toThrow(
      "hold_release: no hold has that id",
    );
  });

  test("leaves no notice for another failure", async () => {
    const h = harness({
      release: { ok: false, reason: "no hold has that id" },
    });

    await releaseHoldFromConsole(12, h.deps).catch(() => undefined);

    expect(h.notices).toEqual([]);
  });
});

describe("the already released reason", () => {
  function sequence(responses: SqlRow[][]): SqlClient {
    let index = 0;
    return () => {
      const response = responses[index] ?? [];
      index += 1;
      return {
        fetch: async () => response,
        execute: async () => {},
      };
    };
  }

  test("is the reason that releaseHold returns for a released row", async () => {
    const sql = sequence([
      [
        {
          id: 12,
          scope: "merge",
          target: "octo/repo",
          reason: "r",
          holder_kind: "session",
          holder: "session:x",
          created_at: "2026-10-24T02:00:00.000Z",
          expires_at: "2026-10-24T04:00:00.000Z",
          released_at: "2026-10-24T02:30:00.000Z",
          released_by: "human",
        },
      ],
    ]);

    const result = await releaseHold(
      12,
      { kind: "human", holder: "human" },
      sql,
    );

    expect(result).toEqual({ ok: false, reason: ALREADY_RELEASED_REASON });
  });

  test("is the reason that releaseHold returns when another release wins", async () => {
    const sql = sequence([
      [
        {
          id: 12,
          scope: "merge",
          target: "octo/repo",
          reason: "r",
          holder_kind: "session",
          holder: "session:x",
          created_at: "2026-10-24T02:00:00.000Z",
          expires_at: "2026-10-24T04:00:00.000Z",
          released_at: null,
          released_by: null,
        },
      ],
      [],
    ]);

    const result = await releaseHold(
      12,
      { kind: "human", holder: "human" },
      sql,
    );

    expect(result).toEqual({ ok: false, reason: ALREADY_RELEASED_REASON });
  });
});

describe("releaseHoldFromConsole notice", () => {
  test("records an info notice of the kind hold_released", async () => {
    const h = harness();

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices.map((notice) => notice.kind)).toEqual(["hold_released"]);
  });

  test("names the kind, the target, the id and the operator", async () => {
    const h = harness();

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).toBe(
      "保留(merge、対象 octo/repo、id 12)をoperatorが解除しました。(2026-10-24 12:04:05 JST)",
    );
  });

  test("leaves the reason and the holder out of the notice", async () => {
    const h = harness();

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).not.toMatch(/SECRET/);
  });

  test("leaves the target out when the row could not be read", async () => {
    const h = harness({
      active: { ok: false, kind: "read_failed", reason: "down" },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).toBe(
      "保留(id 12)の解除の操作をoperatorが行いました。解除の前に有効だったかは確認できませんでした。(2026-10-24 12:04:05 JST)",
    );
  });

  test("replaces format characters in the target", async () => {
    const h = harness({
      active: {
        ok: true,
        value: [activeRow({ target: "octo/re‮po" })],
      },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).toContain("対象 octo/re po");
  });

  test("cuts a long target at 200 characters", async () => {
    const h = harness({
      active: { ok: true, value: [activeRow({ target: "t".repeat(300) })] },
    });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).toContain(`対象 ${"t".repeat(200)}、`);
  });

  test("cuts a long operator name at 100 characters", async () => {
    const h = harness({ approver: () => "o".repeat(300) });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.notices[0]?.message).toContain(`${"o".repeat(100)}が`);
  });

  test("reports the audit as recorded", async () => {
    const h = harness();

    expect((await releaseHoldFromConsole(12, h.deps)).audit).toBe("recorded");
  });

  test("keeps the release when the notice cannot be written", async () => {
    const h = harness({ noticeFails: true });

    expect((await releaseHoldFromConsole(12, h.deps)).status).toBe("released");
  });

  test("reports the audit as failed when the notice cannot be written", async () => {
    const h = harness({ noticeFails: true });

    expect((await releaseHoldFromConsole(12, h.deps)).audit).toBe("failed");
  });

  test("logs a warning when the notice cannot be written", async () => {
    const h = harness({ noticeFails: true });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.warnings.length).toBe(1);
  });

  test("keeps the reason and the holder out of the warning", async () => {
    const h = harness({ noticeFails: true });

    await releaseHoldFromConsole(12, h.deps);

    expect(h.warnings.join("")).not.toMatch(/SECRET/);
  });
});
