// `pr_fix_prepare.ts`が使う`pr_workflow_support.ts`の`evaluatePrFixSafetyGuards`、
// `evaluateFixRoundGuard`、`prFixTimeoutMisfit`のテスト。
// あわせて`describeReason`もテストする。これは検査の`reason`を表示用の日本語に
// 置き換える関数で、`pr_fix_finish.ts`、`pr_review_generate.ts`、`pipeline_*.ts`が
// GitHubのコメントやDiscordの通知を作るときに使う。

import { describe, expect, test } from "bun:test";
import { RUNNER_MAX_STOP_OVERHEAD_MS } from "../../f/factory/lib/workspace.ts";
import {
  describeReason,
  earlyExitBase,
  evaluateBranchImplementingGuard,
  evaluateFixRoundGuard,
  evaluateParentImplementingGuard,
  evaluatePrFixSafetyGuards,
  evaluateRepoAllowedGuard,
  nextActionFor,
  PR_COMMAND_STOP_OVERHEAD_SEC,
  prFixTimeoutMisfit,
} from "../../f/factory/steps/pr_workflow_support.ts";

const SAFE_INPUT = {
  open: true,
  headRepoFullName: "octo-owner/atelier-works",
  baseRepoFullName: "octo-owner/atelier-works",
  draft: false,
  baseProtected: false,
};

describe("evaluatePrFixSafetyGuards", () => {
  test("passes when every guard is satisfied", () => {
    expect(evaluatePrFixSafetyGuards(SAFE_INPUT)).toEqual({ ok: true });
  });

  test("fails when the PR is not open", () => {
    const result = evaluatePrFixSafetyGuards({ ...SAFE_INPUT, open: false });
    expect(result.ok).toBe(false);
  });

  test("fails when the head repo differs from the base repo (fork)", () => {
    const result = evaluatePrFixSafetyGuards({
      ...SAFE_INPUT,
      headRepoFullName: "someone-else/atelier-works",
    });
    expect(result.ok).toBe(false);
  });

  test("fails when the head repo is null (deleted fork)", () => {
    const result = evaluatePrFixSafetyGuards({
      ...SAFE_INPUT,
      headRepoFullName: null,
    });
    expect(result.ok).toBe(false);
  });

  test("fails when the PR is a draft", () => {
    const result = evaluatePrFixSafetyGuards({ ...SAFE_INPUT, draft: true });
    expect(result.ok).toBe(false);
  });

  test("fails when the base branch is protected", () => {
    const result = evaluatePrFixSafetyGuards({
      ...SAFE_INPUT,
      baseProtected: true,
    });
    expect(result.ok).toBe(false);
  });

  test("reports the not-open reason first when multiple guards fail", () => {
    const result = evaluatePrFixSafetyGuards({
      ...SAFE_INPUT,
      open: false,
      draft: true,
    });
    expect(!result.ok && result.reason).toContain("open");
  });
});

describe("evaluateFixRoundGuard", () => {
  test("passes when fix_round is below the max", () => {
    expect(evaluateFixRoundGuard(1, 3)).toEqual({ ok: true });
  });

  test("passes when fix_round equals the max", () => {
    expect(evaluateFixRoundGuard(3, 3)).toEqual({ ok: true });
  });

  test("fails when fix_round exceeds the max", () => {
    const result = evaluateFixRoundGuard(4, 3);
    expect(result.ok).toBe(false);
  });
});

describe("evaluateRepoAllowedGuard", () => {
  test("passes when the repo is allowed", () => {
    expect(evaluateRepoAllowedGuard(true)).toEqual({ ok: true });
  });

  test("fails when the repo is not allowed", () => {
    const result = evaluateRepoAllowedGuard(false);
    expect(result.ok).toBe(false);
  });
});

