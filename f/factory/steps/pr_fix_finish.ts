// PathScript step for f/factory/pr_fix: the single terminal step. Routes
// the merged outcome from whichever of prepare/collect/apply/verify last
// ran (spec-cycle2.md §3 M6) to the right work-item status transition,
// GitHub side effects, and Discord notice. Always removes the wip label and
// the fix_label (team-lead rule, 2026-09-26: idempotent — only a human
// re-applying the label starts a fresh cycle) on a terminal transition
// (windmill-script skill); the gtr worktree itself is left in place for
// cleanup_workspaces (M7) to sweep later.
//
// NOTE on fix_round bookkeeping: this task's instructions list
// "setFixRound(round+1)" as a step here, but poll_prs.ts already sets
// work_items.fix_round to the round *this row represents* at insert time
// (`setFixRound(workItemId, previousFixRound + 1)`), and retry_work_item.ts
// never re-touches it either — each pr_fix attempt is its own work_items
// row (spec-cycle2.md §3 M5 poll_prs, confirmed against the committed
// code), not a single row incremented in place. `latestPrWorkItem` (db.ts)
// reads fix_round from the *latest* row per PR to compute the *next*
// trigger's round number; incrementing it again here would double-count and
// drift every subsequent round's numbering. This script therefore does NOT
// call setFixRound a second time — see the implementer's report.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  addNotice,
  bumpWatermarks,
  getWorkItem,
  insertFixRound,
  setFlowJobId,
  setHeadSha,
  updateStatus,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import {
  addLabels,
  commentIssue,
  type GhClient,
  getPr,
  getViewer,
  postIssueComment,
  replyReviewComment,
  requestReviewers,
  withMarker,
} from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { type FixReply, isOneOf, type WorkItemStatus } from "../lib/types.ts";
import { commitAndPush, runCommand } from "../lib/workspace.ts";
import {
  type CollectedComment,
  type CollectedReview,
  decideFixFinishAction,
  deriveFallbackReviewers,
  describeReason,
  evaluateRelabelFailure,
  filterKnownReplies,
  type PrFixFinishOutcome,
  removeTerminalLabels,
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

export async function main(
  work_item_id: number,
  outcome: string,
  reason: string | null,
  summary: string,
  replies: FixReply[],
  commit_message: string | null,
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

  // team-lead fix round 2 item f: every terminal path bumps last_* to what
  // was actually processed this round (done / blocked / needs_human /
  // requirements_gap, and guard_blocked when collect never even ran — in
  // that last case every max_* here is still 0, via flow.yaml's `?? 0`
  // fallback, so this is a safe no-op through bumpWatermarks's own
  // GREATEST-based UPDATE). Runs unconditionally before any action.kind
  // branch below, so it always executes regardless of which one fires.
  if (max_review_id > 0 || max_comment_id > 0 || max_review_comment_id > 0) {
    await bumpWatermarks(work_item_id, {
      last_review_id: max_review_id,
      last_comment_id: max_comment_id,
      last_review_comment_id: max_review_comment_id,
    });
  }

  async function finalizeWithComment(
    toStatus: WorkItemStatus,
    commentPrefix: string,
    discordReason: string,
  ): Promise<void> {
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "fixing",
      toStatus,
      reason,
    );
    if (!moved) return;
    await removeTerminalLabels(
      client,
      owner,
      repo,
      pr_number,
      [config.wip_label, config.fix_label],
      log,
    );
    try {
      // team-lead fix round 2 item g: kind must differ from poll_prs.ts's
      // own "pr_fix" launch-comment kind (same work_item_id) — otherwise
      // commentIssue's marker-based dedup finds that comment already exists
      // and silently skips posting this one, so the terminal reason never
      // shows up on GitHub. `pr_fix-<toStatus>` mirrors pipeline_generate's
      // `issue-failed-<attempt>` / `issue-budget-<attempt>` convention of
      // encoding the distinguishing bit of context into the kind string.
      await commentIssue(
        client,
        owner,
        repo,
        pr_number,
        `pr_fix-${toStatus}`,
        work_item_id,
        reason !== null
          ? `${commentPrefix}: ${describeReason(reason)}`
          : commentPrefix,
        viewer.login,
      );
    } catch (err) {
      log.warn("failed to post pr_fix comment", {
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
    if (webhookUrl.length > 0) {
      try {
        const event: NotifyEvent = {
          kind: "needs_human",
          instance_name: config.instance_name,
          owner,
          repo,
          url: prUrl,
          // display-only Japanese mapping (team-lead follow-up) — the
          // untranslated `reason`/`discordReason` value was already recorded
          // to work_items.status_reason via updateStatusIfCurrent above.
          reason: describeReason(discordReason),
        };
        await notify(webhookUrl, event);
      } catch (err) {
        log.warn("discord notify failed", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }

  if (action.kind === "guard_blocked") {
    await finalizeWithComment(
      "blocked",
      "自動修正を開始できませんでした",
      reason ?? "safety guard failed",
    );
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
    await finalizeWithComment(
      "needs_human",
      "自動修正で人による対応が必要です",
      reason ?? "needs human attention",
    );
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
    await finalizeWithComment(
      "needs_human",
      "自動修正には要件定義の変更が必要ですが、元となる Issue が紐付いていません",
      reason ?? summary,
    );
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
      await finalizeWithComment(
        "needs_human",
        "自動修正には要件定義の変更が必要ですが、元の Issue の work item が見つかりません",
        reason ?? summary,
      );
      return { ok: true, final_status: "needs_human", notice: reason };
    }

    const gapReport = reason ?? summary;

    // team-lead fix round 2 item d [DA critical]: re-apply the parent
    // issue's wip + trigger labels *before* restarting its pipeline —
    // they were removed the first time that issue's pipeline reached a
    // terminal state, and poll_issues's reconcile (every 5 minutes) would
    // otherwise see an active work item whose issue carries no trigger
    // label and cancel the flow this step is about to start. Order below
    // ("label re-apply -> status transition -> runFlowAsync") is the
    // team-lead's explicit instruction.
    //
    // DA re-verification (fix round 2 follow-up): a failure here used to be
    // swallowed (a warn log only) and the reroute proceeded anyway — the
    // exact same reconcile-cancel race the re-apply was meant to prevent,
    // since runFlowAsync would then start a child pipeline on an issue that
    // still has no trigger label. Symmetric to retry_work_item throwing on
    // its own failure: abort the reroute and fall back to needs_human
    // (reason "relabel_failed") instead of proceeding regardless.
    let addLabelsErrorMessage: string | null = null;
    if (parentItem.issue_number !== null) {
      try {
        await addLabels(
          client,
          parentItem.owner,
          parentItem.repo,
          parentItem.issue_number,
          [config.wip_label, config.trigger_label],
        );
      } catch (err) {
        addLabelsErrorMessage = maskSecrets(
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const relabelFailedReason = evaluateRelabelFailure(
      parentItem.issue_number,
      addLabelsErrorMessage,
    );

    if (relabelFailedReason !== null) {
      log.warn(
        "aborting requirements_gap reroute: could not re-apply parent issue labels",
        {
          parent_work_item_id,
          reason: "relabel_failed",
          detail: relabelFailedReason,
        },
      );
      await finalizeWithComment(
        "needs_human",
        `自動修正には要件定義の変更が必要ですが、元の Issue へのラベル再付与に失敗しました(relabel_failed: ${describeReason(relabelFailedReason)})`,
        reason ?? summary,
      );
      return { ok: true, final_status: "needs_human", notice: reason };
    }

    await updateStatus(
      parent_work_item_id,
      "requirements_generating",
      `gap: ${gapReport}`,
    );

    // team-lead fix round 2 item j: every other DB/GitHub side effect for
    // this branch happens before runFlowAsync (the one truly irreversible,
    // externally-visible action — starting the child pipeline flow), so a
    // failure partway through never leaves a started child flow with this
    // work item's own bookkeeping (status/labels/comment) not yet recorded.
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "fixing",
      "blocked",
      `requirements_gap: rerouted to work item ${String(parent_work_item_id)}`,
    );
    if (moved) {
      await removeTerminalLabels(
        client,
        owner,
        repo,
        pr_number,
        [config.wip_label, config.fix_label],
        log,
      );
      try {
        // team-lead fix round 2 item g: distinct kind from poll_prs.ts's own
        // "pr_fix" launch comment (same work_item_id) — see finalizeWithComment's
        // comment above for why a shared kind silently dedupes away.
        await commentIssue(
          client,
          owner,
          repo,
          pr_number,
          "pr_fix-requirements_gap",
          work_item_id,
          `この PR を進めるには要件定義の変更が必要です: ${describeReason(gapReport)}。元の Issue で要件定義を再生成しています。`,
          viewer.login,
        );
      } catch (err) {
        log.warn("failed to post pr_fix comment", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }

    const childFlowJobId = await wmill.runFlowAsync("f/factory/pipeline", {
      work_item_id: parent_work_item_id,
      attempt: parentItem.attempt + 1,
      feedback: gapReport,
    });
    await setFlowJobId(parent_work_item_id, childFlowJobId);

    return { ok: true, final_status: "blocked", notice: gapReport };
  }

  // action.kind === "push"
  if (commit_message === null) {
    await finalizeWithComment(
      "needs_human",
      "自動修正は完了と報告しましたが、コミットメッセージがありませんでした",
      "done outcome missing a commit message",
    );
    return {
      ok: true,
      final_status: "needs_human",
      notice: "missing commit_message",
    };
  }

  const pushResult = await commitAndPush({
    run: runCommand,
    repoDir: repo_dir,
    dir: worktree_dir,
    message: commit_message,
    expectedHeadSha: head_sha,
    ghToken,
  });

  if (pushResult.outcome === "head_changed") {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "blocked",
      replies,
      commit_shas: [],
    });
    await finalizeWithComment(
      "blocked",
      "自動修正がブロックされました",
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
    await finalizeWithComment(
      "needs_human",
      "自動修正は完了と報告しましたが、ファイルの変更がありませんでした",
      "done outcome with no changes to commit",
    );
    return {
      ok: true,
      final_status: "needs_human",
      notice: "nothing_to_commit",
    };
  }

  // pushed
  const newSha = pushResult.newSha;
  await insertFixRound({
    work_item_id,
    round: fix_round,
    trigger_review_ids,
    outcome: "done",
    replies,
    commit_shas: [newSha],
  });

  const commentById = new Map(comments.map((comment) => [comment.id, comment]));
  // team-lead fix round 1b item 10: only act on replies whose
  // review_comment_id is one we actually collected — insertFixRound above
  // still records Claude's full raw output for audit purposes.
  const knownReplies = filterKnownReplies(replies, new Set(commentById.keys()));
  for (const reply of knownReplies) {
    const original = commentById.get(reply.review_comment_id);
    const isInline = original !== undefined && original.path.length > 0;
    const body = withMarker("pr_fix", work_item_id, reply.body);
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
      log.warn("failed to reply to a review comment", {
        review_comment_id: reply.review_comment_id,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  await setHeadSha(work_item_id, newSha);

  const pr = await getPr(client, owner, repo, pr_number);
  const fallbackReviewers = deriveFallbackReviewers(
    reviews.map((review) => review.author),
    comments.map((comment) => comment.author),
  );
  const reviewersToRequest =
    config.default_reviewers.length > 0
      ? config.default_reviewers
      : fallbackReviewers;

  // team-lead fix round 2 item h: requestReviewers's own return value used
  // to be discarded — "failed" and "skipped_empty" are both silent no-ops
  // from GitHub's perspective (no reviewer ever gets requested), which
  // previously left no trace anywhere. reviewerNote records what happened so
  // it survives in work_items.status_reason, factory.notices, and Discord;
  // the work item still moves to "rereview_requested" either way (the fix
  // itself did succeed and push — only the reviewer-request step is
  // affected), per this task's explicit instructions.
  let reviewerNote: string | null = null;
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
    await removeTerminalLabels(
      client,
      owner,
      repo,
      pr_number,
      [config.wip_label, config.fix_label],
      log,
    );
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
        };
        await notify(webhookUrl, event);
        if (reviewerNote !== null) {
          const reviewerEvent: NotifyEvent = {
            kind: "needs_human",
            instance_name: config.instance_name,
            owner,
            repo,
            url: prUrl,
            // display-only Japanese mapping (team-lead follow-up) —
            // `reviewerNote` itself stays untranslated in work_items.
            // status_reason / factory.notices (see the comment above).
            reason: describeReason(
              `could not request re-review: ${reviewerNote}`,
            ),
          };
          await notify(webhookUrl, reviewerEvent);
        }
      } catch (err) {
        log.warn("discord notify failed", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }

  return { ok: true, final_status: "rereview_requested", notice: reviewerNote };
}
