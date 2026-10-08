// f/factory/pr_fixの唯一の終端ステップ。
// 最後に動いたステップ(prepare / collect / apply / verify)の結果を受けて、
// 作業項目の状態遷移、GitHubへの副作用、Discordへの通知を行う。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  addNotice,
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
import { type NotifyEvent, notify } from "../lib/discord.ts";
import {
  type GhClient,
  getPr,
  getViewer,
  gitIdentityForViewer,
  listReviewThreads,
  postIssueComment,
  replyReviewComment,
  requestReviewers,
  withMarker,
} from "../lib/github.ts";
import { GITLEAKS_TIMEOUT_MS } from "../lib/implement_loop.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import { type FixReply, isOneOf, type WorkItemStatus } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  type CommitAndPushResult,
  CommitBlockedError,
  commitAndPush,
  runCommand,
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
  inspectStagedChanges,
  inspectStagedWithSecretScan,
  listReviewThreadsBestEffort,
  matchReviewThreadForComment,
  nextActionFor,
  PR_HEAD_NOT_RECORDED_REASON,
  type PrFixFinishOutcome,
  prFixPushGateReason,
  type ReplyPostFailure,
  renderFixReply,
  rerouteRequirementsGap,
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
];

export type PrFixFinishResult = {
  readonly ok: boolean;
  readonly final_status: WorkItemStatus | null;
  readonly notice: string | null;
};

