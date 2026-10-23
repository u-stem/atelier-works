// f/factory/pr_fixの唯一の終端ステップ。
// 最後に動いたステップ(prepare / collect / apply / verify)の結果を受けて、
// 作業項目の状態遷移、GitHubへの副作用、Discordへの通知を行う。

import * as wmill from "windmill-client@1.817.0";
import {
  githubPrMergeBaseIo,
  resolvePrMergeBase,
} from "../lib/ci_fix_pr_base.ts";
import {
  CI_ROUND_REPLIES_REASON,
  ciAddedPathsStopReason,
  ciRoundPushGuardReason,
  ciTextScanner,
  collectCiFixChanges,
  guardCiRoundReasons,
  inspectCiFixChanges,
  isCiRound,
  isRehashCandidate,
  listCiAddedPathsInTree,
  nothingToCommitReason,
  runPostPushBookkeeping,
} from "../lib/ci_fix_round.ts";
import {
  confirmRehash,
  githubRehashPlanner,
  type RehashPlanner,
  readRootWmillLock,
  readStagedRootLock,
  rehashPushStopReason,
  rehashRoundProbe,
  type StagedRehashGate,
  stagedRehashGate,
} from "../lib/ci_metadata_rehash.ts";
import { loadConfig } from "../lib/config.ts";
import {
  CONFLICT_BLOCKED_NOTES,
  CONFLICT_MERGE_NOT_RECORDED_REASON,
  CONFLICT_ROUND_DETAILS,
  CONFLICT_ROUND_REPLIES_REASON,
  conflictRoundReason,
  isConflictRound,
  roundStopReason,
} from "../lib/conflict_fix_round.ts";
import {
  CONFLICT_VERIFIED_TREE_CHANGED_REASON,
  type ConflictInspection,
  gitConflictInspectDeps,
  inspectConflictResolution,
} from "../lib/conflict_fix_verify.ts";
import {
  addNoticeUnlessUnresolved,
  bumpWatermarks,
  getWorkItem,
  insertApprovalRequest,
  insertFixRound,
  insertIssueProposal,
  recordFailure,
  setFlowJobIdIfUnset,
  setHeadSha,
  updateStatusIfCurrent,
  updateStatusIfLeaseHolderClearingFlowJobId,
} from "../lib/db.ts";
import { type NotifyEvent, notifyBestEffort } from "../lib/discord.ts";
import {
  type GhClient,
  getPr,
  getPrFiles,
  getViewer,
  gitIdentityForViewer,
  listReviewThreads,
  postIssueComment,
  type RequestReviewersResult,
  replyReviewComment,
  requestReviewers,
  withMarker,
} from "../lib/github.ts";
import { GITLEAKS_TIMEOUT_MS } from "../lib/implement_loop.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { runCommandBytes } from "../lib/metadata_git_ports.ts";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import {
  repoOwnerGateDeps,
  repoOwnerStopReason,
} from "../lib/repo_owner_gate.ts";
import { type FixReply, isOneOf, type WorkItemStatus } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  type CommitAndPushResult,
  CommitBlockedError,
  type ConflictBlobs,
  commitAndPush,
  type PushMergeCommitResult,
  pushMergeCommit,
  runCommand,
  runGitleaksOnTreeDiff,
  runGitleaksOnWorktree,
  scannedTreeStopReasons,
} from "../lib/workspace.ts";
import {
  buildIssueProposalReason,
  buildReplyPostFailedNotice,
  type CollectedComment,
  type CollectedReview,
  composeCommitMessage,
  decideFixFinishAction,
  deriveFallbackReviewers,
  describeReason,
  evaluateRerouteGuard,
  filterKnownReplies,
  fixOutputProseIssues,
  inspectStagedChanges,
  listReviewThreadsBestEffort,
  matchReviewThreadForComment,
  nextActionFor,
  nextActionForPrFix,
  PR_HEAD_NOT_RECORDED_REASON,
  type PrFixFinishOutcome,
  type PrFixSecretScanResult,
  prFixPushGateReason,
  type ReplyPostFailure,
  renderFixReply,
  rerouteRequirementsGap,
  scanPrFixBeforeCommit,
  selectProposeIssueReplies,
  shouldAdvanceWatermarks,
  stopBeforeCommitTerminal,
  withGapReport,
} from "./pr_workflow_support.ts";

const ALL_OUTCOMES: readonly PrFixFinishOutcome[] = [
  "skip",
  "guard_blocked",
  "round_exhausted",
  "no_feedback",
  "done",
  "requirements_gap",
  "blocked",
  "conflict_up_to_date",
  "conflict_blocked",
];

export type PrFixFinishResult = {
  readonly ok: boolean;
  readonly final_status: WorkItemStatus | null;
  readonly notice: string | null;
};

/** 再レビュー依頼の結果を、何を記録しどこへ知らせるかに読み替えたもの。 */
export type ReviewerRequestReport = {
  /** `work_items.status_reason`とnoticeに残す文。何も残さないときは`null`。 */
  readonly note: string | null;
  /** Discordで知らせる、再レビュー依頼のAPIの失敗。それ以外は`null`。 */
  readonly apiError: string | null;
  /** noticeの種別。noticeを残すのはAPIの失敗だけで、それ以外は`null`。 */
  readonly noticeKind: "pr_fix_reviewer_request_failed" | null;
};

/**
 * 再レビュー依頼の結果を読み替える。`result`が`null`なのは、依頼先の候補が
 * 無く(`default_reviewers`が空で、レビュー・コメントの書き手も無い)、
 * 依頼しなかったとき。
 * "failed"と"skipped_empty"は、GitHub上はどちらもレビュアーが依頼されないので、
 * 放っておくと痕跡が残らない。どちらも`note`に残すが、noticeとDiscordの通知は、
 * 人が代わりに依頼する必要があるAPIの失敗のときだけにする。依頼先が無い場合と、
 * 候補が全員除外された場合は想定内で、することが無いので`note`だけに残す。
 */
export function reportReviewerRequest(
  result: RequestReviewersResult | null,
): ReviewerRequestReport {
  if (result === null) {
    return {
      note: "no reviewers to request (default_reviewers empty and no fallback reviewer authors)",
      apiError: null,
      noticeKind: null,
    };
  }
  if (result.outcome === "failed") {
    return {
      note: `failed to request reviewers: ${result.error}`,
      apiError: result.error,
      noticeKind: "pr_fix_reviewer_request_failed",
    };
  }
  if (result.outcome === "skipped_empty") {
    return {
      note: "requested reviewers were all excluded (PR author / factory viewer)",
      apiError: null,
      noticeKind: null,
    };
  }
  return { note: null, apiError: null, noticeKind: null };
}

/**
 * 再レビュー依頼のAPIの失敗を、`pr_fixed`通知の補足欄に載せる文にする。
 * Discordはフィールドの値を1024文字で切るので、エラーが長くても人のすることが
 * 残るよう、依頼の指示を先に置く。
 */
export function reviewerRequestFailedSupplement(apiError: string): string {
  return `GitHubでレビュアーを手動で依頼してください。\n再レビュー依頼のAPI呼び出しに失敗しました: ${apiError}`;
}

