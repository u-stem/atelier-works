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

  test("tells how to read the failed run of the main CI", () => {
    expect(noticeGuide("main_ci_failed").action).toContain("実行のログ");
  });

  test("tells which permission the denied main CI check needs", () => {
    expect(noticeGuide("main_ci_check_denied").action).toContain(
      "Actions: Read",
    );
  });

  test("tells how to read the failed run of the pull request CI", () => {
    expect(noticeGuide("pr_ci_failed").action).toContain("実行のログ");
  });

  test("tells how to fix a failed metadata job of the pull request CI", () => {
    expect(noticeGuide("pr_ci_failed").action).toContain("mise run metadata");
  });

  test("tells which permission the denied pull request CI check needs", () => {
    expect(noticeGuide("pr_ci_check_denied").action).toContain("Actions: Read");
  });

  test("says a busy worktree keeps one notice open, not a new one each day", () => {
    expect(noticeGuide("cleanup_worktree_busy").action).toContain(
      "同じ通知が1件残り続けます",
    );
  });

  test("tells the factory repo id mismatch is fixed in factory_repo and factory_repo_id", () => {
    expect(noticeGuide("factory_repo_id_mismatch").action).toContain(
      "factory_repo_id",
    );
  });

  test("tells the owner id mismatch also stops the work on the repositories of the owner", () => {
    expect(noticeGuide("owner_id_mismatch").meaning).toContain(
      "リポジトリを取得せずに止めて",
    );
  });

  test("tells the owner id mismatch also covers an owner missing from owners", () => {
    expect(noticeGuide("owner_id_mismatch").meaning).toContain("ownersに無く");
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

  test("says a host notice also comes when the image is too old to run the checks", () => {
    expect(noticeGuide("host_action_required").meaning).toContain(
      "検査コマンドを実行できない",
    );
  });

  test("tells that the work items the stale image stopped restart by themselves", () => {
    expect(noticeGuide("host_action_required").action).toContain(
      "自動で再開します",
    );
  });

  test("tells to rerun by hand only after the automatic restarts are used up", () => {
    expect(noticeGuide("host_action_required").action).toContain(
      "3回の上限に達したとき",
    );
  });

  test("names the script to rerun by hand", () => {
    expect(noticeGuide("host_action_required").action).toContain(
      "f/factory/retry_work_item",
    );
  });

  test("tells that a host notice without a version is not resolved automatically", () => {
    expect(noticeGuide("host_action_required").note).toContain(
      "版が載らない通知",
    );
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

  test("points a worktree the check user still owns to the slot record cleanup", () => {
    expect(noticeGuide("cleanup_worktree_busy").action).toContain(
      "検査の枠の記録を片付ける",
    );
  });

  test("tells to close the paths or recreate the worker when the running worker is unsafe for checks", () => {
    expect(noticeGuide("check_runtime_unsafe").commands).toEqual([
      "mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker chmod o-w <パス>",
      "mise exec -- docker compose -f infra/docker-compose.yml up -d --force-recreate windmill_worker",
    ]);
  });

  test("tells that recreating the worker does not close the volume mount points", () => {
    expect(noticeGuide("check_runtime_unsafe").action).toContain(
      "/workspacesと/var/lib/factoryは、ボリュームのマウントポイントで、作り直しでは閉じないので、1つ目のコマンドで閉じてください",
    );
  });

  test("says the runtime problem does not need mise run up", () => {
    expect(noticeGuide("check_runtime_unsafe").note).toContain(
      "mise run upは要りません",
    );
  });

  test("asks the operator to check the body for an unknown kind", () => {
    expect(GENERIC_NOTICE_GUIDE.action).toContain("本文");
  });
});