describe("evaluateParentImplementingGuard", () => {
  test("passes without a parent work item", () => {
    expect(evaluateParentImplementingGuard(null)).toEqual({ ok: true });
  });

  test("passes when the parent is not implementing", () => {
    expect(evaluateParentImplementingGuard("pr_open")).toEqual({ ok: true });
  });

  test("blocks while the parent issue is being re-implemented", () => {
    expect(evaluateParentImplementingGuard("implementing")).toEqual({
      ok: false,
      reason: "parent issue is being re-implemented",
    });
  });
});

describe("evaluateBranchImplementingGuard", () => {
  test("passes without a work item for the branch", () => {
    expect(evaluateBranchImplementingGuard(null)).toEqual({ ok: true });
  });

  test("passes when the branch's work item is not implementing", () => {
    expect(evaluateBranchImplementingGuard("pr_open")).toEqual({ ok: true });
  });

  test("blocks while the branch's work item is implementing", () => {
    expect(evaluateBranchImplementingGuard("implementing")).toEqual({
      ok: false,
      reason: "implementation of the branch's work item is running",
    });
  });
});

describe("prFixTimeoutMisfit", () => {
  const FOUR_CHECKS = ["bun test", "bun run lint", "bun run typecheck", "x"];

  test("accepts the defaults with four check commands", () => {
    expect(
      prFixTimeoutMisfit({
        claude_timeout_sec: 1800,
        allowed_check_commands: FOUR_CHECKS,
      }),
    ).toBeNull();
  });

  test("rejects five check commands with the defaults", () => {
    expect(
      prFixTimeoutMisfit({
        claude_timeout_sec: 1800,
        allowed_check_commands: [...FOUR_CHECKS, "y"],
      }),
    ).toBe(
      "pr_fix time settings do not fit the flow step timeout: (2 claude runs + 2 x 5 check commands) x (claude_timeout_sec 1800 + 15) + 600 = 22380s exceeds 21600s",
    );
  });

  test("accepts the largest Claude timeout that fits four check commands in the verify step", () => {
    expect(
      prFixTimeoutMisfit({
        claude_timeout_sec: 2085,
        allowed_check_commands: FOUR_CHECKS,
      }),
    ).toBeNull();
  });

  test("rejects a Claude timeout one second over the verify step with four check commands", () => {
    expect(
      prFixTimeoutMisfit({
        claude_timeout_sec: 2086,
        allowed_check_commands: FOUR_CHECKS,
      }),
    ).toBe(
      "pr_fix time settings do not fit the flow step timeout: (2 claude runs + 2 x 4 check commands) x (claude_timeout_sec 2086 + 15) + 600 = 21610s exceeds 21600s",
    );
  });

  test("rejects a Claude timeout that cannot fit in the apply step", () => {
    expect(
      prFixTimeoutMisfit({
        claude_timeout_sec: 3286,
        allowed_check_commands: [],
      }),
    ).toBe(
      "pr_fix time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
    );
  });

  test("accepts the largest Claude timeout that fits in the apply step", () => {
    expect(
      prFixTimeoutMisfit({
        claude_timeout_sec: 3285,
        allowed_check_commands: [],
      }),
    ).toBeNull();
  });

  test("does not contain the separator describeReason splits on", () => {
    expect(
      prFixTimeoutMisfit({
        claude_timeout_sec: 1800,
        allowed_check_commands: [...FOUR_CHECKS, "y"],
      }),
    ).not.toContain("; ");
  });
});

describe("PR_COMMAND_STOP_OVERHEAD_SEC", () => {
  test("covers the runner's worst stop overhead", () => {
    expect(PR_COMMAND_STOP_OVERHEAD_SEC * 1000).toBeGreaterThanOrEqual(
      RUNNER_MAX_STOP_OVERHEAD_MS,
    );
  });
});

