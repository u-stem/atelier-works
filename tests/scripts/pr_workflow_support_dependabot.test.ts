// dependabotの作業項目の理由を、人が読む文にする規則のテスト。
// どの次の操作も、dependabotが拒否する`retry_work_item`を案内してはならない。

import { describe, expect, test } from "bun:test";
import {
  DEPENDABOT_MERGE_FORBIDDEN_REASON,
  DEPENDABOT_MERGE_REFUSED_REASON,
  DEPENDABOT_RESULT_UNKNOWN_REASON,
  DEPENDABOT_TIMEOUT_MISFIT_REASON,
  dependabotReason,
} from "../../f/factory/lib/dependabot_flow_support.ts";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const MANUAL_ACTION =
  "PRの内容を人が確認し、問題なければ手でマージするか閉じてください。この作業項目は再実行できません。新しいコミットが積まれると、自動で再び対象になります";
const COMMENT_ACTION =
  "PRのコメントの所見を確認し、問題なければ手でマージするか閉じてください。この作業項目は再実行できません。新しいコミットが積まれると、自動で再び対象になります";

const CASES: {
  label: string;
  reason: string;
  described: string;
  nextAction: string;
}[] = [
  {
    label: "gate",
    reason: dependabotReason("gate", "update kind is major"),
    described:
      "dependabotの更新が、自動でマージする条件を満たしていません(update kind is major)",
    nextAction: MANUAL_ACTION,
  },
  {
    label: "collect",
    reason: dependabotReason("collect", "base branch is not main"),
    described:
      "dependabotの更新の検査に必要な情報を集められませんでした(base branch is not main)",
    nextAction: MANUAL_ACTION,
  },
  {
    label: "install failed",
    reason: dependabotReason("installFailed", "exit code 1"),
    described:
      "dependabotの更新の依存を、隔離した環境でインストールできませんでした(exit code 1)",
    nextAction: MANUAL_ACTION,
  },
  {
    label: "local check",
    reason: dependabotReason("localCheck", "repository changed"),
    described:
      "dependabotの更新を、インストールした後の確認で止めました(repository changed)",
    nextAction: MANUAL_ACTION,
  },
  {
    label: "impact with supply chain concerns",
    reason: dependabotReason(
      "impact",
      "2 supply chain concern(s) were reported",
    ),
    described:
      "dependabotの更新の影響調査で、サプライチェーンの懸念が2件報告されました",
    nextAction: COMMENT_ACTION,
  },
  {
    label: "impact with unverified items",
    reason: dependabotReason("impact", "3 unverified item(s) remain"),
    described: "dependabotの更新の影響調査で、未確認の項目が3件残っています",
    nextAction: COMMENT_ACTION,
  },
  {
    label: "impact with another detail",
    reason: dependabotReason("impact", "claude output was rejected"),
    described:
      "dependabotの更新の影響調査で、人の確認が必要と判断しました(claude output was rejected)",
    nextAction: COMMENT_ACTION,
  },
  {
    label: "assess",
    reason: dependabotReason("assess", "claude run failed (timeout)"),
    described:
      "dependabotの更新の影響調査を、最後まで行えませんでした(claude run failed (timeout))",
    nextAction: MANUAL_ACTION,
  },
  {
    label: "finish",
    reason: dependabotReason("finish", "the pull request could not be re-read"),
    described:
      "dependabotの更新を、終了の処理(マージや所見の投稿)で止めました(the pull request could not be re-read)",
    nextAction: MANUAL_ACTION,
  },
  {
    label: "poll",
    reason: dependabotReason("poll", "the flow could not be started"),
    described:
      "dependabotの更新を、PRを取得する処理で人に回しました(the flow could not be started)",
    nextAction: MANUAL_ACTION,
  },
  {
    label: "merge forbidden",
    reason: DEPENDABOT_MERGE_FORBIDDEN_REASON,
    described: "dependabotの更新をマージする権限がありませんでした(403)",
    nextAction:
      "PATのマージ権限とrulesetのbypassを確認し、手でマージしてください",
  },
  {
    label: "merge refused",
    reason: DEPENDABOT_MERGE_REFUSED_REASON,
    described: "GitHubがdependabotの更新のマージを拒否しました(405)",
    nextAction: "マージできない理由(競合や保護)を確認してください",
  },
  {
    label: "result unknown",
    reason: DEPENDABOT_RESULT_UNKNOWN_REASON,
    described: "dependabotの更新のマージ結果を確認できませんでした",
    nextAction:
      "PRがマージ済みかを確認してください。未マージなら内容を確認し、手でマージするか閉じてください。この作業項目は再実行できません",
  },
  {
    label: "time settings misfit",
    reason: `${DEPENDABOT_TIMEOUT_MISFIT_REASON}: 2 claude runs x (claude_timeout_sec 9000 + 15) + 600 = 18630s exceeds 7200s`,
    described:
      "dependabotの時間設定が、flow.yamlの影響調査ステップのtimeoutに収まりません(2 claude runs x (claude_timeout_sec 9000 + 15) + 600 = 18630s exceeds 7200s)",
    nextAction:
      "claude_timeout_secを減らしてください。この作業項目は再実行できないので、PRは人が確認して手でマージするか閉じてください",
  },
];

