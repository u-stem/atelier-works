// implement_finishの判定と文言の組み立てを担う。
// 結果ごとの終端処理の選び方、副作用の順序、停止したループの作業の残し方、
// needs_humanの次の操作、Discordの`pr_opened`イベントを扱う。
// 入出力は注入された依存を通してだけ行う。

import { normalizeRepoUrl } from "./config.ts";
import type { NotifyEvent } from "./discord.ts";
import { ImplementLeaseLostError } from "./implement_launch_support.ts";
import {
  gitPointerStopReason,
  type ImplementContext,
  type ImplementLoopExit,
  type ImplementLoopResult,
  type ImplementPrepareOutcome,
} from "./implement_loop.ts";
import type { ImplementCheckSummary } from "./implement_support.ts";
import { escapeReasonSeparator, maskSecrets } from "./log.ts";
import { WorktreeBusyError } from "./process_lock.ts";
import {
  type CommitAndPushResult,
  CommitBlockedError,
  type GitleaksScan,
} from "./workspace.ts";

/** finishが扱う結果。prepareでの停止か、検証ループの終了のどちらか。 */
export type ImplementFinishOutcome =
  | Exclude<ImplementPrepareOutcome, "proceed">
  | ImplementLoopExit;

/**
 * prepareの結果と検証ループの終了を、finishが扱う1つの結果にまとめる。
 * prepareが`proceed`なのにループの結果が無いときは例外を投げる。
 */
export function mergeImplementOutcome(
  prepareOutcome: ImplementPrepareOutcome,
  loopExit: ImplementLoopExit | null,
): ImplementFinishOutcome {
  if (prepareOutcome !== "proceed") return prepareOutcome;
  if (loopExit === null) {
    throw new Error(
      "implement_finish: prepare proceeded but implement_verify returned no result",
    );
  }
  return loopExit;
}

export type ImplementFinishAction =
  | { readonly kind: "noop" }
  | { readonly kind: "cancel" }
  | { readonly kind: "open_pr" }
  | { readonly kind: "requirements_gap" }
  /**
   * `preserveWork`は、ループが検証を正常に回した後にガードで止まったことを表す。
   * このときは、`.git`ポインタの確認とgitleaksの検査を通れば、
   * 作業をcommitしてpushし、ブランチを確認できる状態にしてよい。
   * ただし、PRが開いているときはpushしない(`shouldPushPartialWork`)。
   */
  | { readonly kind: "needs_human"; readonly preserveWork: boolean };

/**
 * finishの結果から、行う終端処理を決める。
 * prepareがskipした実行と、検証ループがリースを失って止まった実行は何もしない。
 */
export function decideImplementFinishAction(
  outcome: ImplementFinishOutcome,
): ImplementFinishAction {
  switch (outcome) {
    case "skip":
    case "lease_lost":
      return { kind: "noop" };
    case "cancelled":
      return { kind: "cancel" };
    // worktreeができる前の停止には残す作業が無い。
    // 検証を経ていないラウンドでの停止(シンボリックリンク、Claudeの実行失敗、
    // `.git`ポインタの書き換え、判定とgitleaksの間のworktreeの変化)の後は何もpushしない。
    case "needs_human":
    case "symlink":
    case "claude_error":
    case "git_pointer_modified":
    case "worktree_changed":
      return { kind: "needs_human", preserveWork: false };
    case "checks_passed":
    case "checks_skipped":
      return { kind: "open_pr" };
    case "requirements_gap":
      return { kind: "requirements_gap" };
    case "max_rounds":
    case "daily_budget":
    case "deadline":
    case "stalled":
    case "diff_too_large":
      return { kind: "needs_human", preserveWork: true };
  }
}

/**
 * requirements_gapのとき、ブランチを削除してよいかを返す。
 * PRのheadブランチを削除するとPRが閉じるため、PRが使っていないときだけ削除する。
 * PRの検索に失敗したときは削除しない。
 */
export function shouldDeleteBranchOnGap(state: {
  readonly prUrl: string | null;
  readonly openPrNumber: number | null;
  readonly prLookupFailed: boolean;
}): boolean {
  return (
    state.prUrl === null && state.openPrNumber === null && !state.prLookupFailed
  );
}

/**
 * requirements_gapのとき、要件定義へ差し戻すか`needs_human`にするかを決める。
 * `attempt + 1`が`max_attempts`を超えるなら差し戻さない。
 * `requirements_apply`の`decideRejectedOutcome`と同じ規則である。
 */
