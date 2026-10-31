import { describe, expect, test } from "bun:test";
import { GENERIC_NOTICE_GUIDE, noticeGuide } from "./noticeGuide.ts";

describe("noticeGuide", () => {
  test("explains a known kind", () => {
    expect(noticeGuide("cleanup_db_failed").meaning).toBe(
      "保持期間を過ぎたレコードの削除に失敗しました。",
    );
  });

  // 通知本文の待ちの分数は`f/factory/lib/periodic_worker.ts`の`PERIODIC_JOB_WAIT_SECONDS`(780秒)から作る。
  // f/はConsoleからimportできないので、分数を直書きして一致を固定する。
  test("states the same wait minutes as the periodic worker notice", () => {
    expect(noticeGuide("periodic_worker_missing").meaning).toContain(
      "予定時刻から13分以上",
    );
  });

  test("explains the threshold of a stale GitHub collection", () => {
    expect(noticeGuide("github_collect_stale").meaning).toContain("25分");
  });

  test("points a stale GitHub collection to the run record", () => {
    expect(noticeGuide("github_collect_stale").action).toContain(
      "実行の記録の読み方",
    );
  });

  test("reads the run record of the owner only", () => {
    expect(noticeGuide("github_collect_stale").commands[0]).toContain(
      "WHERE owner = '<所有者>' AND finished_at IS NOT NULL",
    );
  });

  test("explains the notice for repositories that are stale while the owner succeeds", () => {
    expect(noticeGuide("github_collect_stale").meaning).toContain(
      "のリポジトリ:",
    );
  });

  test("does not claim what the downstream does with a stale repository", () => {
    expect(noticeGuide("github_collect_stale").meaning).not.toContain("見送");
  });

  test("states that a stale record cannot be used downstream", () => {
    expect(noticeGuide("github_collect_stale").meaning).toContain(
      "下流の判断に使えません",
    );
  });

  test("tells to narrow the repositories for a stale repository", () => {
    expect(noticeGuide("github_collect_stale").action).toContain(
      "repo_allowlist",
    );
  });

  test("reads the repositories of the owner", () => {
    expect(
      noticeGuide("github_collect_stale").commands.some((command) =>
        command.includes("FROM factory.gh_repos WHERE owner = '<所有者>'"),
      ),
    ).toBe(true);
  });

  test("explains the notice for a disabled collection", () => {
    expect(noticeGuide("github_collect_stale").meaning).toContain(
      "の収集の無効:",
    );
  });

  test("says the disabled collection notice stays even when the owner collection succeeds", () => {
    expect(noticeGuide("github_collect_stale").meaning).toContain(
      "所有者の収集が成功しても解決せず",
    );
  });

  test("names the settings that disable the collection", () => {
    expect(noticeGuide("github_collect_stale").meaning).toContain(
      "gh_collect_detail_enabled",
    );
  });

  test("tells to list the repositories before keeping the collection off", () => {
    expect(noticeGuide("github_collect_stale").action).toContain(
      "repo_allowlistに必要なリポジトリを並べて",
    );
  });

  test("tells when the disabled collection notice resolves", () => {
    expect(noticeGuide("github_collect_stale").note).toContain(
      "repo_allowlistが空でなくなったとき",
    );
  });

  test("does not promise a future halt of the Factory", () => {
    expect(noticeGuide("github_collect_stale").meaning).not.toContain("まだ");
  });

  test("tells how the stale GitHub collection notice resolves", () => {
    expect(noticeGuide("github_collect_stale").note).toContain("自動で解決");
  });

  // 通知本文の待ちの分数は`f/factory/lib/default_worker.ts`の`DEFAULT_WORKER_WAIT_SECONDS`(600秒)から作る。
  test("states the same wait minutes as the default worker notice", () => {
    expect(noticeGuide("default_worker_missing").meaning).toContain(
      "予定時刻から10分以上",
    );
  });

  test("tells the operator to run mise run up for a missing default worker", () => {
    expect(noticeGuide("default_worker_missing").action).toContain(
      "mise run up",
    );
  });

  // 検出器が成功していないと見なす時間は`f/factory/lib/schedule_detector_heartbeat.ts`の`SCHEDULE_DETECTOR_STALE_MS`(25分)から作る。
  test("states the same minutes as the schedule detector notice", () => {
    expect(noticeGuide("schedule_detector_stale").meaning).toContain("25分");
  });

  test("tells the operator to read the jobs of the schedule detector", () => {
    expect(noticeGuide("schedule_detector_stale").action).toContain(
      "detect_schedule_failures",
    );
  });

  test("points the failed schedule check to the detector, not to the removed handler", () => {
    expect(noticeGuide("schedule_failing_check_failed").action).toContain(
      "detect_schedule_failures",
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

  test("tells how to resolve the merge conflict of a pull request", () => {
    expect(noticeGuide("pr_conflict").action).toContain("mergeして");
  });

  test("tells that the merge conflict notice is resolved automatically", () => {
    expect(noticeGuide("pr_conflict").note).toContain("自動で解決");
  });

  test("tells how to get back to posting reviews", () => {
    expect(noticeGuide("review_gated_prolonged").action).toContain(
      "comment_only",
    );
  });

  test("tells that the notice comes back while gated continues", () => {
    expect(noticeGuide("review_gated_prolonged").note).toContain("解決");
  });

  test("tells how to see and release the hold that makes pull requests wait", () => {
    expect(noticeGuide("dependabot_merge_held").action).toContain(
      "mise run hold:list",
    );
  });

  test("tells that the hold can be released from the system screen", () => {
    expect(noticeGuide("dependabot_merge_held").action).toContain(
      "システムの画面",
    );
  });

  test("explains who released the hold in a notice of the release", () => {
    expect(noticeGuide("hold_released").meaning).toContain("解除");
  });

  test("tells that a release needs no action", () => {
    expect(noticeGuide("hold_released").action).toContain("心当たり");
  });

  test("tells that the waiting pull requests resume by themselves", () => {
    expect(noticeGuide("dependabot_merge_held").note).toContain("自動で再開");
  });

  test("tells what to check when the holds cannot be read", () => {
    expect(noticeGuide("dependabot_merge_hold_unreadable").action).toContain(
      "migration",
    );
  });

  test("tells that the unreadable notice resolves by itself", () => {
    expect(noticeGuide("dependabot_merge_hold_unreadable").note).toContain(
      "自動で解決",
    );
  });

  test("tells where to see the load behind the worker load alert", () => {
    expect(noticeGuide("worker_load_high").action).toContain("システム");
  });

  test("tells how to tune the worker load alert", () => {
    expect(noticeGuide("worker_load_high").note).toContain(
      "worker_alert_memory_ratio",
    );
  });

  test("tells how to read the failed run of the pull request CI", () => {
    expect(noticeGuide("pr_ci_failed").action).toContain("実行のログ");
  });

  test("tells how to fix a failed metadata job of the pull request CI", () => {
    expect(noticeGuide("pr_ci_failed").action).toContain("mise run metadata");
  });

  test("tells that the pull request CI notice carries the reason the automatic fix was held", () => {
    expect(noticeGuide("pr_ci_failed").meaning).toContain(
      "自動修正の保留の理由",
    );
  });

  test("tells to follow the next action of the hold reason when the notice has one", () => {
    expect(noticeGuide("pr_ci_failed").action).toContain(
      "保留の理由が載っていなければ",
    );
  });

  test("tells that a failure the automatic fix repaired is not notified", () => {
    expect(noticeGuide("pr_ci_failed").note).toContain("直せた失敗");
  });

  test("tells which settings to review for the time setting misfit", () => {
    expect(noticeGuide("config_misfit").action).toContain("claude_timeout_sec");
  });

  test("tells that disabling only the automatic fix still resolves the time setting misfit", () => {
    expect(noticeGuide("config_misfit").note).toContain("自動修正だけを無効");
  });

  test("tells that the time setting misfit is resolved once the settings fit", () => {
    expect(noticeGuide("config_misfit").note).toContain("自動で解決");
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

  test("tells the owner id mismatch skips the discovery of the owner", () => {
    expect(noticeGuide("owner_id_mismatch").meaning).toContain(
      "このオーナーの発見は飛ばし",
    );
  });

  test("tells the discovery resumes once the owner id matches", () => {
    expect(noticeGuide("owner_id_mismatch").note).toContain(
      "次の回から発見が再開します",
    );
  });

  test("does not call the discovery of the owner a search", () => {
    const guide = noticeGuide("owner_id_mismatch");

    expect(`${guide.meaning}${guide.note ?? ""}`.includes("検索")).toBe(false);
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

  test("explains the draft saved without the baseline hash", () => {
    expect(noticeGuide("doc_hash_column_missing")).not.toBe(
      GENERIC_NOTICE_GUIDE,
    );
  });

  test("tells that the self update applies the migration of the baseline column", () => {
    expect(noticeGuide("doc_hash_column_missing").action).toContain("自己更新");
  });

  test("tells to recreate the requirements that must be protected", () => {
    expect(noticeGuide("doc_hash_column_missing").action).toContain(
      "作り直して",
    );
  });

  test("explains the design setting that is read as false", () => {
    expect(noticeGuide("design_enabled_ignored")).not.toBe(
      GENERIC_NOTICE_GUIDE,
    );
  });

  test("tells to put design_enabled back to false", () => {
    expect(noticeGuide("design_enabled_ignored").action).toContain("falseに戻");
  });

  test("tells to write design_enabled_since to open the design stage", () => {
    expect(noticeGuide("design_enabled_ignored").action).toContain(
      "design_enabled_sinceを書",
    );
  });

  test("gives the format of design_enabled_since", () => {
    expect(noticeGuide("design_enabled_ignored").action).toContain(
      "2026-11-01T00:00:00Z",
    );
  });

  test("names the missing design_enabled_since as the cause", () => {
    expect(noticeGuide("design_enabled_ignored").meaning).toContain(
      "design_enabled_since",
    );
  });

  test("does not say that the design stage cannot be opened yet", () => {
    expect(noticeGuide("design_enabled_ignored").meaning).not.toContain(
      "まだ有効にできない",
    );
  });

  test("says that the config tab shows the value that is in effect", () => {
    expect(noticeGuide("design_enabled_ignored").meaning).toContain(
      "設定タブには効いている値が出ます",
    );
  });

  test("does not say that the config tab shows the written value", () => {
    expect(noticeGuide("design_enabled_ignored").meaning).not.toContain(
      "書かれた値のtrueが出ます",
    );
  });

  test("tells that the self update resolves the design setting notice", () => {
    expect(noticeGuide("design_enabled_ignored").note).toContain("自動で解決");
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

  test("tells that an account with a configured id is denied when the id differs", () => {
    expect(noticeGuide("labeler_denied").meaning).toContain(
      "IDを入れたアカウントは、名前が同じでもIDが違う人",
    );
  });

  test("tells that an account without a configured id is matched by name only", () => {
    expect(noticeGuide("labeler_denied").meaning).toContain(
      "IDを入れていないアカウントは、名前だけで照合します",
    );
  });

  test("tells to check the configured id when the allowed person is denied", () => {
    expect(noticeGuide("labeler_denied").action).toContain(
      "allowed_labeler_idsのIDが合っているか",
    );
  });

  test("gives the command that looks up an account id", () => {
    expect(noticeGuide("labeler_denied").commands).toEqual([
      "gh api users/<ログイン名> --jq .id",
    ]);
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