describe("describeReason", () => {
  test("translates time settings that do not fit the pr_fix step timeouts", () => {
    expect(
      describeReason(
        "pr_fix time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
      ),
    ).toBe(
      "PR修正の時間設定が、flow.yamlの修正・検証ステップのtimeoutに収まりません(2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s)",
    );
  });

  test("translates a static safety-guard reason", () => {
    expect(describeReason("pull request is a draft")).toBe("PRがドラフトです");
  });

  test("translates a dynamic fix-round-exhausted reason, keeping the numbers", () => {
    expect(describeReason("fix_round 4 exceeds max_fix_rounds 3")).toBe(
      "fix_round 4がmax_fix_rounds 3を超えました",
    );
  });

  test("translates each entry of a semicolon-joined forbidden-change reason list", () => {
    expect(
      describeReason(
        'forbidden path changed: .github/workflows/ci.yml; package.json "scripts" field changed',
      ),
    ).toBe(
      "変更が禁止されたパスです: .github/workflows/ci.yml; package.jsonの`scripts`が変更されました",
    );
  });

  test("passes an unrecognized reason through unchanged", () => {
    expect(describeReason("some future guard reason nobody mapped yet")).toBe(
      "some future guard reason nobody mapped yet",
    );
  });

  // `pr_fix_finish.ts`は`nothing_to_commit`のときも溜めた返信を投稿するため、
  // Discordに載せる理由は両方をつないだものになる。
  test("translates each entry of the nothing_to_commit reason", () => {
    expect(describeReason("no changes to commit; replies posted")).toBe(
      "コミットする変更がありませんでした; 返信は投稿済みです",
    );
  });

  // `buildIssueProposalReason`の文は最初から日本語なので、
  // `describeReason`は件数も含めてそのまま返す。
  test("passes the issue-proposal reason through unchanged (already Japanese)", () => {
    expect(describeReason("Issue化の提案が2件あります")).toBe(
      "Issue化の提案が2件あります",
    );
  });

  test("translates the diff-size reason for the pr_fix config key, keeping the key and numbers", () => {
    expect(
      describeReason("changed file count 31 exceeds max_fix_changed_files 30"),
    ).toBe("変更ファイル数31がmax_fix_changed_files 30を超えました");
  });

  test("translates the diff-size reason for the implement config key too", () => {
    expect(
      describeReason(
        "diff line total 3001 exceeds implement_max_diff_lines 3000",
      ),
    ).toBe("diffの総行数3001がimplement_max_diff_lines 3000を超えました");
  });

  test("translates a push rejected for a PAT without the workflow scope, wherever the phrase appears", () => {
    expect(
      describeReason(
        "git push failed: ! [remote rejected] factory/issue-7-wi-3 -> factory/issue-7-wi-3 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
      ),
    ).toBe(
      "PATに`workflow`スコープが無いため、`.github/workflows/**`を含むpushが拒否されました",
    );
  });
});