export function decideGapReroute(
  attempt: number,
  maxAttempts: number,
): "reroute" | "needs_human" {
  return attempt < maxAttempts ? "reroute" : "needs_human";
}

/** 差し戻しの回数を使い切ったときの`needs_human`の理由を返す。 */
export function gapExhaustedReason(maxAttempts: number): string {
  return `requirements_gap after max_attempts ${String(maxAttempts)}`;
}

/**
 * requirements_gapの差し戻しか、要件定義の却下で作業項目を`requirements_generating`へ移したが、
 * パイプラインを起動できなかった(またはジョブIDを記録できなかった)ときの
 * `needs_human`の理由。
 */
export const REQUIREMENTS_REGENERATION_FAILED_REASON =
  "requirements regeneration could not be started";

/**
 * 差し戻しを起動できなかったとき、noticeとDiscordに載せる詳細を返す。
 * 再実行する人が理由を分かるよう、Claudeの差し戻し理由を秘密をマスクして残す。
 */
export function gapReportNoticeDetail(gapReport: string): string {
  return `差し戻し理由: ${maskSecrets(gapReport)}`;
}

/**
 * finishでgitやGitHubの操作が想定外に失敗したときの`needs_human`の理由を返す。
 * エラーの文にはgitのstderrやファイル名が入りうるので、理由の区切りを消す。
 */
export function finishFailureReason(err: unknown): string {
  return `implement finish failed: ${escapeReasonSeparator(maskSecrets(err instanceof Error ? err.message : String(err)))}`;
}

/**
 * implement_finishの途中経過と最終のcommitで`commitAndPush`に渡す確かめを返す。
 * ローカルのHEADが準備ステップの記録したブランチの先頭(`expected_head_sha`)で、実装ブランチにあることを求める。
 * ループはcommitしないので、HEADが動いていれば検査コマンドがcommitしたかブランチを切り替えたことになる。
 * そのcommitは差分の検査に現れず(後のcommitで消した秘密情報など)、pushすると履歴ごと送られるため、
 * pushする履歴を記録した先頭と新しい1つのcommitだけにする。
 */
export function implementCommitGuards(branch: string): {
  readonly requireLocalHeadAtExpected: true;
  readonly expectedBranch: string;
} {
  return { requireLocalHeadAtExpected: true, expectedBranch: branch };
}

/**
 * worktreeのロックを持つプロセスが残っていないかを`ensureLockFree`で確かめ、残っていれば止める理由を返す(いなければnull)。
 * `ensureLockFree`は何も止めずに`WorktreeBusyError`を投げるもの(`ensureWorktreeLockFree`の`policy: null`)を渡す。
 * 検証ステップの後に残ったClaudeや検査コマンドは、検査とcommitの間にworktreeを書き換えうるため、pushの前に呼ぶ。
 * それ以外の例外はそのまま投げる。
 */
export async function worktreeBusyStopReason(
  ensureLockFree: () => Promise<void>,
): Promise<string | null> {
  try {
    await ensureLockFree();
    return null;
  } catch (err) {
    if (err instanceof WorktreeBusyError) return err.message;
    throw err;
  }
}

/**
 * `needs_human`で止まったとき、ブランチを確認できるように残すcommitのメッセージ。
 * トレーラーは`withCommitTrailers`が付ける。
 * 後で成功した実行の最終commitとは別のcommitになる。
 */
export const IMPLEMENT_WIP_COMMIT_MESSAGE =
  "chore: 自動実装の途中経過を保存する\n\n- 検証が完了しなかったため、確認用に途中の変更をpushしました";

export const SECRETS_NOT_PUSHED_REASON = "secrets detected, changes not pushed";
export const PARTIAL_WORK_KEPT_LOCAL_REASON =
  "partial work kept local because a pull request is open";

/**
 * `needs_human`での停止時に、途中の作業をpushするかを返す。
 * pushするのは作業を残す停止(`preserveWork`)のときだけで、
 * ブランチをPRが使っているときはpushしない。
 * pushすると、検証していない変更が開いているPRに入るためである。
 * `hasPr`は、文脈の`existing_pr_number`か作業項目の`pr_url`があるかを表す。
 */
