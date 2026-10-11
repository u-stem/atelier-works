import { describe, expect, test } from "bun:test";
import { GENERIC_NOTICE_GUIDE, noticeGuide } from "./noticeGuide.ts";

describe("noticeGuide", () => {
  test("explains a known kind", () => {
    expect(noticeGuide("cleanup_db_failed").meaning).toBe(
      "保持期間を過ぎたレコードの削除に失敗しました。",
    );
  });

  test("tells how to approve a held draw.io viewer bump", () => {
    expect(noticeGuide("drawio_viewer_bump_held").action).toContain(
      "approved_version",
    );
  });

  test("falls back to the generic guide for an unknown kind", () => {
    expect(noticeGuide("future_kind")).toBe(GENERIC_NOTICE_GUIDE);
  });

  test("does not read inherited object keys", () => {
    expect(noticeGuide("constructor")).toBe(GENERIC_NOTICE_GUIDE);
  });

  test("tells the host operator to run the host commands in order", () => {
    expect(noticeGuide("host_action_required").commands).toEqual([
      "git pull",
      "mise install",
      "mise run up",
    ]);
  });

  test("has no commands for a kind that needs none", () => {
    expect(noticeGuide("cleanup_db_failed").commands).toEqual([]);
  });

  test("tells the operator when a host notice may be resolved by hand", () => {
    expect(noticeGuide("host_action_required").note).toContain("人が解決");
  });

  test("tells how to rerun a work item stopped for a person", () => {
    expect(noticeGuide("implement_needs_human").action).toContain(
      "f/factory/retry_work_item",
    );
  });

  test("tells when a lost claim needs no action", () => {
    expect(noticeGuide("claim_race_lost").note).toContain(
      "同じ本文の未解決の通知がある",
    );
  });

  test("tells that a denied fork notice comes back until the trigger is removed", () => {
    expect(noticeGuide("fork_head_denied").note).toContain("出直します");
  });

  test("asks the operator to check the body for an unknown kind", () => {
    expect(GENERIC_NOTICE_GUIDE.action).toContain("本文");
  });
});
