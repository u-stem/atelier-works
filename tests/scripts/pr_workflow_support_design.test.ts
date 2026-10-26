// 設計工程が`needs_human`にする理由を、通知が日本語で訳し、次の操作を案内することを確かめる。

import { describe, expect, test } from "bun:test";
import { DESIGN_START_FAILED_REASON } from "../../f/factory/lib/design_launch_support.ts";
import {
  DESIGN_DOC_DIR_IN_USE_REASON,
  designGapExhaustedReason,
  designNoApprovalReason,
} from "../../f/factory/lib/design_template.ts";
import {
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  REQUIREMENTS_MODIFIED_REASON,
} from "../../f/factory/lib/doc_tree_hash.ts";
import {
  describeReason,
  designNeedsHumanFields,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const RETRY = "f/factory/retry_work_item";
const RELABEL = "`factory`ラベルを付け直";

describe("describeReason for the design stage", () => {
  test("translates a design flow that could not be started", () => {
    expect(describeReason(DESIGN_START_FAILED_REASON)).toBe(
      "設計フローを起動できませんでした",
    );
  });

  test("translates a design flow that could not be started with a detail", () => {
    expect(
      describeReason("design flow could not be started: runFlowAsync failed"),
    ).toBe("設計フローを起動できませんでした(runFlowAsync failed)");
  });

  test("translates a missing approval for the attempt", () => {
    expect(describeReason(designNoApprovalReason(2))).toContain(
      "承認済みの要件定義が無い",
    );
  });

  test("names the attempt that has no approval", () => {
    expect(describeReason(designNoApprovalReason(2))).toContain("2");
  });

  test("translates a requirements gap after max_attempts", () => {
    expect(describeReason(designGapExhaustedReason(3))).toBe(
      "設計が要件の不足を報告しましたが、要件定義の試行回数が上限(3)に達しました",
    );
  });

  test("translates a change before design", () => {
    expect(
      describeReason(REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON),
    ).toContain("設計を始める前");
  });

  test("translates a change during design", () => {
    expect(describeReason(REQUIREMENTS_MODIFIED_REASON)).toContain(
      "設計の実行中",
    );
  });

  test("translates a change before implementation", () => {
    expect(
      describeReason(REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON),
    ).toContain("実装");
  });

  test("translates a missing requirements directory apart from a change", () => {
    expect(describeReason(REQUIREMENTS_DIR_MISSING_REASON)).toContain(
      "ディレクトリがありません",
    );
  });

  test("translates a design directory that already holds a draft", () => {
    expect(describeReason(DESIGN_DOC_DIR_IN_USE_REASON)).toContain("下書き");
  });
});

describe("nextActionFor for the design stage", () => {
  test("tells how to retry a design flow that could not be started", () => {
    expect(nextActionFor(DESIGN_START_FAILED_REASON, "design")).toContain(
      RETRY,
    );
  });

  test("tells to check the approval when the attempt has none", () => {
    expect(nextActionFor(designNoApprovalReason(2))).toContain("承認");
  });

  test("tells a person to tidy the requirements after the attempts ran out", () => {
    expect(nextActionFor(designGapExhaustedReason(3))).toContain("Issueに追記");
  });

  test.each([
    ["before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["during design", REQUIREMENTS_MODIFIED_REASON],
    ["before implementation", REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
  ])("tells to make the requirements again for %s", (_name, reason) => {
    expect(nextActionFor(reason)).toContain(RELABEL);
  });

  test.each([
    ["before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["during design", REQUIREMENTS_MODIFIED_REASON],
    ["before implementation", REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
  ])("does not tell to retry the work item for %s", (_name, reason) => {
    expect(nextActionFor(reason)).not.toContain(RETRY);
  });

  test("tells how to retry a design directory that already holds a draft", () => {
    expect(nextActionFor(DESIGN_DOC_DIR_IN_USE_REASON)).toContain(RETRY);
  });

  test("tells how to retry when a process the design run left holds the worktree lock", () => {
    expect(
      nextActionFor(
        "worktree lock is held by a process this run left behind",
        "design",
      ),
    ).toContain(RETRY);
  });

  test("mentions the design run when it names the process it left", () => {
    expect(
      nextActionFor(
        "worktree lock is held by a process this run left behind",
        "design",
      ),
    ).toContain("設計");
  });

  test("tells how to retry when processes from an earlier run still use the worktree", () => {
    expect(
      nextActionFor(
        "worktree is still used by processes from an earlier run: pid 1",
        "design",
      ),
    ).toContain(RETRY);
  });
});

// 理由の表は、拒否した安全装置の依存を増やさないために、理由の文字列を直接書く。
// 生成する側の関数と定数の出力を表と突き合わせて、食い違いを検出する。
describe("the reason table and the reasons that the design stage produces", () => {
  const PRODUCED: [string, string][] = [
    ["a design flow that could not be started", DESIGN_START_FAILED_REASON],
    ["a missing approval", designNoApprovalReason(2)],
    ["an exhausted requirements gap", designGapExhaustedReason(3)],
    ["a change before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["a change during design", REQUIREMENTS_MODIFIED_REASON],
    [
      "a change before implementation",
      REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    ],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
    ["a directory that holds a draft", DESIGN_DOC_DIR_IN_USE_REASON],
  ];

  test.each(PRODUCED)("translates the reason for %s", (_name, reason) => {
    expect(describeReason(reason)).not.toBe(reason);
  });

  // 起動の失敗の案内は、ほかの失敗と同じ一般の手順なので、固有の案内の突き合わせから外す。
  const WITH_OWN_ACTION = PRODUCED.slice(1);

  test.each(WITH_OWN_ACTION)(
    "guides the next action for %s",
    (_name, reason) => {
      expect(nextActionFor(reason, "design")).not.toBe(
        nextActionFor("a reason that no rule describes", "design"),
      );
    },
  );
});

describe("designNeedsHumanFields", () => {
  const LOCK_HELD = "worktree lock is held by a process this run left behind";

  test("translates the reason", () => {
    expect(designNeedsHumanFields(designNoApprovalReason(2)).reason).toBe(
      describeReason(designNoApprovalReason(2)),
    );
  });

  test("guides the next action of the design flow", () => {
    expect(designNeedsHumanFields(LOCK_HELD).next_action).toBe(
      nextActionFor(LOCK_HELD, "design"),
    );
  });

  test("does not tell a design run to rerun the checks of the implement flow", () => {
    expect(designNeedsHumanFields(LOCK_HELD).next_action).not.toContain(
      "検査コマンド",
    );
  });
});

// 通知の組み立てはWindmillの入出力を含むmainの中にあるので、結線はソースの文面で固定する。
describe("the wiring of the design notifications", () => {
  test.each(["design_generate.ts", "design_prepare.ts"])(
    "%s builds the reason and next action through the design flow",
    async (name) => {
      const text = await Bun.file(
        new URL(`../../f/factory/steps/${name}`, import.meta.url),
      ).text();
      expect(text).toMatch(/\.\.\.designNeedsHumanFields\(reason\)/);
    },
  );
});