/**
 * `reviewers`に再レビューを依頼する。依頼先からPRの作成者を除くため、先に
 * `loadAuthorLogin`でPRを読む。依頼先が無ければ何もせず`null`を返す。
 * 呼ぶのはpush・返信・記録が済んだ後なので、PRを読めなくても(rate limitなど)、
 * 依頼が例外を投げても(Botや削除済みの作成者の名前など)例外にせず、
 * 依頼のAPIの失敗(`outcome: "failed"`)として返す。
 */
export async function requestRereview(
  reviewers: readonly string[],
  deps: {
    readonly loadAuthorLogin: () => Promise<string>;
    readonly request: (authorLogin: string) => Promise<RequestReviewersResult>;
  },
): Promise<RequestReviewersResult | null> {
  if (reviewers.length === 0) return null;
  let authorLogin: string;
  try {
    authorLogin = await deps.loadAuthorLogin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      outcome: "failed",
      error: `could not load the PR: ${maskSecrets(message)}`,
    };
  }
  try {
    return await deps.request(authorLogin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", error: maskSecrets(message) };
  }
}

/** 競合回のpushの直前に読み直すPRの事実。 */
export type ConflictPushPr = {
  readonly state: string;
  readonly draft: boolean;
  readonly autoMergeEnabled: boolean;
  readonly headSha: string;
  /** PRのbase。`pushMergeCommit`が、リモートの既定のブランチと照合する。 */
  readonly baseRef: string;
};

/** `runConflictPush`が使うI/O。テストでは偽物に差し替える。 */
export type ConflictPushDeps = {
  /** worktreeに触れてよいかを確かめ、止める理由を返す(`prFixPushGateReason`)。 */
  readonly gate: () => Promise<string | null>;
  /** 解消後のツリーを検査する(`inspectConflictResolution`)。 */
  readonly inspect: () => Promise<ConflictInspection>;
  /** 検査したツリーを、秘密値の検査にかける(`scanPrFixBeforeCommit`)。 */
  readonly scan: (treeSha: string) => Promise<PrFixSecretScanResult>;
  readonly readPr: () => Promise<ConflictPushPr>;
  /** リポジトリのオーナーの数値IDを照合し、止める理由を返す(`repoOwnerStopReason`)。 */
  readonly ownerStop: () => Promise<string | null>;
  readonly push: (request: {
    readonly expectedTreeSha: string;
    readonly inspectStaged: () => Promise<string[]>;
    readonly baseBranch: string;
  }) => Promise<PushMergeCommitResult>;
};

/** `runConflictPush`の結果。 */
export type ConflictPushOutcome =
  /** pushせずに止めた。`reason`が、作業項目の注記になる。 */
  | { readonly kind: "stop"; readonly reason: string }
  /** PRのheadが、作業を始めたときから動いている。 */
  | { readonly kind: "head_changed"; readonly currentSha: string }
  /** 記録したbaseが、既定のブランチの先頭でも祖先でもなくなった。 */
  | { readonly kind: "base_changed" }
  /** PATにworkflowの権限が無いために、GitHubがpushを拒否した。 */
  | { readonly kind: "rejected_workflows" }
  | { readonly kind: "pushed"; readonly newSha: string };

/**
 * 競合回のmergeコミットをpushする。pushの前に、次を順に確かめる。
 * 1. worktreeに触れてよいこと(ロックを持つプロセスが残っておらず、`.git`が記録のままであること)。
 * 2. 解消後のツリーが、検証のステップと同じ検査に通り、検証が通したツリーと同じであること。
 *    検証と完了の間にworktreeが変わっても、pushする内容そのもので判定するためである。
 *    検査コマンドが通ったツリーと、pushするツリーを結びつけるため、ツリーのshaが一致しなければ止める。
 * 3. そのツリーが、秘密値の検査に通ること。
 * 4. PRが、開いていて、draftでなく、auto-mergeが無効で、headが作業を始めたときのままであること。
 *    競合回は人の指摘に答える回ではなく、レビューを経ずにマージされうる状態では押せない。
 * 5. リポジトリのオーナーの数値IDが、設定のままであること。
 * pushは`pushMergeCommit`が行い、ステージした内容の検査と、親とbaseの照合は、その中で行う。
 * ステージした内容が検査したツリーと違うなどで`CommitBlockedError`が出たときは、止める理由にする。
 */
export async function runConflictPush(
  deps: ConflictPushDeps,
  input: {
    readonly prHeadSha: string;
    /** 検証のステップで、検査コマンドの前後の検査が同じだったツリー。無ければnull。 */
    readonly verifiedTreeSha: string | null;
  },
): Promise<ConflictPushOutcome> {
  const stop = (reason: string): ConflictPushOutcome => ({
    kind: "stop",
    reason,
  });
  const gateReason = await deps.gate();
  if (gateReason !== null) return stop(gateReason);

  const inspection = await deps.inspect();
  if (inspection.reasons.length > 0) return stop(inspection.reasons.join("; "));
  if (inspection.treeSha !== input.verifiedTreeSha) {
    return stop(CONFLICT_VERIFIED_TREE_CHANGED_REASON);
  }

  const scanned = await deps.scan(inspection.treeSha);
  if (scanned.kind === "stop") return stop(scanned.reason);

  const latest = await deps.readPr();
  if (latest.headSha !== input.prHeadSha) {
    return { kind: "head_changed", currentSha: latest.headSha };
  }
  const pushStop = ciRoundPushGuardReason(latest, input.prHeadSha);
  if (pushStop !== null) return stop(pushStop);

  const ownerStop = await deps.ownerStop();
  if (ownerStop !== null) return stop(ownerStop);

  let result: PushMergeCommitResult;
  try {
    result = await deps.push({
      expectedTreeSha: scanned.treeSha,
      inspectStaged: scanned.inspectStaged,
      baseBranch: latest.baseRef,
    });
  } catch (err) {
    if (err instanceof CommitBlockedError) return stop(err.message);
    throw err;
  }
  switch (result.outcome) {
    case "pushed":
      return { kind: "pushed", newSha: result.newSha };
    case "head_changed":
      return { kind: "head_changed", currentSha: result.currentSha };
    case "base_changed":
      return { kind: "base_changed" };
    case "rejected_workflows":
      return { kind: "rejected_workflows" };
  }
}

