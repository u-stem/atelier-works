// 理由の規則の表の全体に対する検査。個々の理由ではなく、表の構造の約束を確かめる。

import { describe, expect, test } from "bun:test";
import {
  ciRoundActionOfRule,
  REASON_RULES,
} from "../../f/factory/steps/pr_workflow_support.ts";

/** 規則の`nextAction`や`ciNextAction`が、一致の中身で分岐しても全部の枝を通すための一致の結果。 */
function matchesOf(text: string): RegExpMatchArray[] {
  const match = text.match(/([\s\S]*)/);
  return match === null ? [] : [match];
}

const MATCHES = [
  ...matchesOf("x"),
  ...matchesOf("GitHub rate limit on endpoint: wait"),
  ...matchesOf("check sandbox: x"),
];

const BARE_RETRY_ACTION =
  "Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください";
const RETRY_ENDING = "retry_work_item`を作業項目のIDで実行してください";

/**
 * 手順の後に再実行を続けるが、CI回用の次の操作を持たなくてよい規則。
 * 理由はどれも、CI回が作らない(実装フローか、要件定義のフローが出す)か、
 * 人が基盤を直す手順ではなく、別の実行の完了を待つ案内である。
 * CI回では、CIの再評価を待つ一律の案内に置き換わる。
 */
const WITHOUT_CI_ACTION = [
  "^could not request re-review",
  "^claude run failed",
  "^branch head moved to",
  "^implement finished without",
  "^worktree changed before the secret scan in round",
  "^pull request has an active fix run",
  "^parent issue is being re-implemented",
  "^implementation of the branch's work item is running",
  "^implement flow deadline passed",
  "^implement time settings do not fit",
  "^design ",
  "^design ",
];

describe("REASON_RULES in a CI round", () => {
  test("never points to a retry or a relabel", () => {
    const pointing = REASON_RULES.flatMap((rule) =>
      MATCHES.map((match) => ({
        pattern: rule.pattern.source,
        action: ciRoundActionOfRule(rule, match),
      })),
    ).filter(
      ({ action }) =>
        action.includes("retry_work_item") ||
        action.includes("factory:fix") ||
        action.includes("付け直"),
    );
    expect(pointing).toEqual([]);
  });

  test("keeps the CI action of every rule that follows a procedure with a retry", () => {
    const missing = REASON_RULES.filter(
      (rule) =>
        rule.ciNextAction === undefined &&
        MATCHES.some((match) => {
          const action = rule.nextAction(match, "pr_fix");
          return action.endsWith(RETRY_ENDING) && action !== BARE_RETRY_ACTION;
        }) &&
        !WITHOUT_CI_ACTION.some((prefix) =>
          rule.pattern.source.startsWith(prefix),
        ),
    ).map((rule) => rule.pattern.source);
    expect(missing).toEqual([]);
  });
});
