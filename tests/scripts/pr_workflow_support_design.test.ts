// 設計工程が`needs_human`にする理由を、通知が日本語で訳し、次の操作を案内することを確かめる。

import { describe, expect, test } from "bun:test";
import { DESIGN_START_FAILED_REASON } from "../../f/factory/lib/design_launch_support.ts";
import { DESIGN_DOC_DIR_IN_USE_REASON } from "../../f/factory/lib/design_template.ts";
import {
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  REQUIREMENTS_MODIFIED_REASON,
} from "../../f/factory/lib/doc_tree_hash.ts";
import {
  describeReason,
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
    expect(
      describeReason("design requires approved requirements for attempt 2"),
    ).toContain("承認済みの要件定義が無い");
  });

  test("names the attempt that has no approval", () => {
    expect(
      describeReason("design requires approved requirements for attempt 2"),
    ).toContain("2");
  });

  test("translates a requirements gap after max_attempts", () => {
    expect(describeReason("design requirements_gap after max_attempts 3")).toBe(
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
    expect(
      nextActionFor("design requires approved requirements for attempt 2"),
    ).toContain("承認");
  });

  test("tells a person to tidy the requirements after the attempts ran out", () => {
    expect(
      nextActionFor("design requirements_gap after max_attempts 3"),
    ).toContain("Issueに追記");
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
