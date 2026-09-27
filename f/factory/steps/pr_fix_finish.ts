// PathScript step for f/factory/pr_fix: the single terminal step. Routes
// the merged outcome from whichever of prepare/collect/apply/verify last
// ran (spec-cycle2.md §3 M6) to the right work-item status transition,
// GitHub side effects, and Discord notice. The fix_label trigger was
// already consumed at claim time (poll_prs.ts, 2026-09-27 PR label
// cleanup), so there is no label left to remove on a terminal transition;
// the gtr worktree itself is left in place for cleanup_workspaces (M7) to
// sweep later.
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
  insertApprovalRequest,
  insertFixRound,
  insertIssueProposal,
  setFlowJobId,
  setHeadSha,
  updateStatus,
  updateStatusIfCurrent,
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
import { logger, maskSecrets } from "../lib/log.ts";
import { type FixReply, isOneOf, type WorkItemStatus } from "../lib/types.ts";
import { commitAndPush, runCommand } from "../lib/workspace.ts";
import {
  buildIssueProposalReason,
  type CollectedComment,
  type CollectedReview,
  composeCommitMessage,
  decideFixFinishAction,
  deriveFallbackReviewers,
  describeReason,
  evaluateRerouteGuard,
  filterKnownReplies,
  matchReviewThreadForComment,
  nextActionFor,
  type PrFixFinishOutcome,
  renderFixReply,
  selectProposeIssueReplies,
  shouldAdvanceWatermarks,
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

  // team-lead fix (2026-09-26): watermarks are no longer bumped
  // unconditionally here — see shouldAdvanceWatermarks's doc comment
  // (pr_workflow_support.ts) for why, and each of the two call sites below
  // (requirements_gap reroute success, push success) for where they now
  // advance instead.

  async function finalizeTerminal(
    toStatus: WorkItemStatus,
    discordReason: string,
  ): Promise<void> {
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "fixing",
      toStatus,
      reason,
    );
    if (!moved) return;
    // 2026-09-27 PR label cleanup: the fix_label trigger was already
    // consumed at claim time (poll_prs.ts), so there is no label left to
    // remove here — a human sees this PR needs attention via the Discord
    // notification below instead.
    // team-lead decision (2026-09-26): operational notices (failure,
    // needs_human, blocked, requirements_gap) are never posted to the PR —
    // it must carry only the first-pass review itself and replies to review
    // comments. This information reaches the operator via the Discord
    // notify() call below instead.
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

  // Every branch below that terminates via finalizeTerminal (this action, and
  // every "needs_human"/"blocked" outcome further down) deliberately never
  // calls bumpWatermarks — see shouldAdvanceWatermarks's doc comment in
  // pr_workflow_support.ts. Only the requirements_gap reroute success path
  // and the push success path (both further down) do.
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

    // 2026-09-27 label policy: neither the parent issue's `factory` label
    // nor this PR's `factory:fix` label are re-applied or removed any more
    // (both are consumed on claim and nothing restores them) — the old
    // "re-apply wip + trigger" step is gone, since it would leave a
    // permanent trigger label behind and get the issue re-claimed after its
    // next terminal state. The only remaining precondition is that the
    // parent work item actually is an issue.
    const rerouteGuardReason = evaluateRerouteGuard(parentItem.issue_number);

    if (rerouteGuardReason !== null) {
      log.warn(
        "aborting requirements_gap reroute: parent work item has no issue",
        {
          parent_work_item_id,
          reason: "no_parent_issue",
          detail: rerouteGuardReason,
        },
      );
      await finalizeTerminal("needs_human", reason ?? summary);
      return { ok: true, final_status: "needs_human", notice: reason };
    }

    // team-lead fix (2026-09-26): this round's feedback is consumed by the
    // reroute itself (the parent issue's requirements are being regenerated
    // to address it), so the watermarks advance here — see
    // shouldAdvanceWatermarks's doc comment (pr_workflow_support.ts).
    if (shouldAdvanceWatermarks("requirements_gap_reroute_success")) {
      await bumpWatermarks(work_item_id, {
        last_review_id: max_review_id,
        last_comment_id: max_comment_id,
        last_review_comment_id: max_review_comment_id,
      });
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
    // work item's own bookkeeping (status/labels not yet recorded).
    //
    // team-lead decision (2026-09-26): no PR comment is posted here — the PR
    // must carry only the first-pass review and replies to review comments.
    // The reroute is visible via the parent issue's own requirements_gap
    // notice and the Discord notification pipeline_generate posts for it.
    await updateStatusIfCurrent(
      work_item_id,
      "fixing",
      "blocked",
      `requirements_gap: rerouted to work item ${String(parent_work_item_id)}`,
    );
    const childFlowJobId = await wmill.runFlowAsync("f/factory/pipeline", {
      work_item_id: parent_work_item_id,
      attempt: parentItem.attempt + 1,
      feedback: gapReport,
    });
    await setFlowJobId(parent_work_item_id, childFlowJobId);

    return { ok: true, final_status: "blocked", notice: gapReport };
  }

  // action.kind === "push"
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
  // team-lead decision (2026-09-26): pr_fix_apply.ts/pr_fix_verify.ts now
  // carry Claude's proposed commit_subject/commit_body as separate fields
  // end to end; this is the one place they're joined into the literal
  // commit message text (composeCommitMessage) — commitAndPush's own
  // withCommitTrailers still appends the Co-Authored-By/Generated-By
  // trailers after this.
  const commitMessage = composeCommitMessage(commit_subject, commit_body);

  const commentById = new Map(comments.map((comment) => [comment.id, comment]));
  // team-lead fix round 1b item 10: only act on replies whose
  // review_comment_id is one we actually collected — insertFixRound below
  // still records Claude's full raw output for audit purposes.
  const repliesToPost = filterKnownReplies(
    replies,
    new Set(commentById.keys()),
  );

  /**
   * Posts every queued reply to GitHub — inline reply to the review comment
   * it addresses, or a plain issue comment when the original wasn't inline
   * (`original.path` empty). `newSha` is the commit the fix produced, or
   * `null` when there is nothing to point to (team-lead fix: the
   * `nothing_to_commit` branch below now also posts replies — e.g. when
   * Claude marked every one "skipped" — instead of dropping them silently).
   * Shared by the push-success and nothing_to_commit paths so a queued
   * reply reaches GitHub either way.
   *
   * For a `propose_issue` reply (team-lead fix round, [MUST] #3 "Proposal
   * rows must never be silently lost"), the `factory.issue_proposals` row is
   * inserted *before* its reply is posted: if the insert throws, the reply
   * for that item is skipped entirely (never posted) and an
   * `issue_proposal_record_failed` notice is recorded, so a human sees the
   * failure via the Console Notices tab instead of a PR comment promising an
   * Issue review that was never actually recorded anywhere. If posting the
   * reply itself then fails (the row already exists), that is not fatal —
   * the proposal is already visible in the Console Inbox regardless of
   * whether GitHub ever shows its reply. `thread_id` is resolved best-effort
   * via a single `listReviewThreads` call, reused across every proposal this
   * round (only fetched when at least one proposal is inline — a plain issue
   * comment has no review thread at all).
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
      ? await listReviewThreads(client, owner, repo, pr_number)
      : [];

    for (const reply of repliesToPost) {
      const original = commentById.get(reply.review_comment_id);
      const isInline = original !== undefined && original.path.length > 0;

      if (reply.decision === "propose_issue") {
        const proposal = reply.issue_proposal;
        if (proposal === null || proposal === undefined) continue;
        try {
          const proposalId = await insertIssueProposal({
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
        log.warn("failed to reply to a review comment", {
          review_comment_id: reply.review_comment_id,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }

  const pushResult = await commitAndPush({
    run: runCommand,
    repoDir: repo_dir,
    dir: worktree_dir,
    message: commitMessage,
    instanceName: config.instance_name,
    expectedHeadSha: head_sha,
    author: gitIdentityForViewer(viewer),
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
    // team-lead fix: post the queued replies even though there is no commit
    // to push — Claude may have marked every one "skipped" (or "fixed" with
    // no actual diff), and those replies must still reach GitHub instead of
    // being silently dropped.
    await postFixReplies(null);
    // User decision (2026-09-26): a propose_issue reply is recorded here too
    // (not just on the push-success path below) — Claude can decide a
    // finding is out of scope even on a round that ends up with nothing to
    // commit. `postFixReplies` above already inserted the
    // factory.issue_proposals row(s) before posting their replies (team-lead
    // fix round, [MUST] #3). When at least one was recorded, the Discord
    // reason names the proposal(s) instead of the generic "nothing to
    // commit" text, so the notification points the operator at the Console
    // Inbox.
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

  await postFixReplies(newSha);

  await setHeadSha(work_item_id, newSha);
  // team-lead fix (2026-09-26): this round's feedback is now consumed — the
  // fix was committed, pushed, and replies were posted to the comments that
  // triggered it — so the watermarks advance here, and only here, for the
  // push path. See shouldAdvanceWatermarks's doc comment
  // (pr_workflow_support.ts).
  if (shouldAdvanceWatermarks("push_success")) {
    await bumpWatermarks(work_item_id, {
      last_review_id: max_review_id,
      last_comment_id: max_comment_id,
      last_review_comment_id: max_review_comment_id,
    });
  }

  // User decision (2026-09-26): when this round recorded one or more
  // propose_issue replies, the PR is not ready for re-review yet — a human
  // must first approve or reject the proposed Issue(s) from the Console
  // Inbox (approval_decide.ts, which dispatches to
  // steps/issue_proposal_apply.ts). The round ends needs_human instead of
  // rereview_requested, and the reviewer-request step below is skipped
  // entirely; issue_proposal_apply.ts swaps the status to rereview_requested
  // once every proposal for this work item has been decided.
  // `postFixReplies` above already inserted the factory.issue_proposals
  // row(s) before posting their replies (team-lead fix round, [MUST] #3).
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

  // team-lead fix round 2 item h: requestReviewers's own return value used
  // to be discarded — "failed" and "skipped_empty" are both silent no-ops
  // from GitHub's perspective (no reviewer ever gets requested), which
  // previously left no trace anywhere. reviewerNote records what happened so
  // it survives in work_items.status_reason, factory.notices, and Discord;
  // the work item still moves to "rereview_requested" either way (the fix
  // itself did succeed and push — only the reviewer-request step is
  // affected), per this task's explicit instructions.
  //
  // team-lead decision (2026-09-26): only an actual API error
  // (reviewersResult.outcome === "failed") is worth telling the operator
  // about via Discord — "skipped_empty" (every candidate excluded) and "no
  // candidates at all" are both silent, expected outcomes the
  // factory:rereview state label already fully explains, so they no longer
  // produce a separate Discord notification (`reviewerApiError` alone
  // drives that; `reviewerNote` still records every case in
  // work_items.status_reason / factory.notices as before).
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
          // team-lead decision (2026-09-26): only a re-review request API
          // failure surfaces here — see the comment above reviewerApiError.
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