export function shouldPushPartialWork(
  action: ImplementFinishAction,
  hasPr: boolean,
): boolean {
  return action.kind === "needs_human" && action.preserveWork && !hasPr;
}
/**
 * 終端処理の前(Issueの再確認)でgitやGitHubの操作が失敗したとき、
 * 先に実行の作業をブランチに残すかを返す。
 * 残すのは、PRを開くはずだった実行と、作業を残すガード停止である。
 * requirements_gap、キャンセル、作業を残さない停止には残すものが無い。
 * PRが開いているときの規則(`shouldPushPartialWork`)は呼び出し側が適用する。
 */
export function shouldPreserveBeforeFailing(
  action: ImplementFinishAction,
): boolean {
  return (
    action.kind === "open_pr" ||
    (action.kind === "needs_human" && action.preserveWork)
  );
}
export const IMPLEMENT_FINISH_NO_OUTPUT_REASON =
  "implement finished without a final output";
export const IMPLEMENT_NO_CHANGES_REASON = "implement produced no changes";

export type PreserveWorkDeps = {
  /** worktreeのロックを持つプロセスがいれば、何も止めずに`WorktreeBusyError`を投げる。 */
  readonly ensureLockFree: () => Promise<void>;
  /** 文脈の`worktree_git_pointer`に対して`assertWorktreeGitPointer`を実行する。 */
  readonly assertGitPointer: () => Promise<void>;
  /** implementのworktreeに`runGitleaksOnWorktree`を実行する。 */
  readonly scanForSecrets: () => Promise<GitleaksScan>;
  /**
   * `IMPLEMENT_WIP_COMMIT_MESSAGE`と、prepare時点の`expectedHeadSha`で
   * `commitAndPush`を実行する。
   * ステージし直した内容が`scannedTreeSha`と違えば、`inspectStaged`(`scannedTreeStopReasons`)で
   * commitせずに`CommitBlockedError`を投げる。
   */
  readonly commitAndPush: (
    scannedTreeSha: string,
  ) => Promise<CommitAndPushResult>;
};

/**
 * 停止したループの作業をcommitしてブランチにpushする。
 * worktreeのロックを持つプロセスが残っていればpushしない。
 * `.git`ポインタが変わったworktreeではgitを実行しない。
 * 秘密の検査で検出された変更や、検査できなかった変更、検査した後に変わった変更もpushしない。
 * `needs_human`の理由に付け足す注記(英語)の配列を返す。
 * 例外は`ImplementLeaseLostError`(依存がリースを失ったと知らせた)だけを投げ直し、
 * それ以外は注記にする。リースを失った実行は、注記を付けて人に知らせるのではなく、何もせずに終えるため。
 */
export async function preserveWork(deps: PreserveWorkDeps): Promise<string[]> {
  try {
    const busyReason = await worktreeBusyStopReason(deps.ensureLockFree);
    if (busyReason !== null) return [busyReason];
    const pointerReason = await gitPointerStopReason(deps.assertGitPointer);
    if (pointerReason !== null) return [pointerReason];
  } catch (err) {
    return [failureNoteUnlessLeaseLost(err)];
  }
  let scan: GitleaksScan;
  try {
    scan = await deps.scanForSecrets();
  } catch (err) {
    return [failureNoteUnlessLeaseLost(err)];
  }
  if (!scan.ok) return [SECRETS_NOT_PUSHED_REASON];
  try {
    const pushed = await deps.commitAndPush(scan.treeSha);
    return pushed.outcome === "head_changed"
      ? [`branch head moved to ${pushed.currentSha} while implementing`]
      : [];
  } catch (err) {
    if (err instanceof CommitBlockedError) return [err.message];
    return [failureNoteUnlessLeaseLost(err)];
  }
}

/** `err`が`ImplementLeaseLostError`なら投げ直し、そうでなければ`finishFailureReason`の注記を返す。 */
function failureNoteUnlessLeaseLost(err: unknown): string {
  if (err instanceof ImplementLeaseLostError) throw err;
  return finishFailureReason(err);
}

export const WORKTREE_CHANGED_AFTER_VERIFICATION_REASON =
  "worktree changed after verification";

export type VerifiedTreeDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "stop"; readonly reason: string };

/**
 * 最終commitの直前にステージし直したworktreeが、ループで検証(秘密の検査と
 * 検証コマンド)したツリーと完全に一致するときだけ、commitへ進む。
 * 検証コマンドが追跡中のファイルを書き換えたときなど、
 * 検証後にworktreeが変わったときは、pushの前に止める。
 * 検証済みのツリーが無いときも止める。
 */
