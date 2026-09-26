// Manual approve/reject of a pending factory.issue_proposals row (user
// decision, 2026-09-26): pr_fix's `"propose_issue"` FixReply records a
// candidate GitHub Issue (title + body) for a finding that is valid but out
// of the originating PR's scope. A human decides from the Console Inbox
// (same framework as requirement-draft approval, approval_decide.ts):
//
//   - approve: creates the Issue in the PR's repo (optionally with
//     `factory_config.trigger_label`, so it enters the requirements
//     pipeline the same way a human-labeled Issue would), replies in the
//     review thread naming the new Issue, and resolves the thread.
//   - reject: replies in the review thread with the human's reason and
//     leaves the thread open (a human, not the factory, decides what
//     happens to it next).
//
// Once every pending proposal for the underlying work item has been
// decided, the PR's state label swaps off `needs_human_label` — to
// `rereview_label` when the round that produced the proposal(s) also pushed
// a commit, or `reviewed_label` when it did not (see
// decideIssueProposalLabelSwap, pr_workflow_support.ts).
//
// Note (docs/security.md): Issue creation uses the same GitHub PAT as every
// other factory-authored GitHub call — no separate credential.
//
// `decided_by` is derived fail-closed from the job's own Windmill run
// context (team-lead fix round, [MUST] #1 — `deriveApprover`,
// lib/approver.ts, shared with approval_decide.ts), never a bare
// `process.env.WM_USERNAME ?? "unknown"`: a decision must never be recorded
// under an unidentified approver.
//
// Idempotency (team-lead fix round, [MUST] #2 "Approve path must be
// idempotent"): a proposal row already read as "pending" is classified via
// `classifyIssueProposalDecision` (pr_workflow_support.ts) before any write
// happens, refusing outright a call that would conflict with (or duplicate)
// an already-completed decision. The approve path itself proceeds in two
// separate writes so a crash between them is recoverable: (a)
// `decideIssueProposal` transitions the row to "approved" — guarded by
// `WHERE status = 'pending'`, an optimistic lock — with `created_issue_*`
// still null; (b) once GitHub confirms the Issue exists (created fresh, or
// found via `findIssueByMarker`'s search for the
// `<!-- factory:issue_proposal:<id> -->` marker this script embeds in the
// body), `setIssueProposalCreatedIssue` writes `created_issue_number`/
// `created_issue_url` back. A retry that lands after (a) but before (b)
// resumes at the Issue create-or-reuse step instead of creating a second
// Issue. The reject path similarly records the decision first, then posts
// the reply.
//
// The GitHub comment a proposal's reply is threaded under
// (`review_comment_id`) may be either a PR review comment or a plain issue
// comment (pr_fix's two reply targets — see pr_workflow_support.ts's
// FixReply doc comment); which kind it is is now persisted on the row itself
// (`is_inline`, set by pr_fix_finish.ts at insert time — team-lead fix
// round, [MUST] #4), so this script picks the reply mechanism
// deterministically (`chooseIssueProposalReplyTarget`) instead of guessing
// with a try/replyReviewComment-then-fallback-to-postIssueComment dance.

import * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import { loadConfig } from "./lib/config.ts";
import {
  countPendingIssueProposals,
  decideIssueProposal,
  getIssueProposal,
  getWorkItem,
  latestFixRound,
  setIssueProposalCreatedIssue,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import {
  createIssue,
  findIssueByMarker,
  type GhClient,
  postIssueComment,
  replyReviewComment,
  resolveReviewThread,
  withMarker,
} from "./lib/github.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import { isOneOf } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";
import {
  appendIssueProposalMarker,
  assertValidIssueProposalDecideInput,
  buildIssueProposalBody,
  chooseIssueProposalReplyTarget,
  classifyIssueProposalDecision,
  decideIssueProposalLabelSwap,
  hasIssueProposalMarker,
  issueProposalMarkerSearchTerm,
  renderIssueProposalApprovedReply,
  renderIssueProposalRejectedReply,
  setStateLabel,
} from "./steps/pr_workflow_support.ts";

const DECISIONS = ["approve", "reject"] as const;

export type IssueProposalDecideResult = {
  readonly ok: boolean;
  readonly status: string;
};

export async function main(
  proposal_id: number,
  decision: string,
  reason: string,
  with_factory_label: boolean,
): Promise<IssueProposalDecideResult> {
  if (!isOneOf(decision, DECISIONS)) {
    throw new Error(
      `issue_proposal_decide: "decision" must be "approve" or "reject" (got ${JSON.stringify(decision)})`,
    );
  }
  assertValidIssueProposalDecideInput({ decision, reason });

  const proposal = await getIssueProposal(proposal_id);
  if (proposal === null) {
    throw new Error(
      `issue_proposal_decide: no issue proposal with id ${proposal_id}`,
    );
  }

  const classification = classifyIssueProposalDecision(proposal, {
    decision,
    reason,
    with_factory_label,
  });
  if (classification.action === "refuse") {
    throw new Error(`issue_proposal_decide: ${classification.message}`);
  }

  const workItem = await getWorkItem(proposal.work_item_id);
  if (workItem === null) {
    throw new Error(
      `issue_proposal_decide: work item ${proposal.work_item_id} for issue proposal ${proposal_id} not found`,
    );
  }
  if (workItem.pr_number === null) {
    throw new Error(
      `issue_proposal_decide: work item ${proposal.work_item_id} has no pr_number`,
    );
  }
  const prNumber = workItem.pr_number;
  const owner = workItem.owner;
  const repo = workItem.repo;
  const workItemId = workItem.id;
  const reviewCommentId = proposal.review_comment_id;
  const isInline = proposal.is_inline;
  const threadId = proposal.thread_id;

  const log = logger("issue_proposal_decide");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const decidedBy = deriveApprover({
    WM_USERNAME: process.env.WM_USERNAME,
    WM_EMAIL: process.env.WM_EMAIL,
  });
  const prUrl = `https://github.com/${owner}/${repo}/pull/${String(prNumber)}`;

  async function postDecisionReply(body: string): Promise<void> {
    const target = chooseIssueProposalReplyTarget(isInline);
    if (target === "inline") {
      await replyReviewComment(
        client,
        owner,
        repo,
        prNumber,
        reviewCommentId,
        body,
      );
    } else {
      await postIssueComment(client, owner, repo, prNumber, body);
    }
  }

  if (decision === "approve") {
    // Optimistic lock (team-lead fix round, [MUST] #2): only actually
    // transitions the row when it is still "pending". `classification`
    // above already ruled out every case where this call would be wrong (a
    // genuine conflict, or an already-completed approval), so a `false`
    // return here means a concurrent/earlier call already made the same
    // transition — the rest of this branch still runs (idempotently)
    // regardless of which of the two won.
    await decideIssueProposal(proposal_id, {
      status: "approved",
      decided_by: decidedBy,
      decision_reason: null,
      with_factory_label,
      created_issue_number: null,
      created_issue_url: null,
    });

    const current = await getIssueProposal(proposal_id);
    if (current === null) {
      throw new Error(
        `issue_proposal_decide: issue proposal ${proposal_id} disappeared mid-decision`,
      );
    }

    let created: { readonly number: number; readonly htmlUrl: string };
    if (current.created_issue_number !== null) {
      created = {
        number: current.created_issue_number,
        htmlUrl: current.created_issue_url ?? "",
      };
    } else {
      const markerSearchTerm = issueProposalMarkerSearchTerm(proposal_id);
      const existingIssue = await findIssueByMarker(
        client,
        owner,
        repo,
        markerSearchTerm,
      );
      if (
        existingIssue !== null &&
        hasIssueProposalMarker(existingIssue.body, proposal_id)
      ) {
        created = existingIssue;
      } else {
        const withLabel = current.with_factory_label ?? false;
        const body = appendIssueProposalMarker(
          buildIssueProposalBody(proposal.body, prUrl, prNumber),
          proposal_id,
        );
        created = await createIssue(client, owner, repo, {
          title: proposal.title,
          body,
          ...(withLabel ? { labels: [config.trigger_label] } : {}),
        });
      }
      await setIssueProposalCreatedIssue(proposal_id, {
        created_issue_number: created.number,
        created_issue_url: created.htmlUrl,
      });
    }

    const replyBody = withMarker(
      "pr_fix",
      workItemId,
      renderIssueProposalApprovedReply(created.number),
    );
    await postDecisionReply(replyBody);
    if (threadId !== null) {
      try {
        await resolveReviewThread(client, threadId);
      } catch (err) {
        log.warn("failed to resolve the review thread", {
          thread_id: threadId,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  } else {
    // Reject ordering (team-lead fix round, [MUST] #2): record the decision
    // first, then reply — same crash-recoverable shape as approve above.
    await decideIssueProposal(proposal_id, {
      status: "rejected",
      decided_by: decidedBy,
      decision_reason: reason,
      with_factory_label: null,
      created_issue_number: null,
      created_issue_url: null,
    });
    const replyBody = withMarker(
      "pr_fix",
      workItemId,
      renderIssueProposalRejectedReply(reason),
    );
    await postDecisionReply(replyBody);
  }

  const remaining = await countPendingIssueProposals(workItemId);
  const round = await latestFixRound(workItemId);
  const committedThisRound = (round?.commit_shas.length ?? 0) > 0;
  const labelDecision = decideIssueProposalLabelSwap(
    remaining,
    committedThisRound,
  );
  if (labelDecision.action === "swap") {
    const label =
      labelDecision.toStatus === "rereview_requested"
        ? config.rereview_label
        : config.reviewed_label;
    await setStateLabel(client, owner, repo, prNumber, config, label, log);
    await updateStatusIfCurrent(
      workItemId,
      "needs_human",
      labelDecision.toStatus,
      `issue_proposal_decide: every issue proposal decided (${labelDecision.toStatus})`,
    );

    // team-lead fix round, IMO #5: a tiny window remains between the count
    // above and the label/status writes just made, during which another
    // pr_fix round could record a brand-new pending proposal for this same
    // work item. Re-checking once more here catches that: if a new pending
    // proposal appeared, put the PR straight back to needs_human_label
    // rather than leaving a state label that implies "nothing pending" when
    // one actually is. Not a full fix (a still-tinier window remains
    // between this re-check and its own writes) — no transaction machinery,
    // per this task's explicit instructions.
    const recheck = await countPendingIssueProposals(workItemId);
    if (recheck > 0) {
      await setStateLabel(
        client,
        owner,
        repo,
        prNumber,
        config,
        config.needs_human_label,
        log,
      );
      await updateStatusIfCurrent(
        workItemId,
        labelDecision.toStatus,
        "needs_human",
        "issue_proposal_decide: a new issue proposal appeared during the label swap",
      );
    }
  }

  return { ok: true, status: decision === "approve" ? "approved" : "rejected" };
}