describe("describeReason for dependabot", () => {
  test.each(CASES)("describes the $label reason", ({ reason, described }) => {
    expect(describeReason(reason)).toBe(described);
  });

  test("describes a gate reason even when the detail mentions another rule", () => {
    const reason = dependabotReason("gate", "work_items_active_issue_key");

    expect(describeReason(reason)).toBe(
      "dependabotの更新が、自動でマージする条件を満たしていません(work_items_active_issue_key)",
    );
  });

  test("describes a collect reason even when the detail mentions the pull request state", () => {
    const reason = dependabotReason("collect", "pull request is not open");

    expect(describeReason(reason)).toBe(
      "dependabotの更新の検査に必要な情報を集められませんでした(pull request is not open)",
    );
  });

  test("keeps a detail that contained a separator as one item", () => {
    const reason = dependabotReason("gate", "a; b");

    expect(describeReason(reason)).toBe(
      "dependabotの更新が、自動でマージする条件を満たしていません(a, b)",
    );
  });

  test("does not describe a reason that only mentions dependabot", () => {
    expect(describeReason("the dependabot gate: failed")).toBe(
      "the dependabot gate: failed",
    );
  });
});

describe("nextActionFor for dependabot", () => {
  test.each(CASES)(
    "gives the next action for the $label reason",
    ({ reason, nextAction }) => {
      expect(nextActionFor(reason)).toBe(nextAction);
    },
  );

  test.each(CASES)(
    "never points to retry_work_item for the $label reason",
    ({ reason }) => {
      expect(nextActionFor(reason)).not.toContain("retry_work_item");
    },
  );

  test.each(CASES)(
    "gives the same next action to every flow for the $label reason",
    ({ reason }) => {
      expect(nextActionFor(reason, "pr_fix")).toBe(nextActionFor(reason));
    },
  );

  test("gives the manual action to a gate reason that mentions another rule", () => {
    const reason = dependabotReason("gate", "work_items_active_issue_key");

    expect(nextActionFor(reason)).toBe(MANUAL_ACTION);
  });

  test("never points to retry_work_item for a long detail that was shortened", () => {
    const reason = dependabotReason("collect", "x".repeat(5000));

    expect(nextActionFor(reason)).not.toContain("retry_work_item");
  });
});

describe("nextActionFor with the dependabot flow", () => {
  test.each(CASES)(
    "keeps the specific next action for the $label reason",
    ({ reason, nextAction }) => {
      expect(nextActionFor(reason, "dependabot")).toBe(nextAction);
    },
  );

  test.each([
    "Claude failed",
    "pull request is a draft",
    "pull request is not open",
    "head branch state is unavailable",
    "GitHub rate limit on /repos/a/b: wait 60s",
    "some reason this table does not know",
  ])("gives the manual action to the reason without a prefix: %s", (reason) => {
    expect(nextActionFor(reason, "dependabot")).toBe(MANUAL_ACTION);
  });

  test.each([
    "Claude failed",
    "pull request is a draft",
    "head branch state is unavailable",
    "GitHub rate limit on /repos/a/b: wait 60s",
    "some reason this table does not know",
  ])("never points to retry_work_item for: %s", (reason) => {
    expect(nextActionFor(reason, "dependabot")).not.toContain(
      "retry_work_item",
    );
  });

  test("gives the manual action when a reason list has no dependabot item", () => {
    expect(
      nextActionFor("Claude failed; pull request is a draft", "dependabot"),
    ).toBe(MANUAL_ACTION);
  });

  test("uses the dependabot item of a reason list", () => {
    expect(
      nextActionFor(
        `Claude failed; ${DEPENDABOT_MERGE_REFUSED_REASON}`,
        "dependabot",
      ),
    ).toBe("マージできない理由(競合や保護)を確認してください");
  });

  test("leaves the next action for the other flows unchanged", () => {
    expect(nextActionFor("Claude failed")).toContain("retry_work_item");
  });
});
