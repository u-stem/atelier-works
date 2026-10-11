import { describe, expect, test } from "bun:test";
import type { Notice } from "../../f/factory/lib/types.ts";
import {
  type NoticeResolveDeps,
  resolveNotice,
} from "../../f/factory/notice_resolve.ts";

const CREATED_AT = new Date("2026-10-01T00:00:00.000Z");

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 5,
    kind: "cleanup_db_failed",
    message: "boom",
    resolved: false,
    resolved_by: null,
    resolved_at: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

type Harness = {
  readonly deps: NoticeResolveDeps;
  readonly updates: { id: number; kind: string; by: string }[];
  readonly reads: number[];
};

/**
 * 依存を差し替えた`resolveNotice`の入力を作る。
 * `reads`の各要素が1回目、2回目の読み取りの結果になる。
 * `updateResult`は更新が行を変えたかどうか。
 */
function harness(
  reads: readonly (Notice | null)[],
  updateResult: boolean,
  approver: () => string = () => "operator",
): Harness {
  const readIds: number[] = [];
  const updates: { id: number; kind: string; by: string }[] = [];
  const deps: NoticeResolveDeps = {
    deriveApprover: approver,
    getNoticeById: async (id) => {
      readIds.push(id);
      return reads[readIds.length - 1] ?? null;
    },
    resolveNoticeIfUnresolved: async (id, kind, by) => {
      updates.push({ id, kind, by });
      return updateResult;
    },
  };
  return { deps, updates, reads: readIds };
}

describe("resolveNotice input", () => {
  test("rejects zero", async () => {
    const h = harness([notice()], true);
    await expect(resolveNotice(0, h.deps)).rejects.toThrow("positive integer");
  });

  test("rejects a negative id", async () => {
    const h = harness([notice()], true);
    await expect(resolveNotice(-1, h.deps)).rejects.toThrow("positive integer");
  });

  test("rejects a non-integer id", async () => {
    const h = harness([notice()], true);
    await expect(resolveNotice(1.5, h.deps)).rejects.toThrow(
      "positive integer",
    );
  });

  test("rejects NaN", async () => {
    const h = harness([notice()], true);
    await expect(resolveNotice(Number.NaN, h.deps)).rejects.toThrow(
      "positive integer",
    );
  });

  test("does not read the database for an invalid id", async () => {
    const h = harness([notice()], true);
    await resolveNotice(0, h.deps).catch(() => undefined);
    expect(h.reads).toEqual([]);
  });
});

describe("resolveNotice approver", () => {
  test("refuses when the approver cannot be derived", async () => {
    const h = harness([notice()], true, () => {
      throw new Error("deriveApprover: cannot determine approver identity");
    });
    await expect(resolveNotice(5, h.deps)).rejects.toThrow(
      "cannot determine approver",
    );
  });

  test("does not update when the approver cannot be derived", async () => {
    const h = harness([notice()], true, () => {
      throw new Error("no approver");
    });
    await resolveNotice(5, h.deps).catch(() => undefined);
    expect(h.updates).toEqual([]);
  });

  test("records the derived approver", async () => {
    const h = harness([notice()], true, () => "alice");
    await resolveNotice(5, h.deps);
    expect(h.updates).toEqual([
      { id: 5, kind: "cleanup_db_failed", by: "alice" },
    ]);
  });
});

describe("resolveNotice", () => {
  test("resolves an unresolved notice", async () => {
    const h = harness([notice()], true);
    expect(await resolveNotice(5, h.deps)).toEqual({
      ok: true,
      status: "resolved",
      notice_id: 5,
    });
  });

  test("throws when the notice does not exist", async () => {
    const h = harness([null], true);
    await expect(resolveNotice(5, h.deps)).rejects.toThrow("no notice");
  });

  test("throws for an unresolvable kind", async () => {
    const h = harness([notice({ kind: "unsandboxed_check_commands" })], true);
    await expect(resolveNotice(5, h.deps)).rejects.toThrow(
      "cannot be resolved",
    );
  });

  test("does not update an unresolvable kind", async () => {
    const h = harness([notice({ kind: "labeler_denied" })], true);
    await resolveNotice(5, h.deps).catch(() => undefined);
    expect(h.updates).toEqual([]);
  });

  test("reports already_resolved for a resolved notice", async () => {
    const h = harness([notice({ resolved: true })], true);
    expect(await resolveNotice(5, h.deps)).toEqual({
      ok: true,
      status: "already_resolved",
      notice_id: 5,
    });
  });

  test("does not update a resolved notice", async () => {
    const h = harness([notice({ resolved: true })], true);
    await resolveNotice(5, h.deps);
    expect(h.updates).toEqual([]);
  });
});

describe("resolveNotice when the update changes no row", () => {
  test("reports already_resolved when a concurrent call resolved it", async () => {
    const h = harness([notice(), notice({ resolved: true })], false);
    expect(await resolveNotice(5, h.deps)).toEqual({
      ok: true,
      status: "already_resolved",
      notice_id: 5,
    });
  });

  test("throws when the notice disappeared", async () => {
    const h = harness([notice(), null], false);
    await expect(resolveNotice(5, h.deps)).rejects.toThrow("disappeared");
  });

  test("throws when it is still unresolved", async () => {
    const h = harness([notice(), notice()], false);
    await expect(resolveNotice(5, h.deps)).rejects.toThrow("was not resolved");
  });
});