export function decideVerifiedTree(
  verifiedTreeSha: string | null,
  currentTreeSha: string,
): VerifiedTreeDecision {
  return verifiedTreeSha !== null && verifiedTreeSha === currentTreeSha
    ? { kind: "proceed" }
    : { kind: "stop", reason: WORKTREE_CHANGED_AFTER_VERIFICATION_REASON };
}

export type AfterCommitDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "stop"; readonly reason: string };

/**
 * `done`で終わった実行の最終`commitAndPush`の結果から、PRの工程へ進むかを決める。
 * `branchAhead`は`context.expected_head_sha !== context.base_sha`で、
 * ブランチがmerge-baseより先のcommit(`needs_human`での途中のpushや、
 * 既存PRのcommit)をすでに持つことを表す。
 * そのようなブランチでは新しくcommitするものが無くても、pushした後と同じく
 * 既存のcommitからPRを作る。baseより先に何も無いときだけ「変更なし」で止める。
 */
export function decideAfterCommit(
  result: CommitAndPushResult,
  branchAhead: boolean,
): AfterCommitDecision {
  switch (result.outcome) {
    case "pushed":
      return { kind: "proceed" };
    case "nothing_to_commit":
      return branchAhead
        ? { kind: "proceed" }
        : { kind: "stop", reason: IMPLEMENT_NO_CHANGES_REASON };
    case "head_changed":
      return {
        kind: "stop",
        reason: `branch head moved to ${result.currentSha} while implementing`,
      };
  }
}

/** implement_finishが`needs_human`で止まったときの、人が次に行う操作を返す。 */
export function implementNeedsHumanNextAction(branch: string): string {
  return `ブランチ\`${branch}\`を確認してPRを作るか、要件を直してください。不要ならブランチを削除してください`;
}

/** PRを開いたときの、人が次に行う操作を返す。保護パスの変更があれば先に確認を促す。 */
export function prOpenedNextAction(hasProtectedChanges: boolean): string {
  return hasProtectedChanges
    ? "保護パスの変更を先に確認し、自動レビューの結果とあわせて人がマージを判断してください"
    : "自動レビューの結果を確認し、問題なければ人がマージしてください";
}

/** `factory:review`ラベル(`review_label`)を`ensureLabel`で作るときの色と説明。 */
export const REVIEW_LABEL_STYLE = {
  color: "0e8a16",
  description: "Software Factoryの自動レビュー対象",
} as const;

/**
 * `owner`/`repo`が`factory_config.factory_repo`と同じリポジトリかを返す。
 * PR本文の備考にWindmillへの反映のチェックリストを載せるかの判定に使う。
 */
export function isFactoryRepo(
  factoryRepo: string,
  owner: string,
  repo: string,
): boolean {
  return (
    normalizeRepoUrl(factoryRepo) ===
    normalizeRepoUrl(`https://github.com/${owner}/${repo}`)
  );
}

export function toDiscordChecks(
  checks: ImplementCheckSummary,
): "passed" | { skipped: string } {
  return checks.kind === "skipped" ? { skipped: checks.reason } : "passed";
}

export type PrOpenedEventInput = {
  readonly instanceName: string;
  readonly target: Pick<
    ImplementContext,
    "owner" | "repo" | "issue_number" | "issue_url"
  >;
  readonly pr: { readonly number: number; readonly htmlUrl: string };
  readonly loop: Pick<
    ImplementLoopResult,
    "protected_changes" | "rounds" | "total_cost_usd" | "diff_stat"
  >;
  readonly checks: ImplementCheckSummary;
  /** 新しく作らずに既存のPRを更新したときは`false`。 */
  readonly created: boolean;
};

/** Discordへ通知する`pr_opened`イベントを組み立てる。 */
export function buildPrOpenedEvent(
  input: PrOpenedEventInput,
): Extract<NotifyEvent, { kind: "pr_opened" }> {
  return {
    kind: "pr_opened",
    instance_name: input.instanceName,
    owner: input.target.owner,
    repo: input.target.repo,
    pr_number: input.pr.number,
    pr_url: input.pr.htmlUrl,
    issue_number: input.target.issue_number,
    issue_url: input.target.issue_url,
    protected_changes: [...input.loop.protected_changes],
    checks: toDiscordChecks(input.checks),
    rounds: input.loop.rounds,
    total_cost_usd: input.loop.total_cost_usd,
    diff_stat: input.loop.diff_stat,
    next_action: prOpenedNextAction(input.loop.protected_changes.length > 0),
    created: input.created,
  };
}
