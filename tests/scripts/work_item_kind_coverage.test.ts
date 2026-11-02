// 作業項目の種別(`WorkItemKind`)の全値について、`issue_number`と`pr_number`のどちらを対象の番号にするかに
// 依る分岐が、種別を飛ばさないことを確かめる。
// 分岐は、照合、要対応の照合、再実行にある。種別を足したときに、番号の置き場を持たない種別が
// 黙って飛ばされ、閉じたIssueの作業項目が残り続けるのを防ぐ。
// 種別を足すと、下の表が型エラーになるので、置き場を決めてから進める。

import { describe, expect, test } from "bun:test";
import {
  decideReconcileAction,
  groupActionableTargets,
  isWaitingForHuman,
  reconcileLabel,
  reconcileTargetOf,
} from "../../f/factory/lib/poll_support.ts";
import {
  isIssueTargetKind,
  WORK_ITEM_KINDS,
  type WorkItem,
  type WorkItemKind,
} from "../../f/factory/lib/types.ts";
import {
  closedTargetRefusal,
  computeRestartPlan,
  type RestartContext,
} from "../../f/factory/retry_work_item.ts";

/** 種別ごとの、GitHub上の対象。`none`は対象を持たない。 */
const TARGET_OF: Record<WorkItemKind, "issue" | "pr" | "none"> = {
  issue: "issue",
  investigate: "issue",
  pr_review: "pr",
  pr_fix: "pr",
  dependabot: "pr",
  audit: "none",
};

/** 再実行できない種別。 */
const NOT_RESTARTABLE: readonly WorkItemKind[] = [
  "audit",
  "dependabot",
  "investigate",
];

const ISSUE_NUMBER = 10;
const PR_NUMBER = 20;

/** 種別の対象の番号を、その置き場にだけ持つ作業項目。 */
function itemOf(
  kind: WorkItemKind,
): Pick<
  WorkItem,
  "id" | "kind" | "owner" | "repo" | "issue_number" | "pr_number"
> {
  const target = TARGET_OF[kind];
  return {
    id: 7,
    kind,
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: target === "issue" ? ISSUE_NUMBER : null,
    pr_number: target === "pr" ? PR_NUMBER : null,
  };
}

function numberOf(kind: WorkItemKind): number {
  return TARGET_OF[kind] === "issue" ? ISSUE_NUMBER : PR_NUMBER;
}

const CONTEXT: RestartContext = {
  implementReady: false,
  implementEnabled: false,
  designEnabled: false,
  designApproved: false,
  stop: "other",
  feedback: null,
  designFeedback: null,
  carriesGap: false,
};

function restartPlanOf(kind: WorkItemKind) {
  return computeRestartPlan(
    { id: 7, status: "failed", kind, attempt: 1, design_attempt: 0 },
    CONTEXT,
  );
}

describe("every work item kind", () => {
  test("is listed in the table of targets", () => {
    const kinds: string[] = [...WORK_ITEM_KINDS];
    expect(kinds.sort()).toEqual(Object.keys(TARGET_OF).sort());
  });

  test.each([...WORK_ITEM_KINDS])(
    "%s agrees with isIssueTargetKind about its target",
    (kind) => {
      expect(isIssueTargetKind(kind)).toBe(TARGET_OF[kind] === "issue");
    },
  );

  test.each([...WORK_ITEM_KINDS])(
    "%s is grouped by the number of its target, unless it has none",
    (kind) => {
      const keys = groupActionableTargets([itemOf(kind)]).map(
        (target) => target.key,
      );
      expect(keys).toEqual(
        TARGET_OF[kind] === "none"
          ? []
          : [`octo-owner/atelier-works#${String(numberOf(kind))}`],
      );
    },
  );

  test.each([...WORK_ITEM_KINDS])(
    "%s is reconciled against the object of its target",
    (kind) => {
      const target = TARGET_OF[kind];
      expect(reconcileTargetOf(itemOf(kind))).toEqual(
        target === "none"
          ? { kind: "audit" }
          : { kind: target, number: numberOf(kind) },
      );
    },
  );

  test.each([...WORK_ITEM_KINDS.filter((kind) => TARGET_OF[kind] !== "none")])(
    "%s is skipped by the reconcile when its number is missing",
    (kind) => {
      expect(
        reconcileTargetOf({
          kind,
          issue_number: null,
          pr_number: null,
        }),
      ).toBeNull();
    },
  );

  test.each([...WORK_ITEM_KINDS])(
    "%s is named after the number of its target in the log",
    (kind) => {
      const label = reconcileLabel(itemOf(kind));
      expect(label).toBe(
        TARGET_OF[kind] === "none"
          ? "octo-owner/atelier-works audit#7"
          : `octo-owner/atelier-works#${String(numberOf(kind))}`,
      );
    },
  );

  test.each([...WORK_ITEM_KINDS.filter((kind) => TARGET_OF[kind] !== "none")])(
    "%s asks GitHub whether its target is open by the number of the target",
    async (kind) => {
      const asked: number[] = [];
      await closedTargetRefusal(itemOf(kind), async (_owner, _repo, number) => {
        asked.push(number);
        return "open";
      });
      expect(asked).toEqual([numberOf(kind)]);
    },
  );

  test.each([...NOT_RESTARTABLE])("%s is refused by the restart", (kind) => {
    expect(() => restartPlanOf(kind)).toThrow(/not restartable/);
  });

  test.each([
    ...WORK_ITEM_KINDS.filter((kind) => !NOT_RESTARTABLE.includes(kind)),
  ])("%s is planned by the restart", (kind) => {
    expect(restartPlanOf(kind).toStatus).toBeDefined();
  });
});

describe("the investigating status", () => {
  const NOW = new Date("2026-11-02T12:00:00.000Z");

  test("is not a state in which a person is waited for", () => {
    expect(isWaitingForHuman("investigating")).toBe(false);
  });

  test("is cancelled by the reconcile when the Issue is closed", () => {
    expect(
      decideReconcileAction(
        { updated_at: NOW },
        { kind: "issue", open: false },
        { state: "running" },
        NOW,
      ),
    ).toEqual({ action: "cancel", reason: "closed" });
  });

  test("is left alone while its job runs and the Issue is open", () => {
    expect(
      decideReconcileAction(
        { updated_at: NOW },
        { kind: "issue", open: true },
        { state: "running" },
        NOW,
      ),
    ).toEqual({ action: "none" });
  });
});