/**
 * `outcome`に応じて作業項目を遷移させ、遷移先と通知文を返す。
 * 修正があればcommitしてpushし、レビューコメントへ返信して再レビューを依頼する。
 * commitの前に、worktreeのロックを持つプロセスが無いこと、`.git`が`worktree_git_pointer`(準備ステップの記録)と一致すること、
 * ローカルのHEADが`branch`(準備ステップの記録)にあり`head_sha`であること、ステージした内容に保護パス・symlink・gitlink・`package.json`のscriptsの変更が無いことを確かめ、
 * その前に(リポジトリのロックの外で)ステージした差分をgitleaksで検査して秘密情報らしき文字列が無いことを確かめ、
 * commitの直前には索引が、commitの後には作ったcommitのツリーが、検査したツリーのままであることも確かめる。
 * どれかに通らなければpushせずにneeds_humanにし、理由を`status_reason`に記録する。準備ステップの結果に`worktree_git_pointer`か`branch`が無いときも同じにする。
 * gitleaksの検査自体が失敗したときは例外を投げ、何もcommitもpushもしない。
 * `outcome`が想定外の値なら例外を投げる。
 * トリガーの`fix_label`は着手時に消費済みなので、終端の遷移で外すラベルは無い。
 * gtrのworktreeは消さずに残し、後で`cleanup_workspaces`が片付ける。
 *
 * CIの失敗を直す回(`ci_check_id`が非NULL)は、通常の回と次の点が違う。
 * - 返信を投稿せず、作業項目のheadも処理済みの位置も更新しない。
 *   作業項目のheadを進めないのは、その差(作業項目のheadとPRのhead)が`poll_prs`の自動のレビューを起動するためで、
 *   通常の回と逆である。
 * - ステージした内容を、保護パスの検査に加えて、許可リスト方式でも検査する(`inspectCiFixChanges`)。
 * - pushの直前に、PRが開いていて、draftでなく、auto-mergeが無効で、headが修正の前提のままであることを確かめる。
 * - pushの直前に、リポジトリのオーナーの数値IDを照合する。通らなければpushも返信もせず、`blocked`にする。
 * - 返信を持つ結果は受け付けない。
 * 失敗の行(`pr_ci_checks`)には触れない。行の整理は`watch_pr_ci`の役目である。
 *
 * マージの競合を直す回(`conflict_check_id`が非NULL)は、通常の回と次の点が違う。
 * - 失敗をDiscordにもnoticeにも出さない。競合の行の保留の理由を付けて、競合の監視(`watch_pr_conflicts`)が通知する。
 * - 修正を`commitAndPush`ではなく`runConflictPush`でpushする。競合ファイルだけをステージしたツリーを、
 *   親が[PRのhead, base]のmergeコミットにする(`pushMergeCommit`)。基準コミットは送らない。
 * - pushできたら`rereview_requested`にする。作業項目のheadは進めず、再レビューの依頼も`pr_fixed`の通知もしない。
 * - baseがすでにPRにあれば(`conflict_up_to_date`)、何もpushせず`reviewed`にして、注記`conflict round: up_to_date`を残す。
 * - 直せない競合(`conflict_blocked`)は`needs_human`にする。注記は固定文(`CONFLICT_BLOCKED_NOTES`)だけで、回復が完全一致で保留の理由に写す。
 * - pushの直前にbaseが動いていれば、`reviewed`にして次の巡回で判定し直させる。
 * - 止めた理由の注記に、競合回の接頭辞を足さない。イメージが古い理由の接頭辞を崩すと、自動の再開と回数の除外が働かなくなる。
 *
 * `fix_round`はここでは増やさない。
 * `poll_prs.ts`が作業項目を作る時点で、その行が表すラウンド番号を
 * `fix_round`に入れている(`setFixRound(workItemId, previousFixRound + 1)`)。
 * pr_fixの各回は1行を書き換えていくのではなく、それぞれ別の`work_items`の行になる。
 * `latestPrWorkItem`はPRごとの最新の行の`fix_round`から次のラウンド番号を求めるので、
 * ここで増やすと二重に数え、以降のラウンド番号がずれる。
 */