/**
 * `outcome`に応じて作業項目を遷移させ、遷移先と通知文を返す。
 * 修正があればcommitしてpushし、レビューコメントへ返信して再レビューを依頼する。
 * commitの前に、worktreeのロックを持つプロセスが無いこと、`.git`が`worktree_git_pointer`(準備ステップの記録)と一致すること、
 * ローカルのHEADが`branch`(準備ステップの記録)にあり`head_sha`であること、ステージした内容に保護パス・symlink・gitlink・`package.json`のscriptsの変更が無いことを確かめ、
 * ステージした差分をgitleaksで検査して秘密情報らしき文字列が無いこと、commitする索引が検査したツリーのままであることも確かめる。
 * どれかに通らなければcommitせずにneeds_humanにし、理由を`status_reason`に記録する。準備ステップの結果に`worktree_git_pointer`か`branch`が無いときも同じにする。
 * gitleaksの検査自体が失敗したときは、ステージを戻してから例外を投げ、何もpushしない。
 * `outcome`が想定外の値なら例外を投げる。
 * トリガーの`fix_label`は着手時に消費済みなので、終端の遷移で外すラベルは無い。
 * gtrのworktreeは消さずに残し、後で`cleanup_workspaces`が片付ける。
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
): Promise<PrFixFinishResult> {
  if (!isOneOf(outcome, ALL_OUTCOMES)) {
    throw new Error(`pr_fix_finish: unexpected outcome "${outcome}"`);
  }
  const action = decideFixFinishAction(outcome, parent_work_item_id !== null);

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
    // トリガーの`fix_label`は`poll_prs.ts`が着手時に消費済みなので、外すラベルは無い。
    // 運用上の知らせ(失敗、needs_human、blocked、requirements_gap)はPRに投稿しない。
    // PRに載せるのは一次レビューとレビューコメントへの返信だけにするため。
    // 人には下のDiscord通知で、このPRに対応が要ることを伝える。
    if (webhookUrl.length > 0) {
      try {
        const event: NotifyEvent = {
          kind: "needs_human",
          instance_name: config.instance_name,
          owner,
          repo,
          url: prUrl,
          // 日本語への変換は表示用。記録する`status_reason`は変換前の英語のまま保つ。
          reason: describeReason(discordReason),
          target: { kind: "pr", number: pr_number },
          next_action: nextActionFor(discordReason),
        };
        await notify(webhookUrl, event);
      } catch (err) {
        log.warn("discord notify failed", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }

  // `finalizeTerminal`で終わる分岐(これと、以降の"needs_human" / "blocked"のすべて)は、
  // 意図して`bumpWatermarks`を呼ばない(`shouldAdvanceWatermarks`の説明を参照)。
  // 呼ぶのは、後に出てくるrequirements_gapの差し戻し成功とpush成功の経路だけ。
  if (action.kind === "guard_blocked") {
    await finalizeTerminal("blocked", reason ?? "safety guard failed");
    return { ok: true, final_status: "blocked", notice: reason };
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
  // Claudeが提案した件名と本文は、`pr_fix_apply.ts`から`pr_fix_verify.ts`まで別々に運ばれ、
  // コミットメッセージの文字列につなぐのはここだけ。
  // Co-Authored-By / Generated-Byのトレーラーは、この後`commitAndPush`の
  // `withCommitTrailers`が足す。
  const commitMessage = composeCommitMessage(commit_subject, commit_body);

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
   * ConsoleのNoticesタブで人に失敗を知らせるため。
   * 行を登録した後に返信の投稿が失敗しても、致命的ではない。
   * GitHubに返信が出るかどうかに関わらず、提案はConsoleのInboxに見えている。
   * `thread_id`は、このラウンドの全提案で共有する1回の`listReviewThreads`から
   * ベストエフォートで求める。取得に失敗したら(rate limitを含む)`thread_id`を付けずに続ける。
   * 通常のIssueコメントにはレビュースレッドが無いので、
   * インラインの提案が1つ以上あるときだけ取得する。
   * 返信の投稿に失敗しても(rate limitを含む)ステップは止めず、残りの返信を続ける。
   * 失敗が1件以上あれば、最後に`fix_reply_post_failed`のnoticeを1件だけ記録し、
   * ConsoleのNoticesタブでPRに人が返信するよう知らせる。Discordには通知しない。
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
            await addNotice({
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
      await addNotice(notice);
    } catch (noticeErr) {
      log.warn("failed to record fix_reply_post_failed notice", {
        error: maskSecrets(
          noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        ),
      });
    }
  }

  /** commitせずに止めたラウンドを記録し、止めた理由を`status_reason`に入れてneeds_humanにする。 */
  async function stopBeforeCommit(
    stopReason: string,
  ): Promise<PrFixFinishResult> {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "blocked",
      replies,
      commit_shas: [],
    });
    const terminal = stopBeforeCommitTerminal(stopReason);
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
      inspectStaged: () =>
        inspectStagedWithSecretScan({
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
          inspectChanges: () =>
            inspectStagedChanges(runCommand, worktree_dir, head_sha),
          inspectTree: (scannedTreeSha) =>
            scannedTreeStopReasons({
              run: runCommand,
              worktreeDir: worktree_dir,
              scannedTreeSha,
            }),
        }),
    });
  } catch (err) {
    if (err instanceof CommitBlockedError) return stopBeforeCommit(err.message);
    throw err;
  }

  if (pushResult.outcome === "head_changed") {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "blocked",
      replies,
      commit_shas: [],
    });
    await finalizeTerminal(
      "blocked",
      `PR head moved to ${pushResult.currentSha} while the fix was in progress`,
    );
    return { ok: true, final_status: "blocked", notice: "head_changed" };
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
    await postFixReplies(null);
    // commitするものが無いラウンドでも、Claudeが指摘を対象外と判断することがあるため、
    // push成功の経路だけでなくここでも`propose_issue`の返信を記録する。
    // `factory.issue_proposals`の行は、上の`postFixReplies`が返信の投稿前に登録済み。
    // 1件以上記録したときは、Discordの理由に汎用の「commitするものが無い」ではなく
    // 提案を挙げ、ConsoleのInboxへ案内する。
    const nothingToCommitProposals = selectProposeIssueReplies(repliesToPost);
    await finalizeTerminal(
      "needs_human",
      nothingToCommitProposals.length > 0
        ? buildIssueProposalReason(nothingToCommitProposals.length)
        : "no changes to commit; replies posted",
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

  await postFixReplies(newSha);

  await setHeadSha(work_item_id, newSha);
  // 修正をcommitしてpushし、きっかけのコメントに返信したので、
  // 今回のフィードバックは消費済みになる。
  // push経路でwatermarkを進めるのはここだけ(`shouldAdvanceWatermarks`の説明を参照)。
  if (shouldAdvanceWatermarks("push_success")) {
    await bumpWatermarks(work_item_id, {
      last_review_id: max_review_id,
      last_comment_id: max_comment_id,
      last_review_comment_id: max_review_comment_id,
    });
  }

  // このラウンドで`propose_issue`の返信を1件以上記録したら、PRはまだ再レビューに進めない。
  // 人が先にConsoleのInboxで提案したIssueを承認か却下する必要がある
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
      if (webhookUrl.length > 0) {
        try {
          const event: NotifyEvent = {
            kind: "needs_human",
            instance_name: config.instance_name,
            owner,
            repo,
            url: prUrl,
            reason: describeReason(proposalReason),
            target: { kind: "pr", number: pr_number },
            next_action: nextActionFor(proposalReason),
          };
          await notify(webhookUrl, event);
        } catch (err) {
          log.warn("discord notify failed", {
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
      }
    }
    return { ok: true, final_status: "needs_human", notice: proposalReason };
  }

  const pr = await getPr(client, owner, repo, pr_number);
  const fallbackReviewers = deriveFallbackReviewers(
    reviews.map((review) => review.author),
    comments.map((comment) => comment.author),
  );
  const reviewersToRequest =
    config.default_reviewers.length > 0
      ? config.default_reviewers
      : fallbackReviewers;

  // `requestReviewers`の"failed"と"skipped_empty"は、GitHub上はどちらも
  // 何も起きない(レビュアーが依頼されない)ため、放っておくと痕跡が残らない。
  // `reviewerNote`に何が起きたかを入れ、`work_items.status_reason`と
  // `factory.notices`に残す。
  // 修正自体はpushまで成功しており、影響はレビュアー依頼だけなので、
  // どの場合も作業項目は"rereview_requested"に進める。
  //
  // Discordで知らせるのは、実際のAPIエラー(`outcome === "failed"`)だけ。
  // "skipped_empty"(候補が全員除外された)と候補が無い場合は想定内の結果なので、
  // 別に通知しない。通知の有無は`reviewerApiError`だけで決める。
  let reviewerNote: string | null = null;
  let reviewerApiError: string | null = null;
  if (reviewersToRequest.length === 0) {
    reviewerNote =
      "no reviewers to request (default_reviewers empty and no fallback reviewer authors)";
  } else {
    const reviewersResult = await requestReviewers(
      client,
      owner,
      repo,
      pr_number,
      {
        reviewers: reviewersToRequest,
        authorLogin: pr.authorLogin,
        viewer: viewer.login,
      },
    );
    if (reviewersResult.outcome === "failed") {
      reviewerNote = `failed to request reviewers: ${reviewersResult.error}`;
      reviewerApiError = reviewersResult.error;
    } else if (reviewersResult.outcome === "skipped_empty") {
      reviewerNote =
        "requested reviewers were all excluded (PR author / factory viewer)";
    }
  }

  const moved = await updateStatusIfCurrent(
    work_item_id,
    "fixing",
    "rereview_requested",
    reviewerNote,
  );
  if (moved) {
    if (reviewerNote !== null) {
      try {
        await addNotice({
          kind: "pr_fix_reviewer_request_failed",
          message: `${owner}/${repo}#${String(pr_number)} (work item ${String(work_item_id)}): ${reviewerNote}`,
        });
      } catch (err) {
        log.warn("failed to record reviewer-request notice", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    if (webhookUrl.length > 0) {
      try {
        const event: NotifyEvent = {
          kind: "pr_fixed",
          instance_name: config.instance_name,
          owner,
          repo,
          pr_number,
          pr_url: prUrl,
          outcome: "done",
          // ここに載せるのは再レビュー依頼のAPIの失敗だけ
          // (`reviewerApiError`の上のコメントを参照)。
          note:
            reviewerApiError !== null
              ? `再レビュー依頼のAPI呼び出しに失敗しました: ${reviewerApiError}`
              : null,
        };
        await notify(webhookUrl, event);
      } catch (err) {
        log.warn("discord notify failed", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }

  return { ok: true, final_status: "rereview_requested", notice: reviewerNote };
}
