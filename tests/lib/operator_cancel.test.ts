import { describe, expect, test } from "bun:test";
import {
  isOperatorCancellable,
  isOperatorCancelledAtHead,
  isOperatorCancelledNote,
  OPERATOR_CANCELLABLE_STATUSES,
  OPERATOR_CANCELLED_NOTE,
  operatorCancellableStatuses,
  readOperatorCancelledAtHead,
} from "../../f/factory/lib/operator_cancel.ts";
import {
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "89abcdef0123456789abcdef0123456789abcdef";

describe("the note of a cancel by a person", () => {
  test("is a fixed text that the reconcile does not write", () => {
    expect(OPERATOR_CANCELLED_NOTE).toBe("console: operator_cancelled");
  });

  test("is recognized when it is the whole note", () => {
    expect(isOperatorCancelledNote(OPERATOR_CANCELLED_NOTE)).toBe(true);
  });

  test("is not recognized inside a longer note", () => {
    expect(isOperatorCancelledNote(`x ${OPERATOR_CANCELLED_NOTE}`)).toBe(false);
  });

  test("is not recognized for no note", () => {
    expect(isOperatorCancelledNote(null)).toBe(false);
  });
});

describe("the table of the work items a person can cancel", () => {
  test("has a row for every kind of work item", () => {
    expect(Object.keys(OPERATOR_CANCELLABLE_STATUSES).sort()).toEqual(
      [...WORK_ITEM_KINDS].sort(),
    );
  });

  test("names only states that exist", () => {
    const unknown = Object.values(OPERATOR_CANCELLABLE_STATUSES)
      .flat()
      .filter(
        (status) => !WORK_ITEM_STATUSES.some((known) => known === status),
      );
    expect(unknown).toEqual([]);
  });

  // 終端でない状態では、ジョブが動いているので、実行中の中止の仕組みが無いまま止めない。
  test("names no state in which a flow is still running", () => {
    const running = Object.values(OPERATOR_CANCELLABLE_STATUSES)
      .flat()
      .filter(
        (status) =>
          !TERMINAL_WORK_ITEM_STATUSES.some((known) => known === status) &&
          status !== "awaiting_approval" &&
          status !== "awaiting_design_approval",
      );
    expect(running).toEqual([]);
  });

  test("never lists the cancelled state", () => {
    expect(
      Object.values(OPERATOR_CANCELLABLE_STATUSES).flat().includes("cancelled"),
    ).toBe(false);
  });

  test("lets a person cancel an Issue that waits for the approval of its requirements", () => {
    expect(isOperatorCancellable("issue", "awaiting_approval")).toBe(true);
  });

  test("lets a person cancel an Issue that waits for the approval of its design", () => {
    expect(isOperatorCancellable("issue", "awaiting_design_approval")).toBe(
      true,
    );
  });

  test("lets a person cancel an approved Issue whose implementation has not started", () => {
    expect(isOperatorCancellable("issue", "approved")).toBe(true);
  });

  test("does not let a person cancel an Issue that is being implemented", () => {
    expect(isOperatorCancellable("issue", "implementing")).toBe(false);
  });

  test("does not let a person cancel an Issue whose pull request is open", () => {
    expect(isOperatorCancellable("issue", "pr_open")).toBe(false);
  });

  test("lets a person cancel a failed fix", () => {
    expect(isOperatorCancellable("pr_fix", "failed")).toBe(true);
  });

  test("does not let a person cancel a fix that is running", () => {
    expect(isOperatorCancellable("pr_fix", "fixing")).toBe(false);
  });

  test("lets a person cancel a dependabot item that waits for a person", () => {
    expect(isOperatorCancellable("dependabot", "needs_human")).toBe(true);
  });

  test("does not let a person cancel an investigation that is running", () => {
    expect(isOperatorCancellable("investigate", "investigating")).toBe(false);
  });

  test("gives no state for a kind it does not know", () => {
    expect(operatorCancellableStatuses("unknown")).toEqual([]);
  });

  test("does not take a key of the prototype for a kind", () => {
    expect(operatorCancellableStatuses("constructor")).toEqual([]);
  });
});

describe("isOperatorCancelledAtHead", () => {
  test("is true when the latest row was cancelled by a person at the same head", () => {
    expect(
      isOperatorCancelledAtHead(
        { status: "cancelled", head_sha: HEAD },
        OPERATOR_CANCELLED_NOTE,
        HEAD,
      ),
    ).toBe(true);
  });

  test("is false when the head has moved since the cancel", () => {
    expect(
      isOperatorCancelledAtHead(
        { status: "cancelled", head_sha: OTHER_HEAD },
        OPERATOR_CANCELLED_NOTE,
        HEAD,
      ),
    ).toBe(false);
  });

  test("is false for a row that the reconcile cancelled", () => {
    expect(
      isOperatorCancelledAtHead(
        { status: "cancelled", head_sha: HEAD },
        "reconcile: pr_closed (actionable)",
        HEAD,
      ),
    ).toBe(false);
  });

  test("is false for a row that is not cancelled", () => {
    expect(
      isOperatorCancelledAtHead(
        { status: "failed", head_sha: HEAD },
        OPERATOR_CANCELLED_NOTE,
        HEAD,
      ),
    ).toBe(false);
  });

  test("is false when the row has no head", () => {
    expect(
      isOperatorCancelledAtHead(
        { status: "cancelled", head_sha: null },
        OPERATOR_CANCELLED_NOTE,
        HEAD,
      ),
    ).toBe(false);
  });

  test("is false when there is no row", () => {
    expect(isOperatorCancelledAtHead(null, OPERATOR_CANCELLED_NOTE, HEAD)).toBe(
      false,
    );
  });
});

describe("readOperatorCancelledAtHead", () => {
  test("is true when the latest row was cancelled by a person at the same head", async () => {
    expect(
      await readOperatorCancelledAtHead(
        {
          latestPrRow: async () => ({
            id: 7,
            status: "cancelled",
            head_sha: HEAD,
          }),
          cancelNote: async () => OPERATOR_CANCELLED_NOTE,
        },
        HEAD,
      ),
    ).toBe(true);
  });

  test("does not read the note of a row that is not cancelled", async () => {
    const read: number[] = [];
    await readOperatorCancelledAtHead(
      {
        latestPrRow: async () => ({ id: 7, status: "failed", head_sha: HEAD }),
        cancelNote: async (id) => {
          read.push(id);
          return OPERATOR_CANCELLED_NOTE;
        },
      },
      HEAD,
    );
    expect(read).toEqual([]);
  });

  test("reads the note of the latest row", async () => {
    const read: number[] = [];
    await readOperatorCancelledAtHead(
      {
        latestPrRow: async () => ({
          id: 9,
          status: "cancelled",
          head_sha: HEAD,
        }),
        cancelNote: async (id) => {
          read.push(id);
          return null;
        },
      },
      HEAD,
    );
    expect(read).toEqual([9]);
  });

  test("is false when the pull request has no row", async () => {
    expect(
      await readOperatorCancelledAtHead(
        {
          latestPrRow: async () => null,
          cancelNote: async () => OPERATOR_CANCELLED_NOTE,
        },
        HEAD,
      ),
    ).toBe(false);
  });
});
