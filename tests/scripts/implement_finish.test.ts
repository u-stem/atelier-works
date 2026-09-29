import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECRETS_NOT_PUSHED_REASON } from "../../f/factory/lib/implement_finish_support.ts";
import {
  needsHumanBaseReason,
  selectImplementNextAction,
  transitionResult,
} from "../../f/factory/steps/implement_finish.ts";

describe("needsHumanBaseReason", () => {
  test("uses the loop's reason for a stop that keeps no work", () => {
    expect(
      needsHumanBaseReason("worktree git pointer was modified", null),
    ).toBe("worktree git pointer was modified");
  });

  test("uses prepare's reason when the loop did not run", () => {
    expect(
      needsHumanBaseReason(null, "no approved requirements for attempt 2"),
    ).toBe("no approved requirements for attempt 2");
  });

  test("falls back to a generic reason", () => {
    expect(needsHumanBaseReason(null, null)).toBe("needs human attention");
  });
});

describe("selectImplementNextAction", () => {
  const base = {
    preserveWork: true,
    branch: "factory/issue-7-wi-3",
    notes: [],
  } as const;

  test("points a guard stop at the branch", () => {
    expect(
      selectImplementNextAction({
        ...base,
        outcome: "stalled",
        reason: "implement stalled after round 2",
      }),
    ).toContain("`factory/issue-7-wi-3`");
  });

  test("uses the budget rule for a budget stop", () => {
    expect(
      selectImplementNextAction({
        ...base,
        outcome: "daily_budget",
        reason: "daily budget exceeded",
      }),
    ).toBe("翌日まで待つか、daily_budget_usdを引き上げてください");
  });

  test("uses the reason rule when there is no work to keep", () => {
    expect(
      selectImplementNextAction({
        preserveWork: false,
        outcome: "needs_human",
        reason: "no approved requirements for attempt 2",
        branch: null,
        notes: [],
      }),
    ).toBe(
      "要件定義を承認し直すか、Issueに`factory`ラベルを付け直してください",
    );
  });

  test("prefers the first note's next action", () => {
    expect(
      selectImplementNextAction({
        ...base,
        outcome: "stalled",
        reason: "implement stalled after round 2",
        notes: [SECRETS_NOT_PUSHED_REASON],
      }),
    ).toBe(
      "worktreeの差分を確認し、秘密情報を取り除いてから人が対応してください",
    );
  });
});

describe("transitionResult", () => {
  test("reports the status the work item moved to", () => {
    expect(transitionResult(true, "pr_open", null).final_status).toBe(
      "pr_open",
    );
  });

  test("reports no status when the CAS did not move the work item", () => {
    expect(transitionResult(false, "pr_open", null).final_status).toBeNull();
  });
});

describe("implement_finish open_pr ordering", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../f/factory/steps/implement_finish.ts"),
    "utf8",
  );

  // A label failure must not lose the PR: pr_url is recorded first.
  test("records pr_url before adding the review label", () => {
    expect(source.indexOf("await setWorkItemPrUrl(")).toBeLessThan(
      source.indexOf("await addLabels("),
    );
  });
});