export async function main(
  work_item_id: number,
  outcome: string,
  reason: string | null,
  summary: string,
  replies: FixReply[],
  commit_subject: string | null,
  commit_body: string | null,
  owner: string,
  repo: string,
  pr_number: number,
  worktree_dir: string,
  repo_dir: string,
  head_sha: string,
  parent_work_item_id: number | null,
  fix_round: number,
  reviews: CollectedReview[],
  comments: CollectedComment[],
  trigger_review_ids: number[],
  max_review_id: number,
  max_comment_id: number,
  max_review_comment_id: number,
  worktree_git_pointer: string | null = null,
  branch: string | null = null,
  ci_check_id: number | null = null,
  conflict_check_id: number | null = null,
  baseline_sha: string | null = null,
  base_sha: string | null = null,
  auto_tree_sha: string | null = null,
  conflicted_paths: string[] | null = null,
  conflict_blobs: ConflictBlobs[] | null = null,
  verified_tree_sha: string | null = null,
): Promise<PrFixFinishResult> {
  if (!isOneOf(outcome, ALL_OUTCOMES)) {
    throw new Error(`pr_fix_finish: unexpected outcome "${outcome}"`);
  }
  const action = decideFixFinishAction(outcome, parent_work_item_id !== null);
  const ciRound = isCiRound({ ci_check_id });
  const conflictRound = isConflictRound({ conflict_check_id });

  if (action.kind === "noop") {
    return {
      ok: true,
      final_status: null,
      notice: "prepare skipped (wrong kind/status)",
    };
  }

  const log = logger("pr_fix_finish");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const viewer = await getViewer(client);
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  const prUrl = `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`;

  // watermarkは無条件には進めない(理由は`shouldAdvanceWatermarks`の説明を参照)。
  // 進めるのは、requirements_gapの差し戻しに成功したときと、pushに成功したときだけ。

  /**
   * 作業項目を`fixing`から`toStatus`へ遷移させ、遷移できたらDiscordへ
   * needs_humanを通知する。通知の失敗は警告を記録するだけで投げない。
   * `statusNote`は`work_items.status_reason`に記録する値で、省略すると直前のステップの`reason`を使う。
   */
  async function finalizeTerminal(
    toStatus: WorkItemStatus,
    discordReason: string,
    statusNote: string | null = reason,
  ): Promise<void> {
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "fixing",
      toStatus,
      statusNote,
    );
    if (!moved) return;
    // 競合回の失敗は、競合の監視(`watch_pr_conflicts`)が行の保留の理由を付けて通知する。
    // ここでも通知すると、同じ競合について人に2回届く。
    if (conflictRound) return;
    // トリガーの`fix_label`は`poll_prs.ts`が着手時に消費済みなので、外すラベルは無い。
    // 運用上の知らせ(失敗、needs_human、blocked、requirements_gap)はPRに投稿しない。
    // PRに載せるのは一次レビューとレビューコメントへの返信だけにするため。
    // 人には下のDiscord通知で、このPRに対応が要ることを伝える。
    const event: NotifyEvent = {
      kind: "needs_human",
      instance_name: config.instance_name,
      owner,
      repo,
      url: prUrl,
      // 日本語への変換は表示用。記録する`status_reason`は変換前の英語のまま保つ。
      reason: describeReason(discordReason),
      target: { kind: "pr", number: pr_number },
      next_action: nextActionForPrFix(discordReason, ciRound),
    };
    await notifyBestEffort(webhookUrl, event, log);
  }

  // `finalizeTerminal`で終わる分岐(これと、以降の"needs_human" / "blocked"のすべて)は、
  // 意図して`bumpWatermarks`を呼ばない(`shouldAdvanceWatermarks`の説明を参照)。
  // 呼ぶのは、後に出てくるrequirements_gapの差し戻し成功とpush成功の経路だけ。
  if (action.kind === "guard_blocked") {
    await finalizeTerminal("blocked", reason ?? "safety guard failed");
    return { ok: true, final_status: "blocked", notice: reason };
  }

  // baseがすでにPRの履歴にある競合回。pushするものが無いので、何も変えずに終える。
  // 注記は、回復が「pushしていない」と見分けるために使う(回数にも数えない)。
  if (action.kind === "conflict_up_to_date") {
    const note = conflictRoundReason(CONFLICT_ROUND_DETAILS.upToDate);
    await updateStatusIfCurrent(work_item_id, "fixing", "reviewed", note);
    return { ok: true, final_status: "reviewed", notice: note };
  }

  // 競合回で直せない競合。注記は固定文だけにする。回復が完全一致で保留の理由に写すためである。
  if (action.kind === "conflict_blocked") {
    if (reason === null || !CONFLICT_BLOCKED_NOTES.includes(reason)) {
      throw new Error(
        "pr_fix_finish: conflict_blocked without a fixed reason of a conflict round",
      );
    }
    await finalizeTerminal("needs_human", reason, reason);
    return { ok: true, final_status: "needs_human", notice: reason };
  }

  if (action.kind === "needs_human") {
    if (outcome === "blocked") {
      await insertFixRound({
        work_item_id,
        round: fix_round,
        trigger_review_ids,
        outcome: "blocked",
        replies,
        commit_shas: [],
      });
    }
    await finalizeTerminal("needs_human", reason ?? "needs human attention");
    return { ok: true, final_status: "needs_human", notice: reason };
  }

  if (action.kind === "requirements_gap_needs_human") {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "requirements_gap",
      replies,
      commit_shas: [],
    });
    await finalizeTerminal("needs_human", reason ?? summary);
    return { ok: true, final_status: "needs_human", notice: reason };
  }

  if (action.kind === "requirements_gap_reroute") {
    if (parent_work_item_id === null) {
      throw new Error(
        "pr_fix_finish: requirements_gap_reroute without a parent_work_item_id",
      );
    }
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "requirements_gap",
      replies,
      commit_shas: [],
    });

    const parentItem = await getWorkItem(parent_work_item_id);
    if (parentItem === null) {
      await finalizeTerminal("needs_human", reason ?? summary);
      return { ok: true, final_status: "needs_human", notice: reason };
    }

    const gapReport = reason ?? summary;

    // 親Issueの`factory`ラベルも、このPRの`factory:fix`ラベルも付け直さない。
    // どちらも着手時に消費され、戻すものは無い。
    // トリガーラベルを付け直すと残り続け、次に終端の状態になった後で
    // Issueが再び着手されてしまう。
    // 残る前提条件は、親の作業項目が実際にIssueであることだけ。
    const rerouteGuard = evaluateRerouteGuard(parentItem.issue_number);

    if (!rerouteGuard.ok) {
      log.warn(
        "aborting requirements_gap reroute: parent work item has no issue",
        {
          parent_work_item_id,
          reason: "no_parent_issue",
          detail: rerouteGuard.reason,
        },
      );
      await finalizeTerminal("needs_human", reason ?? summary);
      return { ok: true, final_status: "needs_human", notice: reason };
    }

    // 親が差し戻せる状態にないとき、試行回数を使い切ったとき、読んだ後に変わったときは差し戻さない。
    // どれもwatermarkは進めず、人に知らせる。
    //
    // PRに載せるのは一次レビューとレビューコメントへの返信だけなので、
    // 差し戻しに成功してもPRにはコメントしない。
    // 差し戻しは、親Issueのrequirements_gapのnoticeと、
    // pipeline_generateが送るDiscord通知で分かる。
    const outcome = await rerouteRequirementsGap(
      {
        id: parentItem.id,
        issue_number: rerouteGuard.issueNumber,
        status: parentItem.status,
        flow_job_id: parentItem.flow_job_id,
        attempt: parentItem.attempt,
      },
      config.max_attempts,
      {
        casParent: (expectedFrom, expectedFlowJobId) =>
          updateStatusIfLeaseHolderClearingFlowJobId(
            parent_work_item_id,
            expectedFrom,
            "requirements_generating",
            expectedFlowJobId,
            `gap: ${gapReport}`,
          ),
        bumpWatermarks: () =>
          bumpWatermarks(work_item_id, {
            last_review_id: max_review_id,
            last_comment_id: max_comment_id,
            last_review_comment_id: max_review_comment_id,
          }),
        markBlocked: async () => {
          await updateStatusIfCurrent(
            work_item_id,
            "fixing",
            "blocked",
            `requirements_gap: rerouted to work item ${String(parent_work_item_id)}`,
          );
        },
        launchPipeline: () =>
          wmill.runFlowAsync("f/factory/pipeline", {
            work_item_id: parent_work_item_id,
            attempt: parentItem.attempt + 1,
            feedback: gapReport,
          }),
        recordFlowJobId: (jobId) =>
          setFlowJobIdIfUnset(parent_work_item_id, jobId),
        cancelJob: async (jobId, cancelReason) => {
          await wmill.cancelJob(jobId, cancelReason);
        },
        recordFailure: async (failureReason) => {
          await recordFailure({
            work_item_id: parent_work_item_id,
            flow_path: "f/factory/pipeline",
            job_id: process.env.WM_JOB_ID ?? "unknown",
            step: "record_flow_job_id",
            error: failureReason,
          });
        },
        log: (message, fields) => log.warn(message, fields),
      },
    );
    if (outcome.kind === "refused") {
      log.warn("aborting requirements_gap reroute", {
        parent_work_item_id,
        parent_status: parentItem.status,
        detail: outcome.reason,
      });
      const refusalWithGap = withGapReport(outcome.reason, gapReport);
      await finalizeTerminal("needs_human", refusalWithGap, refusalWithGap);
      return { ok: true, final_status: "needs_human", notice: outcome.reason };
    }

    return { ok: true, final_status: "blocked", notice: gapReport };
  }

  // ここに来るのは`action.kind === "push"`のときだけ。
  if (commit_subject === null) {
    await finalizeTerminal(
      "needs_human",
      "done outcome missing a commit message",
    );
    return {
      ok: true,
      final_status: "needs_human",
      notice: "missing commit_message",
    };
  }
  if (ciRound && replies.length > 0) {
    return stopBeforeCommit(CI_ROUND_REPLIES_REASON);
  }
  // 競合回のコミットは、固定文のmergeコミットを`pushMergeCommit`が作る。
  // 返信も、作業項目のheadと処理済みの位置の更新も、再レビューの依頼も、`pr_fixed`の通知もしない。
  if (conflictRound) {
    if (replies.length > 0) {
      return stopBeforeCommit(CONFLICT_ROUND_REPLIES_REASON);
    }
    return finishConflictPush();
  }
  // Claudeが提案した件名と本文は、`pr_fix_apply.ts`から`pr_fix_verify.ts`まで別々に運ばれ、
  // コミットメッセージの文字列につなぐのはここだけ。
  // Co-Authored-By / Generated-Byのトレーラーは、この後`commitAndPush`の
  // `withCommitTrailers`が足す。
  const commitMessage = composeCommitMessage(commit_subject, commit_body);
  const proseIssues = fixOutputProseIssues(
    replies,
    commit_subject,
    commit_body,
  );
  if (proseIssues.length > 0) {
    log.warn("pr_fix output breaks the writing rules", {
      work_item_id,
      issues: proseIssues,
    });
  }

  const commentById = new Map(comments.map((comment) => [comment.id, comment]));
  // 実際に集めたコメントの`review_comment_id`を指す返信だけを扱う。
  // Claudeの出力の全体は、監査のために`insertFixRound`がそのまま記録する。
  const repliesToPost = filterKnownReplies(
    replies,
    new Set(commentById.keys()),
  );

  /**
   * 溜めた返信をすべてGitHubに投稿する。
   * 元のコメントがインラインならそのレビューコメントへの返信として、
   * インラインでなければ(`original.path`が空)通常のIssueコメントとして投稿する。
   * `newSha`は修正で作ったcommitで、指すものが無いときはnull。
   * push成功とnothing_to_commitの両方の経路で使い、どちらでも返信がGitHubに届くようにする
   * (Claudeがすべて"skipped"にしたときなども、黙って捨てない)。
   *
   * 提案の行を黙って失わないよう、`propose_issue`の返信は、投稿する前に
   * `factory.issue_proposals`の行を登録する。
   * 登録が失敗したら、その返信は投稿せず、`issue_proposal_record_failed`のnoticeを記録する。
   * どこにも記録されていないIssueの検討を約束するPRコメントを出さず、
   * Consoleの要対応で人に失敗を知らせるため。
   * 行を登録した後に返信の投稿が失敗しても、致命的ではない。
   * GitHubに返信が出るかどうかに関わらず、提案はConsoleの要対応に見えている。
   * `thread_id`は、このラウンドの全提案で共有する1回の`listReviewThreads`から
   * ベストエフォートで求める。取得に失敗したら(rate limitを含む)`thread_id`を付けずに続ける。
   * 通常のIssueコメントにはレビュースレッドが無いので、
   * インラインの提案が1つ以上あるときだけ取得する。
   * 返信の投稿に失敗しても(rate limitを含む)ステップは止めず、残りの返信を続ける。
   * 失敗が1件以上あれば、最後に`fix_reply_post_failed`のnoticeを1件だけ記録し、
   * Consoleの要対応でPRに人が返信するよう知らせる。Discordには通知しない。
   * noticeの記録に失敗しても、警告を残して続ける。
   */
  async function postFixReplies(newSha: string | null): Promise<void> {
    const proposeReplies = repliesToPost.filter(
      (reply) => reply.decision === "propose_issue",
    );
    const hasInlineProposal = proposeReplies.some((reply) => {
      const original = commentById.get(reply.review_comment_id);
      return original !== undefined && original.path.length > 0;
    });
    const threads = hasInlineProposal
      ? await listReviewThreadsBestEffort(
          () => listReviewThreads(client, owner, repo, pr_number),
          (message) => {
            log.warn("failed to list review threads for issue proposals", {
              error: message,
            });
          },
        )
      : [];
    const replyFailures: ReplyPostFailure[] = [];

    for (const reply of repliesToPost) {
      const original = commentById.get(reply.review_comment_id);
      const isInline = original !== undefined && original.path.length > 0;

      if (reply.decision === "propose_issue") {
        const proposal = reply.issue_proposal;
        if (proposal === null || proposal === undefined) continue;
        try {
          const proposalId = await insertIssueProposal({
            origin: "pr_fix",
            work_item_id,
            review_comment_id: reply.review_comment_id,
            thread_id: matchReviewThreadForComment(
              threads,
              reply.review_comment_id,
            ),
            title: proposal.title,
            body: proposal.body,
            is_inline: isInline,
          });
          await insertApprovalRequest({
            kind: "issue_proposal",
            work_item_id,
            subject_id: proposalId,
            payload: {},
            expires_at: null,
          });
        } catch (err) {
          const message = maskSecrets(
            err instanceof Error ? err.message : String(err),
          );
          log.error("failed to record an issue proposal; skipping its reply", {
            review_comment_id: reply.review_comment_id,
            error: message,
          });
          try {
            await addNoticeUnlessUnresolved({
              kind: "issue_proposal_record_failed",
              message: `${owner}/${repo}#${String(pr_number)} (work item ${String(work_item_id)}): 提案の記録に失敗しました: ${message}`,
            });
          } catch (noticeErr) {
            log.warn("failed to record issue_proposal_record_failed notice", {
              error: maskSecrets(
                noticeErr instanceof Error
                  ? noticeErr.message
                  : String(noticeErr),
              ),
            });
          }
          continue;
        }
      }

      const body = withMarker(
        "pr_fix",
        work_item_id,
        renderFixReply(reply, newSha),
      );
      try {
        if (isInline) {
          await replyReviewComment(
            client,
            owner,
            repo,
            pr_number,
            reply.review_comment_id,
            body,
          );
        } else {
          await postIssueComment(client, owner, repo, pr_number, body);
        }
      } catch (err) {
        const message = maskSecrets(
          err instanceof Error ? err.message : String(err),
        );
        log.warn("failed to reply to a review comment", {
          review_comment_id: reply.review_comment_id,
          error: message,
        });
        replyFailures.push({
          reviewCommentId: reply.review_comment_id,
          error: message,
        });
      }
    }

    const notice = buildReplyPostFailedNotice(
      { owner, repo, prNumber: pr_number, workItemId: work_item_id },
      replyFailures,
    );
    if (notice === null) return;
    try {
      await addNoticeUnlessUnresolved(notice);
    } catch (noticeErr) {
      log.warn("failed to record fix_reply_post_failed notice", {
        error: maskSecrets(
          noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        ),
      });
    }
  }

  /**
   * commitせずに止め、止めた理由を`status_reason`に入れる。遷移とラウンドの記録は`stopBeforeCommitTerminal`が決める。
   * workerが検査の前提を満たさないときはラウンドを記録せずに`blocked`にし、それ以外はラウンドを記録して`needs_human`にする。
   */
  async function stopBeforeCommit(
    stopReason: string,
  ): Promise<PrFixFinishResult> {
    const terminal = stopBeforeCommitTerminal(stopReason);
    if (terminal.recordsRound) {
      await insertFixRound({
        work_item_id,
        round: fix_round,
        trigger_review_ids,
        outcome: "blocked",
        replies,
        commit_shas: [],
      });
    }
    await finalizeTerminal(
      terminal.toStatus,
      terminal.discordReason,
      terminal.statusNote,
    );
    return { ok: true, final_status: terminal.toStatus, notice: stopReason };
  }

  // 検証ステップの最後の検査とこのcommitは別のジョブなので、その間にworktreeが変わっていないことを確かめる。
  // 前のステップのプロセスが残っていないこと、`.git`が準備ステップの記録と一致することを見てから、
  // commitAndPushでローカルのHEADとステージした内容を確かめる。
  const gateReason = await prFixPushGateReason(
    {
      ensureLockFree: async () => {
        await ensureWorktreeLockFree({
          run: runCommand,
          lock: worktreeLockFor(worktree_dir),
          policy: null,
          deps: defaultLockReleaseDeps(),
        });
      },
      assertGitPointer: (expected) =>
        assertWorktreeGitPointer(worktree_dir, expected),
    },
    worktree_git_pointer,
    branch,
  );
  if (gateReason !== null || branch === null) {
    return stopBeforeCommit(gateReason ?? PR_HEAD_NOT_RECORDED_REASON);
  }

  // hashの再計算の出力(根の`wmill-lock.yaml`だけの変更)は、検証のステップとは別に、PRのheadの木からもう一度再計算して照合する。
  // 照合はネットワークとgitのオブジェクトの読み取りを伴うので、リポジトリのロックの外で先に行い、
  // ロックの中では、ステージした本文が照合済みの本文と同じかだけを確かめる。
  const rehash: {
    gate: StagedRehashGate | null;
    planner: RehashPlanner | null;
  } = { gate: null, planner: null };
  if (ciRound) {
    const planner = githubRehashPlanner({
      client,
      owner,
      repo,
      prNumber: pr_number,
      headSha: head_sha,
      worktreeDir: worktree_dir,
      ghToken,
    });
    rehash.planner = planner;
    const collected = await collectCiFixChanges(
      runCommand,
      worktree_dir,
      head_sha,
      { source: "worktree" },
    );
    rehash.gate = await stagedRehashGate({
      candidate: isRehashCandidate(collected),
      confirm: () =>
        confirmRehash({
          ...planner,
          readLock: () => readRootWmillLock(worktree_dir),
        }),
      readStaged: () => readStagedRootLock(runCommandBytes, worktree_dir),
      isRehashRound: rehashRoundProbe({
        client,
        owner,
        repo,
        prNumber: pr_number,
        headSha: head_sha,
        run: runCommand,
      }),
    });
  }

  // テストの変更が、PRの基点から持っていた行を消していないかの基準。最初に要るときに1回だけ求める。
  // 求められなければnullになり、検査は基点の行を消したものとして拒否に倒れる。
  let prBaseResolved: Promise<string | null> | null = null;
  const resolvePrBaseOnce = (): Promise<string | null> => {
    prBaseResolved ??= resolvePrMergeBase(
      githubPrMergeBaseIo({
        client,
        owner,
        repo,
        prNumber: pr_number,
        headSha: head_sha,
        worktreeDir: worktree_dir,
        ghToken,
        run: runCommand,
      }),
      (reason) =>
        log.warn("failed to resolve the base commit of the PR", {
          work_item_id,
          reason,
        }),
    );
    return prBaseResolved;
  };

  // gitleaksは長くかかりうるので、`commitAndPush`のリポジトリのロックの外で先に実行する。
  const scanned = await scanPrFixBeforeCommit({
    scanForSecrets: async () => {
      const scan = await runGitleaksOnWorktree({
        run: runCommand,
        worktreeDir: worktree_dir,
        baseSha: head_sha,
        timeoutMs: GITLEAKS_TIMEOUT_MS,
      });
      if (!scan.ok) {
        // 検出はルール名とファイル名だけで、一致した文字列は含まない。
        log.warn("gitleaks found secrets in the staged fix", {
          work_item_id,
          findings: scan.output,
        });
      }
      return scan;
    },
    inspectChanges: async () => {
      const staged = await inspectStagedChanges(
        runCommand,
        worktree_dir,
        head_sha,
      );
      if (!ciRound) return staged;
      const prChangedPaths = (
        await getPrFiles(client, owner, repo, pr_number)
      ).map((file) => file.filename);
      // 理由に入るパスは秘密値の検査を通っていないので、外へ出す前に検査する。
      return await guardCiRoundReasons(
        [
          ...staged,
          ...(await inspectCiFixChanges(
            runCommand,
            worktree_dir,
            head_sha,
            prChangedPaths,
            {
              source: "staged",
              resolvePrBase: resolvePrBaseOnce,
              // ステージした本文が、照合済みの再計算の本文と同じときだけ、`wmill-lock.yaml`だけの変更を許す。
              rehashCheck: async () =>
                rehash.gate === null
                  ? { kind: "deny" }
                  : await rehash.gate.check(),
            },
          )),
        ],
        ciTextScanner(runCommand),
      );
    },
    inspectTree: (scannedTreeSha) =>
      scannedTreeStopReasons({
        run: runCommand,
        worktreeDir: worktree_dir,
        scannedTreeSha,
      }),
  });
  if (scanned.kind === "stop") return stopBeforeCommit(scanned.reason);

  if (ciRound) {
    // commitに加わる新規ファイルの名前は外へ出る。許可された新規ファイルの名前に秘密値を
    // 載せて流出させないよう、検査したツリーの新規パスを秘密値の検査にかける。
    // 時間のかかる検査なので、リポジトリのロックの外で先に行う。
    // 内容が検査したツリーのままであることは、`commitAndPush`の`expectedTreeSha`が保証する。
    const pathStop = await ciAddedPathsStopReason(
      await listCiAddedPathsInTree(
        runCommand,
        worktree_dir,
        head_sha,
        scanned.treeSha,
      ),
      ciTextScanner(runCommand),
      (rules) =>
        log.warn("a staged path matched the secret scan", {
          work_item_id,
          rules,
        }),
    );
    if (pathStop !== null) return stopBeforeCommit(pathStop);
  }

  /** pushの前後に、PRのheadが動いていたと分かったときの終わり方。ラウンドを記録して`blocked`にする。 */
  async function finishHeadChanged(
    currentSha: string,
  ): Promise<PrFixFinishResult> {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "blocked",
      replies,
      commit_shas: [],
    });
    const movedReason = `PR head moved to ${currentSha} while the fix was in progress`;
    // 競合回は、止めた理由を固定文で注記に残す。回復が注記の完全一致で行き先を決めるためである。
    await finalizeTerminal(
      "blocked",
      movedReason,
      roundStopReason(
        conflictRound,
        CONFLICT_ROUND_DETAILS.headMovedAtPush,
        reason,
      ),
    );
    return { ok: true, final_status: "blocked", notice: "head_changed" };
  }

  /**
   * 競合回の解消をpushして、作業項目を終える。
   * 検査はpushの直前に、検証のステップと同じものをもう一度行う(`runConflictPush`)。
   * - pushできた: ラウンドを記録して`rereview_requested`にする。作業項目のheadは進めない。その差が`poll_prs`の自動のレビューを起動する。
   *   再レビューの依頼も、返信も、`pr_fixed`の通知もしない。
   * - PRのheadが動いた: ラウンドを記録して`blocked`にする。
   * - baseが動いた: ラウンドを記録して`reviewed`にし、注記を残す。行の保留は付かず、次の巡回で判定し直す。
   * - workflowの権限で拒否された: ラウンドを記録して、固定の注記で`needs_human`にする。
   * - 検査や確認に通らない: pushせずに止める(`stopBeforeCommit`)。
   */
  async function finishConflictPush(): Promise<PrFixFinishResult> {
    if (
      baseline_sha === null ||
      base_sha === null ||
      auto_tree_sha === null ||
      conflicted_paths === null ||
      conflict_blobs === null
    ) {
      return stopBeforeCommit(CONFLICT_MERGE_NOT_RECORDED_REASON);
    }
    const baselineSha = baseline_sha;
    const baseSha = base_sha;
    const autoTreeSha = auto_tree_sha;
    const conflictedPaths = conflicted_paths;
    const conflictBlobs = conflict_blobs;
    const inspectDeps = gitConflictInspectDeps({
      run: runCommand,
      worktreeDir: worktree_dir,
      conflictedPaths,
      baselineSha,
      prHeadSha: head_sha,
      baseSha,
      scanText: ciTextScanner(runCommand),
      gitleaksTimeoutMs: GITLEAKS_TIMEOUT_MS,
    });
    const outcome = await runConflictPush(
      {
        // 検証ステップの最後の検査とこのpushは別のジョブなので、その間にworktreeが変わっていないことを確かめる。
        // 前のステップのプロセスが残っていないこと、`.git`と記録したブランチが準備ステップの記録のままであることを見る。
        gate: () =>
          prFixPushGateReason(
            {
              ensureLockFree: async () => {
                await ensureWorktreeLockFree({
                  run: runCommand,
                  lock: worktreeLockFor(worktree_dir),
                  policy: null,
                  deps: defaultLockReleaseDeps(),
                });
              },
              assertGitPointer: (expected) =>
                assertWorktreeGitPointer(worktree_dir, expected),
            },
            worktree_git_pointer,
            branch,
            // 注記は固定文にして、回復が準備の停止と同じ一時の停止として扱えるようにする。保持者はログに残す。
            (holder) => {
              log.warn("the worktree is in use", {
                work_item_id,
                holder,
              });
              return conflictRoundReason(CONFLICT_ROUND_DETAILS.worktreeBusy);
            },
          ),
        inspect: () =>
          inspectConflictResolution(inspectDeps, {
            conflictedPaths,
            conflictBlobs,
            autoTreeSha,
          }),
        scan: (treeSha) =>
          scanPrFixBeforeCommit({
            // 検査するのは、競合ファイルだけをステージしたツリーと基準コミットの差である。`add -A`はしない。
            scanForSecrets: async () => {
              const scan = await runGitleaksOnTreeDiff({
                run: runCommand,
                worktreeDir: worktree_dir,
                fromSha: baselineSha,
                toTreeSha: treeSha,
                timeoutMs: GITLEAKS_TIMEOUT_MS,
              });
              if (!scan.ok) {
                // 検出はルール名とファイル名だけで、一致した文字列は含まない。
                log.warn("gitleaks found secrets in the resolution", {
                  work_item_id,
                  findings: scan.output,
                });
              }
              return { ...scan, treeSha };
            },
            inspectChanges: () =>
              inspectStagedChanges(runCommand, worktree_dir, baselineSha),
            inspectTree: (scannedTreeSha) =>
              scannedTreeStopReasons({
                run: runCommand,
                worktreeDir: worktree_dir,
                scannedTreeSha,
              }),
          }),
        readPr: () => getPr(client, owner, repo, pr_number),
        ownerStop: () =>
          repoOwnerStopReason(
            config,
            owner,
            repo,
            repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
          ),
        push: (request) => {
          // 先の`gate`が、どちらの記録も確かめている。
          if (branch === null || worktree_git_pointer === null) {
            throw new Error(
              "pr_fix_finish: the branch or the git pointer was not recorded",
            );
          }
          return pushMergeCommit({
            run: runCommand,
            repoDir: repo_dir,
            dir: worktree_dir,
            branch,
            worktreeGitPointer: worktree_git_pointer,
            ghToken,
            prHeadSha: head_sha,
            baseSha,
            baseBranch: request.baseBranch,
            autoSha: baselineSha,
            expectedTreeSha: request.expectedTreeSha,
            conflictedPaths,
            instanceName: config.instance_name,
            author: gitIdentityForViewer(viewer),
            inspectStaged: request.inspectStaged,
          });
        },
      },
      { prHeadSha: head_sha, verifiedTreeSha: verified_tree_sha },
    );

    const recordRound = async (
      roundOutcome: "done" | "blocked",
      commitShas: string[],
    ): Promise<void> => {
      await insertFixRound({
        work_item_id,
        round: fix_round,
        trigger_review_ids,
        outcome: roundOutcome,
        replies: [],
        commit_shas: commitShas,
      });
    };
    switch (outcome.kind) {
      case "stop":
        return stopBeforeCommit(outcome.reason);
      case "head_changed":
        return finishHeadChanged(outcome.currentSha);
      case "base_changed": {
        const note = conflictRoundReason(CONFLICT_ROUND_DETAILS.baseChanged);
        await recordRound("blocked", []);
        await updateStatusIfCurrent(work_item_id, "fixing", "reviewed", note);
        return { ok: true, final_status: "reviewed", notice: note };
      }
      case "rejected_workflows": {
        const note = conflictRoundReason(
          CONFLICT_ROUND_DETAILS.baseChangesWorkflows,
        );
        await recordRound("blocked", []);
        await finalizeTerminal("needs_human", note, note);
        return { ok: true, final_status: "needs_human", notice: note };
      }
      case "pushed": {
        await recordRound("done", [outcome.newSha]);
        await updateStatusIfCurrent(
          work_item_id,
          "fixing",
          "rereview_requested",
          null,
        );
        return {
          ok: true,
          final_status: "rereview_requested",
          notice: null,
        };
      }
    }
  }

  if (ciRound) {
    // CI回は人の指摘に答える回ではなく、レビューを経ずにマージされうる状態では押せない。
    // commitAndPushが確かめるheadに加えて、PRの状態もpushの直前に読み直す。
    const latest = await getPr(client, owner, repo, pr_number);
    if (latest.headSha !== head_sha) return finishHeadChanged(latest.headSha);
    const pushStop = ciRoundPushGuardReason(latest, head_sha);
    if (pushStop !== null) return stopBeforeCommit(pushStop);
    // hashの再計算は、baseの先端に依る。照合した後に先端が動いていれば、pushせず、新しい先端で確かめ直す。
    // commitの親は`commitAndPush`が`head_sha`に固定し、pushは強制しないので、ブランチの先端が動いていてもpushは通らない。
    const confirmed = rehash.gate?.confirmed ?? null;
    if (confirmed !== null && rehash.planner !== null) {
      const rehashStop = await rehashPushStopReason(confirmed, rehash.planner);
      if (rehashStop !== null) return stopBeforeCommit(rehashStop);
    }
  }

  // 最初の書き込み(push)の直前に、オーナーの数値IDを照合する。
  // 準備の入口の照合から、Claudeの実行と検査を挟むので、その間に名前が別の人に渡っていても、
  // ローカルにしか無いオブジェクトを相手に渡さない。以降の返信は、このpushに続けて行う。
  const ownerStop = await repoOwnerStopReason(
    config,
    owner,
    repo,
    repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
  );
  if (ownerStop !== null) return stopBeforeCommit(ownerStop);

  let pushResult: CommitAndPushResult;
  try {
    pushResult = await commitAndPush({
      run: runCommand,
      repoDir: repo_dir,
      dir: worktree_dir,
      message: commitMessage,
      instanceName: config.instance_name,
      expectedHeadSha: head_sha,
      author: gitIdentityForViewer(viewer),
      ghToken,
      requireLocalHeadAtExpected: true,
      expectedBranch: branch,
      inspectStaged: scanned.inspectStaged,
      expectedTreeSha: scanned.treeSha,
    });
  } catch (err) {
    if (err instanceof CommitBlockedError) return stopBeforeCommit(err.message);
    throw err;
  }

  if (pushResult.outcome === "head_changed") {
    return finishHeadChanged(pushResult.currentSha);
  }

  if (pushResult.outcome === "nothing_to_commit") {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "blocked",
      replies,
      commit_shas: [],
    });
    // pushするcommitが無くても溜めた返信は投稿する。
    // Claudeがすべてを"skipped"(または差分の無い"fixed")にしたこともあり、
    // その返信も黙って捨てずにGitHubへ届ける。
    if (!ciRound) await postFixReplies(null);
    // commitするものが無いラウンドでも、Claudeが指摘を対象外と判断することがあるため、
    // push成功の経路だけでなくここでも`propose_issue`の返信を記録する。
    // `factory.issue_proposals`の行は、上の`postFixReplies`が返信の投稿前に登録済み。
    // 1件以上記録したときは、Discordの理由に汎用の「commitするものが無い」ではなく
    // 提案を挙げ、Consoleの要対応へ案内する。
    const nothingToCommitProposals = selectProposeIssueReplies(repliesToPost);
    await finalizeTerminal(
      "needs_human",
      nothingToCommitProposals.length > 0
        ? buildIssueProposalReason(nothingToCommitProposals.length)
        : nothingToCommitReason(ciRound),
    );
    return {
      ok: true,
      final_status: "needs_human",
      notice: "nothing_to_commit",
    };
  }

  // ここからはpushできたとき。
  const newSha = pushResult.newSha;
  await insertFixRound({
    work_item_id,
    round: fix_round,
    trigger_review_ids,
    outcome: "done",
    replies,
    commit_shas: [newSha],
  });

  // 修正をcommitしてpushし、きっかけのコメントに返信したので、
  // 今回のフィードバックは消費済みになる。
  // push経路でwatermarkを進めるのはここだけ(`shouldAdvanceWatermarks`の説明を参照)。
  // CI回は、返信も、作業項目のheadと処理済みの位置の更新もしない(`runPostPushBookkeeping`)。
  await runPostPushBookkeeping(ciRound, {
    postReplies: () => postFixReplies(newSha),
    setHeadSha: () => setHeadSha(work_item_id, newSha),
    bumpWatermarks: async () => {
      if (!shouldAdvanceWatermarks("push_success")) return;
      await bumpWatermarks(work_item_id, {
        last_review_id: max_review_id,
        last_comment_id: max_comment_id,
        last_review_comment_id: max_review_comment_id,
      });
    },
  });

  // このラウンドで`propose_issue`の返信を1件以上記録したら、PRはまだ再レビューに進めない。
  // 人が先にConsoleの要対応で提案したIssueを承認か却下する必要がある
  // (`approval_decide.ts`が`steps/issue_proposal_apply.ts`へ渡す)。
  // そのためrereview_requestedではなくneeds_humanで終え、下のレビュアー依頼も飛ばす。
  // この作業項目の全提案が判断されると、`issue_proposal_apply.ts`が
  // 状態をrereview_requestedに切り替える。
  // `factory.issue_proposals`の行は、上の`postFixReplies`が返信の投稿前に登録済み。
  const proposeIssueReplies = selectProposeIssueReplies(repliesToPost);
  if (proposeIssueReplies.length > 0) {
    const proposalReason = buildIssueProposalReason(proposeIssueReplies.length);
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "fixing",
      "needs_human",
      proposalReason,
    );
    if (moved) {
      const event: NotifyEvent = {
        kind: "needs_human",
        instance_name: config.instance_name,
        owner,
        repo,
        url: prUrl,
        reason: describeReason(proposalReason),
        target: { kind: "pr", number: pr_number },
        next_action: nextActionFor(proposalReason, "pr_fix"),
      };
      await notifyBestEffort(webhookUrl, event, log);
    }
    return { ok: true, final_status: "needs_human", notice: proposalReason };
  }

  const fallbackReviewers = deriveFallbackReviewers(
    reviews.map((review) => review.author),
    comments.map((comment) => comment.author),
  );
  const reviewersToRequest =
    config.default_reviewers.length > 0
      ? config.default_reviewers
      : fallbackReviewers;

  // レビュアー依頼の結果は、`work_items.status_reason`に残す。APIの失敗だけは
  // `factory.notices`とDiscordにも残す(分け方は`reportReviewerRequest`を参照)。
  // 修正自体はpushまで成功しており、影響はレビュアー依頼だけなので、
  // どの場合も作業項目は"rereview_requested"に進める。
  const reviewerReport = reportReviewerRequest(
    await requestRereview(reviewersToRequest, {
      loadAuthorLogin: async () =>
        (await getPr(client, owner, repo, pr_number)).authorLogin,
      request: (authorLogin) =>
        requestReviewers(client, owner, repo, pr_number, {
          reviewers: reviewersToRequest,
          authorLogin,
          viewer: viewer.login,
        }),
    }),
  );

  const moved = await updateStatusIfCurrent(
    work_item_id,
    "fixing",
    "rereview_requested",
    reviewerReport.note,
  );
  if (moved) {
    if (reviewerReport.note !== null && reviewerReport.noticeKind !== null) {
      try {
        await addNoticeUnlessUnresolved({
          kind: reviewerReport.noticeKind,
          message: `${owner}/${repo}#${String(pr_number)} (work item ${String(work_item_id)}): ${reviewerReport.note}`,
        });
      } catch (err) {
        log.warn("failed to record reviewer-request notice", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    const event: NotifyEvent = {
      kind: "pr_fixed",
      instance_name: config.instance_name,
      owner,
      repo,
      pr_number,
      pr_url: prUrl,
      outcome: "done",
      // ここに載せるのは再レビュー依頼のAPIの失敗だけ
      // (`reportReviewerRequest`を参照)。
      note:
        reviewerReport.apiError !== null
          ? reviewerRequestFailedSupplement(reviewerReport.apiError)
          : null,
    };
    await notifyBestEffort(webhookUrl, event, log);
  }

  return {
    ok: true,
    final_status: "rereview_requested",
    notice: reviewerReport.note,
  };
}