describe("nextActionFor", () => {
  // `needs_human`のDiscord通知の「次の操作」欄は、すべてこの関数が作る。
  // `describeReason`のように"; "で区切った全区間をつながず、1区間の操作だけを選ぶ理由は、
  // この関数のコメントを参照。
  test("asks to fix the pr_fix time settings", () => {
    expect(
      nextActionFor(
        "pr_fix time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
      ),
    ).toBe(
      "claude_timeout_secか検査コマンド(allowed_check_commands)の数を減らしてから、`factory:fix`を付け直してください",
    );
  });

  test("tells the operator to reopen or withdraw when the PR is not open", () => {
    expect(nextActionFor("pull request is not open")).toBe(
      "PRを再オープンするか、この作業を取り下げてください",
    );
  });

  test("tells the operator to re-apply factory:fix when there is no actionable feedback", () => {
    expect(
      nextActionFor(
        "no actionable feedback since the last processed review/comment",
      ),
    ).toBe(
      "対応してほしい指摘をコメントしてから`factory:fix`を付け直してください",
    );
  });

  test("tells the operator to check the Inbox when approval timed out", () => {
    expect(nextActionFor("approval timed out")).toBe(
      "Inboxで承認または却下してください",
    );
  });

  test("picks the first segment's action for a semicolon-joined reason", () => {
    expect(nextActionFor("no changes to commit; replies posted")).toBe(
      "返信内容を確認し、必要なら指示をコメントして`factory:fix`を付け直してください",
    );
  });

  test("falls back to pointing at the Console for an unrecognized reason", () => {
    expect(nextActionFor("some future guard reason nobody mapped yet")).toBe(
      "通知の理由とConsoleのNoticesタブで原因を確かめ、取り除いてから、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("tells the operator to decide in the Inbox for an issue-proposal reason", () => {
    expect(nextActionFor("Issue化の提案が1件あります")).toBe(
      "ConsoleのInboxで提案を承認または却下してください",
    );
  });

  test("tells the operator to add the workflow scope when a push was rejected for lacking it", () => {
    expect(
      nextActionFor(
        "git push failed: refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
      ),
    ).toBe(
      "PATにWorkflows(Read and write)権限を追加するか、ワークフローファイルの変更を人がpushしてください",
    );
  });
});

describe("earlyExitBase", () => {
  const workItem = {
    owner: "octo-owner",
    repo: "sample-repo",
    pr_number: 3,
    head_sha: "abc1234",
    parent_work_item_id: null,
    attempt: 1,
    fix_round: 4,
  };

  test("keeps the PR coordinates so pr_fix_finish can relabel the PR", () => {
    expect(earlyExitBase(workItem).pr_number).toBe(3);
  });

  test("keeps the repository owner", () => {
    expect(earlyExitBase(workItem).owner).toBe("octo-owner");
  });

  test("leaves the worktree directory empty because none was prepared", () => {
    expect(earlyExitBase(workItem).worktree_dir).toBe("");
  });

  test("records no .git pointer when no worktree was prepared", () => {
    expect(earlyExitBase(workItem).worktree_git_pointer).toBeNull();
  });

  test("records no branch when no worktree was prepared", () => {
    expect(earlyExitBase(workItem).branch).toBe("");
  });
});

describe("describeReason (implement flow)", () => {
  test("translates the max-rounds exit", () => {
    expect(
      describeReason("implement checks still failing after 5 rounds"),
    ).toBe("5ラウンド修正しても検査に通りませんでした");
  });

  test("translates the stall exit", () => {
    expect(describeReason("implement stalled after round 2")).toBe(
      "ラウンド2で修正が停滞しました(差分か検査結果が前のラウンドと同じです)",
    );
  });

  test("translates a Claude run failure", () => {
    expect(
      describeReason("claude run failed (timeout): claude -p timed out"),
    ).toBe("Claudeの実行に失敗しました(timeout): claude -p timed out");
  });

  test("translates a missing approval", () => {
    expect(describeReason("no approved requirements for attempt 2")).toBe(
      "attempt 2の承認済み要件定義が見つかりません",
    );
  });

  test("translates a moved branch head", () => {
    expect(
      describeReason(
        `branch head moved to ${"b".repeat(40)} while implementing`,
      ),
    ).toBe(`実装中にブランチのheadが${"b".repeat(40)}に変わりました`);
  });

  test("translates a finish failure", () => {
    expect(describeReason("implement finish failed: HTTP 422")).toBe(
      "コミット・push・PRの作成に失敗しました: HTTP 422",
    );
  });

  test("keeps the workflow-scope rule first for a finish failure it explains", () => {
    expect(
      describeReason(
        "implement finish failed: git push failed: ! [remote rejected] (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
      ),
    ).toBe(
      "PATに`workflow`スコープが無いため、`.github/workflows/**`を含むpushが拒否されました",
    );
  });

  test("translates an implementation without changes", () => {
    expect(describeReason("implement produced no changes")).toBe(
      "実装が変更を生みませんでした",
    );
  });

  test("translates exhausted requirements attempts", () => {
    expect(describeReason("requirements_gap after max_attempts 3")).toBe(
      "要件の不足が報告されましたが、要件定義の試行回数が上限(3)に達しました",
    );
  });

  test("translates a launch failure", () => {
    expect(describeReason("implement flow could not be started: boom")).toBe(
      "実装フローを起動できませんでした: boom",
    );
  });

  test("translates an unrecorded flow job id", () => {
    expect(
      describeReason("implement flow job id could not be recorded: boom"),
    ).toBe("実装フローのジョブIDを記録できませんでした: boom");
  });

  test("translates secrets that blocked the push", () => {
    expect(describeReason("secrets detected, changes not pushed")).toBe(
      "秘密情報らしき文字列を検出したため、変更をpushしていません",
    );
  });

  test("translates partial work kept local for an open PR", () => {
    expect(
      describeReason("partial work kept local because a pull request is open"),
    ).toBe("PRがあるため途中の変更はpushせずworktreeに残しました");
  });

  test("translates a worktree changed after verification", () => {
    expect(describeReason("worktree changed after verification")).toBe(
      "検証の後にworktreeが変更されました",
    );
  });

  test("translates a worktree changed before the secret scan of a round", () => {
    expect(
      describeReason("worktree changed before the secret scan in round 2"),
    ).toBe(
      "ラウンド2で、変更の判定と秘密情報の検査の間にworktreeが変更されました",
    );
  });

  test("translates a committed tree that differs from the inspected one", () => {
    expect(
      describeReason("committed tree differs from the inspected tree"),
    ).toBe("commitしたツリーが、検査したツリーと異なります");
  });

  test("translates a worktree changed after the secret scan", () => {
    expect(describeReason("worktree changed after the secret scan")).toBe(
      "秘密情報の検査の後にworktreeが変更されました",
    );
  });

  test("shows an escaped Claude failure as one reason item", () => {
    expect(
      describeReason(
        "claude run failed (claude_error): x, implement time settings do not fit the flow step timeout: y",
      ),
    ).toBe(
      "Claudeの実行に失敗しました(claude_error): x, implement time settings do not fit the flow step timeout: y",
    );
  });

  test("translates a modified worktree .git pointer", () => {
    expect(describeReason("worktree git pointer was modified")).toBe(
      "worktreeのgitの参照先(.gitファイル)が書き換えられました",
    );
  });

  test("translates a .git pointer that was not recorded", () => {
    expect(describeReason("worktree git pointer was not recorded")).toBe(
      "worktreeのgitの参照先(.gitファイル)が記録されていません",
    );
  });

  test("translates a PR head that was not recorded", () => {
    expect(describeReason("PR head was not recorded")).toBe(
      "PRのheadが記録されていません",
    );
  });

  test("translates a local HEAD that moved off the recorded branch head", () => {
    expect(
      describeReason(
        `local HEAD ${"b".repeat(40)} is not the PR head ${"a".repeat(40)}`,
      ),
    ).toBe(
      `worktreeのHEAD(${"b".repeat(40)})が記録したブランチの先頭(${"a".repeat(40)})と異なります`,
    );
  });

  test("translates a local HEAD on another branch", () => {
    expect(describeReason("local HEAD is not on branch fix/x")).toBe(
      "worktreeのHEADがブランチfix/xにありません",
    );
  });

  test("translates a changed path that is not a regular file", () => {
    expect(describeReason("not a regular file: fifo")).toBe(
      "通常のファイルではないものが変更されました: fifo",
    );
  });

  test("translates a nested repository path", () => {
    expect(
      describeReason("nested repository or .git path changed: vendor/x/"),
    ).toBe("入れ子のリポジトリか.gitのパスが変更されました: vendor/x/");
  });

  test("asks to check the check commands after HEAD moved", () => {
    expect(nextActionFor("local HEAD is not on branch fix/x")).toBe(
      "検査コマンドがコミットやブランチの切り替えをしていないか確かめて人が直してから、PRの修正なら`factory:fix`を付け直し、実装ならWindmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("translates an active fix run on the PR", () => {
    expect(describeReason("pull request has an active fix run")).toBe(
      "このPRで自動修正が実行中のため実装を止めました",
    );
  });

  test("translates a parent issue being re-implemented", () => {
    expect(describeReason("parent issue is being re-implemented")).toBe(
      "親Issueの実装をやり直している最中のため修正を止めました",
    );
  });

  test("translates a requirements regeneration that could not start", () => {
    expect(
      describeReason("requirements regeneration could not be started"),
    ).toBe("要件定義の作り直しを起動できませんでした");
  });

  test("translates a worktree still used by an earlier run", () => {
    expect(
      describeReason("worktree is still used by processes from an earlier run"),
    ).toBe("前の実行のプロセスがまだworktreeを使っています");
  });

  test("keeps the holders when translating a busy worktree", () => {
    expect(
      describeReason(
        "worktree is still used by processes from an earlier run: pid 42 (3600s, pr_fix:9:job-c) `claude -p`",
      ),
    ).toBe(
      "前の実行のプロセスがまだworktreeを使っています(pid 42 (3600s, pr_fix:9:job-c) `claude -p`)",
    );
  });

  test("translates a lock this run left held", () => {
    expect(
      describeReason("worktree lock is held by a process this run left behind"),
    ).toBe(
      "この実行の検査コマンドなどが残したプロセスが、worktreeのロックを持ち続けています",
    );
  });

  test("translates an implementation running on the PR's branch", () => {
    expect(
      describeReason("implementation of the branch's work item is running"),
    ).toBe("このPRのブランチで実装フローが実行中のため修正を止めました");
  });

  test("translates the deadline that stopped the fix rounds", () => {
    expect(
      describeReason("implement flow deadline reached after round 3"),
    ).toBe(
      "実装フローの期限(implement_flow_timeout_sec)までに次の修正を終える時間が残っていないため、ラウンド3で修正をやめました",
    );
  });

  test("translates a Claude run cut by the deadline", () => {
    expect(
      describeReason(
        "claude run failed (timeout): claude -p timed out after 5ms; implement flow deadline passed during round 1",
      ),
    ).toBe(
      "Claudeの実行に失敗しました(timeout): claude -p timed out after 5ms; 実装フローの期限(implement_flow_timeout_sec)を過ぎたため、ラウンド1のClaudeの実行を打ち切りました",
    );
  });

  test("translates time settings that do not fit the step timeout", () => {
    expect(
      describeReason(
        "implement time settings do not fit the flow step timeout: implement_timeout_sec 21001 + 600 = 21601s exceeds 21600s",
      ),
    ).toBe(
      "実装フローの時間設定が、flow.yamlの実装・検証ステップのtimeoutに収まりません(implement_timeout_sec 21001 + 600 = 21601s exceeds 21600s)",
    );
  });
});

describe("nextActionFor (implement flow)", () => {
  test("asks to rerun a launch failure with retry_work_item", () => {
    expect(nextActionFor("implement flow could not be started: boom")).toBe(
      "Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("asks to check the branch and rerun with retry_work_item when its head moved", () => {
    expect(
      nextActionFor(
        "branch head moved to 0123456789abcdef0123456789abcdef01234567 while implementing",
      ),
    ).toBe(
      "ブランチの最新の状態を確認し、必要ならWindmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("asks for re-approval when no approval matches", () => {
    expect(nextActionFor("no approved requirements for attempt 2")).toBe(
      "要件定義を承認し直すか、Issueに`factory`ラベルを付け直してください",
    );
  });

  test("asks to revisit the requirements when nothing was implemented", () => {
    expect(nextActionFor("implement produced no changes")).toBe(
      "要件定義を見直すか、Issueを閉じてください",
    );
  });

  test("asks to clean the diff when secrets blocked the push", () => {
    expect(nextActionFor("secrets detected, changes not pushed")).toBe(
      "worktreeの差分を確認し、秘密情報を取り除いてから人が対応してください",
    );
  });

  test("asks to bring kept-local work into the PR by hand", () => {
    expect(
      nextActionFor("partial work kept local because a pull request is open"),
    ).toBe("worktreeの変更を人が確認し、必要ならPRに反映してください");
  });

  test("asks to check the check commands after a post-verification change", () => {
    expect(nextActionFor("worktree changed after verification")).toBe(
      "検査コマンドが追跡対象のファイルを書き換えていないか確認し、再実行してください",
    );
  });

  test("asks to look for leftover processes after a change before the secret scan", () => {
    expect(
      nextActionFor("worktree changed before the secret scan in round 2"),
    ).toBe(
      "検査コマンドなどが残したプロセスがworktreeを書き換えていないか確かめ、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("asks to look for leftover processes after a committed tree differs", () => {
    expect(
      nextActionFor("committed tree differs from the inspected tree"),
    ).toBe(
      "検査コマンドなどが残したプロセスがworktreeを書き換えていないか確かめ、PRの修正なら`factory:fix`を付け直し、実装ならWindmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("asks to look for leftover processes after a change following the secret scan", () => {
    expect(nextActionFor("worktree changed after the secret scan")).toBe(
      "検査コマンドなどが残したプロセスがworktreeを書き換えていないか確かめ、PRの修正なら`factory:fix`を付け直し、実装ならWindmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("asks to inspect the branch after a modified .git pointer", () => {
    expect(nextActionFor("worktree git pointer was modified")).toBe(
      "ブランチとworktreeを人が確認し、不審な変更があればブランチを削除してください",
    );
  });

  test("asks to relabel after a .git pointer that was not recorded", () => {
    expect(nextActionFor("worktree git pointer was not recorded")).toBe(
      "`factory:fix`を付け直して修正をやり直してください",
    );
  });

  test("waits for the fix run before re-running the implement flow", () => {
    expect(nextActionFor("pull request has an active fix run")).toBe(
      "自動修正の完了を待ってから、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("waits for the implement flow before re-adding factory:fix", () => {
    expect(nextActionFor("parent issue is being re-implemented")).toBe(
      "実装フローの完了を待ってから再度factory:fixを付けてください",
    );
  });

  test("asks to rerun a failed requirements regeneration with retry_work_item", () => {
    expect(
      nextActionFor("requirements regeneration could not be started"),
    ).toBe(
      "Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください(実装からやり直します。差し戻し理由は通知に残っています)",
    );
  });

  test("asks to stop the earlier run's processes and names both reruns when the flow is unknown", () => {
    expect(
      nextActionFor(
        "worktree is still used by processes from an earlier run: pid 42 (3600s, no owner) `x`",
      ),
    ).toBe(
      "理由に載ったプロセスが終わるのを待つか、workerのコンテナでそのプロセスを止めてから、PRの修正なら`factory:fix`を付け直し、実装ならWindmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("asks the implement flow to stop the earlier run's processes and rerun the work item", () => {
    expect(
      nextActionFor(
        "worktree is still used by processes from an earlier run: pid 42 (3600s, pr_fix:9:job-c) `x`",
        "implement",
      ),
    ).toBe(
      "理由に載ったプロセスが終わるのを待つか、workerのコンテナでそのプロセスを止めてから、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("asks pr_fix to stop the earlier run's processes and re-add factory:fix", () => {
    expect(
      nextActionFor(
        "worktree is still used by processes from an earlier run: pid 42 (3600s, pr_fix:9:job-c) `x`",
        "pr_fix",
      ),
    ).toBe(
      "理由に載ったプロセスが終わるのを待つか、workerのコンテナでそのプロセスを止めてから、`factory:fix`を付け直してください",
    );
  });

  test("asks to check for daemons the checks left and names both reruns when the flow is unknown", () => {
    expect(
      nextActionFor("worktree lock is held by a process this run left behind"),
    ).toBe(
      "検査コマンドが常駐プロセスを残していないか確かめ、PRの修正なら残ったプロセスをworkerのコンテナで止めてから`factory:fix`を付け直し、実装ならWindmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("tells the implement flow that a rerun stops what its own run left behind", () => {
    expect(
      nextActionFor(
        "worktree lock is held by a process this run left behind",
        "implement",
      ),
    ).toBe(
      "検査コマンドが常駐プロセスを残していないか確かめてから、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください(残ったプロセスは再実行の準備ステップが止めます)",
    );
  });

  test("asks pr_fix to stop what its run left behind before re-adding factory:fix", () => {
    expect(
      nextActionFor(
        "worktree lock is held by a process this run left behind",
        "pr_fix",
      ),
    ).toBe(
      "検査コマンドが常駐プロセスを残していないか確かめ、残っていればworkerのコンテナで止めてから、`factory:fix`を付け直してください",
    );
  });

  test("keeps the flow-independent action for other reasons when a flow is given", () => {
    expect(nextActionFor("pull request is not open", "pr_fix")).toBe(
      "PRを再オープンするか、この作業を取り下げてください",
    );
  });

  test("waits for the branch's implementation before re-adding factory:fix", () => {
    expect(
      nextActionFor("implementation of the branch's work item is running"),
    ).toBe("実装フローの完了を待ってから再度factory:fixを付けてください");
  });

  test("asks to look at the failing checks after the deadline", () => {
    expect(nextActionFor("implement flow deadline reached after round 3")).toBe(
      "失敗しているチェックを確認し、人が修正してください",
    );
  });

  test("shows the Claude failure's action when the deadline cut the run", () => {
    expect(
      nextActionFor(
        "claude run failed (timeout): claude -p timed out after 5ms; implement flow deadline passed during round 1",
      ),
    ).toBe(
      "通知の理由とConsoleのNoticesタブで原因を確かめ、取り除いてから、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("asks to fix the time settings", () => {
    expect(
      nextActionFor(
        "implement time settings do not fit the flow step timeout: implement_timeout_sec 21001 + 600 = 21601s exceeds 21600s",
      ),
    ).toBe(
      "implement_flow_timeout_sec・implement_timeout_sec・implement_check_timeout_sec・検査コマンド数のいずれかを減らしてから、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });
});

describe("describeReason / nextActionFor (GitHub rate limit)", () => {
  const RATE_LIMIT =
    "GitHub rate limit on repos/acme/widgets/pulls: needs a 3601s wait, longer than the 120s wait cap (rerun after the limit resets)";
  const RATE_LIMIT_NEXT_ACTION =
    "GitHubのrate limitの解除を待ってから、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください";

  test("translates a rate limit", () => {
    expect(describeReason(RATE_LIMIT)).toBe(
      "GitHub APIのrate limitに当たりました(repos/acme/widgets/pulls): needs a 3601s wait, longer than the 120s wait cap (rerun after the limit resets)",
    );
  });

  test("asks to wait for the reset and rerun after a rate limit", () => {
    expect(nextActionFor(RATE_LIMIT)).toBe(RATE_LIMIT_NEXT_ACTION);
  });

  test("translates the rate limit inside a finish failure", () => {
    expect(describeReason(`implement finish failed: ${RATE_LIMIT}`)).toBe(
      "コミット・push・PRの作成に失敗しました: GitHub APIのrate limitに当たりました(repos/acme/widgets/pulls): needs a 3601s wait, longer than the 120s wait cap (rerun after the limit resets)",
    );
  });

  test("asks to wait for the reset when a finish failure is a rate limit", () => {
    expect(nextActionFor(`implement finish failed: ${RATE_LIMIT}`)).toBe(
      RATE_LIMIT_NEXT_ACTION,
    );
  });

  test("keeps the generic action for a finish failure that is not a rate limit", () => {
    expect(nextActionFor("implement finish failed: HTTP 422")).toBe(
      "通知の理由とConsoleのNoticesタブで原因を確かめ、取り除いてから、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });

  test("keeps the reviewer-config action when the reviewer request hit a rate limit", () => {
    expect(nextActionFor(`failed to request reviewers: ${RATE_LIMIT}`)).toBe(
      "GitHubのレビュアー設定を確認し、必要なら再度`factory:fix`を付け直してください",
    );
  });
});
