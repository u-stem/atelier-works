// Handler script for a decided `kind = "issue_proposal"` factory.
// approval_requests row — dispatched by f/factory/approval_decide.ts via
// `wmill.runScriptByPathAsync` right after it records the human's decision.
// Replaces the former f/factory/issue_proposal_decide.ts (now deleted),
// which used to be the manually-invoked, self-contained approve/reject
// script; approval_decide.ts now owns input validation, idempotency
// classification at the approval_requests level, and identity derivation —
// this script only carries out the GitHub/DB side effects once a decision is
// already on record:
//
//   - approve: creates the Issue in the target repo (optionally with
//     `factory_config.trigger_label`, so it enters the requirements
//     pipeline the same way a human-labeled Issue would); for a `pr_fix`
//     proposal, also replies in the review thread naming the new Issue and
//     resolves the thread.
//   - reject: for a `pr_fix` proposal, replies in the review thread with
//     the human's reason and leaves the thread open (a human, not the
//     factory, decides what happens to it next).
//
// Origin branching (`IssueProposal.origin`, lib/types.ts; 工程5 audit): a
// `pr_fix` proposal is threaded under a GitHub review/issue comment on its
// originating PR — the Issue body embeds that PR's URL/number
// (`buildIssueProposalBody`), and the reply/thread-resolve above run
// against `review_comment_id`/`thread_id`. An `audit` proposal instead
// comes from a `factory.audit_reports` row (no originating PR, no thread):
// the Issue body cites the audited period instead
// (`buildAuditProposalBody` + `formatAuditPeriodLabel`,
// lib/audit_support.ts), and the reply/resolve step is skipped outright —
// there is nothing to reply into. The Issue itself is created in
// `factory_config.factory_repo` (an `audit` work item's own `owner`/`repo`
// are set to that repo at creation), so attaching `trigger_label` also
// requires that repo to be `isRepoAllowed` (lib/config.ts) —
// `resolveFactoryLabel` below refuses the label (logging a warning) rather
// than attaching it to a disallowed repo; a `pr_fix` proposal has no such
// restriction, since its PR's repo was already gated far earlier in that
// pipeline.
//
// Once every pending proposal for the underlying work item has been
// decided, the work item's status swaps off its waiting status
// (`decidePostProposalTransition`, pr_workflow_support.ts, kind-aware): a
// `pr_fix`/`pr_review` work item moves off `needs_human` — to
// `rereview_requested` when the round that produced the proposal(s) also
// pushed a commit, or `reviewed` when it did not; an `audit` work item
// moves off `awaiting_approval` straight to `audited` (it has no fix round
// to check). 2026-09-27 PR label cleanup: this used to also swap a PR
// state label; there is no more state label to swap.
//
// Note (docs/security.md): Issue creation uses the same GitHub PAT as every
// other factory-authored GitHub call — no separate credential.
//
// factory.issue_proposals remains the source of truth for
// title/body/review_comment_id/thread_id (approval_requests does not
// duplicate them) and still carries its own status/decided_by/
// decision_reason/with_factory_label columns, kept in sync here via
// decideIssueProposal — factory.v_issue_proposals and
// countPendingIssueProposals both read this table directly, unchanged from
// before this script existed.
//
// Idempotency: a proposal row already read as "pending" is classified via
// `classifyIssueProposalDecision` (pr_workflow_support.ts) before any write
// happens, refusing outright a call that would conflict with (or duplicate)
// an already-completed decision. The approve path itself proceeds in two
// separate writes so a crash/retried dispatch between them is recoverable:
// (a) `decideIssueProposal` transitions the row to "approved" — guarded by
// `WHERE status = 'pending'`, an optimistic lock — with `created_issue_*`
// still null; (b) once GitHub confirms the Issue exists (created fresh, or
// found via `findIssueByMarker`'s search for the
// `<!-- factory:issue_proposal:<id> -->` marker this script embeds in the
// body), `setIssueProposalCreatedIssue` writes `created_issue_number`/
// `created_issue_url` back. A retried dispatch that lands after (a) but
// before (b) resumes at the Issue create-or-reuse step instead of creating a
// second Issue. The reject path similarly records the decision first, then
// posts the reply.
//
// Keeping an incomplete approval visible: if the Issue create-or-reuse step
// itself throws — e.g. GitHub returns an error creating the Issue — before
// any Issue number is known, the row is reverted back to "pending"
// (`revertIssueProposalToPending`, lib/db.ts) rather than left stuck
// "approved" with `created_issue_number` still null, which the Console
// Inbox would otherwise show nowhere. console_query.ts's "inbox" view also
// surfaces an "approved" row whose Issue was never created, so even the
// (rarer) case where a later step — `setIssueProposalCreatedIssue`'s own
// write, the reply, resolving the thread, or the label swap — fails after
// the Issue already exists on GitHub still leaves the proposal visible for a
// human to retry; that later case is intentionally never reverted, since the
// Issue already exists and a revert-then-recreate would risk a duplicate.
//
// The GitHub comment a proposal's reply is threaded under
// (`review_comment_id`) may be either a PR review comment or a plain issue
// comment (pr_fix's two reply targets — see pr_workflow_support.ts's
// FixReply doc comment); which kind it is is persisted on the row itself
// (`is_inline`, set by pr_fix_finish.ts at insert time), so this script
// picks the reply mechanism deterministically (`chooseIssueProposalReplyTarget`)
// instead of guessing with a try/replyReviewComment-then-fallback-to-
// postIssueComment dance.
//
// Failure handling: this script runs standalone (not as a flow step), so a
// thrown error is caught here, recorded to factory.job_failures, and
// reported to Discord before being re-thrown (mirrors
// on_error_schedule.ts's own self-contained handling).

import * as wmill from "windmill-client@1.817.0";
import { formatAuditPeriodLabel } from "../lib/audit_support.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  countPendingIssueProposals,
  decideIssueProposal,
  getApprovalRequest,
  getAuditReportByWorkItem,
  getIssueProposal,
  getWorkItem,
  latestFixRound,
  recordFailure,
  revertIssueProposalToPending,
  setIssueProposalCreatedIssue,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import {
  createIssue,
  findIssueByMarker,
  type GhClient,
  postIssueComment,
  replyReviewComment,
  resolveReviewThread,
  withMarker,
} from "../lib/github.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { type IssueProposalOrigin, isBoolean } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  appendIssueProposalMarker,
  buildAuditProposalBody,
  buildIssueProposalBody,
  buildIssueProposalTitle,
  chooseIssueProposalReplyTarget,
  classifyIssueProposalDecision,
  decidePostProposalTransition,
  hasIssueProposalMarker,
  issueProposalMarkerSearchTerm,
  renderIssueProposalApprovedReply,
  renderIssueProposalRejectedReply,
} from "./pr_workflow_support.ts";

export type IssueProposalApplyResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly label_applied: boolean;
};

/** Reads `decision_options.with_factory_label` (a decider-side
 * approval_requests field) with a type guard, defaulting to `false` when
 * absent or not a boolean (pure, for testing). */
export function readWithFactoryLabel(
  decisionOptions: Record<string, unknown>,
): boolean {
  return isBoolean(decisionOptions.with_factory_label)
    ? decisionOptions.with_factory_label
    : false;
}

/** Whether to attach `factory_config.trigger_label` to the Issue this
 * approval creates: a `pr_fix` proposal follows the requester's own
 * checkbox unconditionally, but an `audit` proposal's Issue lands in
 * whatever repo `factory_config.factory_repo` names — the same repo an
 * `audit` work item's `owner`/`repo` are set to (工程5) — so it is only
 * allowed to re-enter the requirements pipeline (via the trigger label)
 * when that repo is itself allowed by `factory_config` (owners /
 * repo_allowlist); refusing otherwise, rather than silently dropping the
 * label, is surfaced to the caller as a `reason` to log (pure, for
 * testing). */
export function resolveFactoryLabel(input: {
  readonly requested: boolean;
  readonly origin: IssueProposalOrigin;
  readonly repoAllowed: boolean;
}): { readonly apply: boolean; readonly reason: string | null } {
  if (!input.requested) return { apply: false, reason: null };
  if (input.origin === "audit" && !input.repoAllowed) {
    return {
      apply: false,
      reason:
        "factory_repo is not allowed by factory_config (owners / repo_allowlist)",
    };
  }
  return { apply: true, reason: null };
}

/** Narrows `workItem.pr_number` to `number`, throwing the same invariant
 * violation the original single, unconditional check used to raise — now
 * only reachable from a `pr_fix` proposal's branches, since an `audit`
 * proposal's work item legitimately has no `pr_number` (pure aside from the
 * throw; not itself unit-tested, matching `run`). */
function requirePrNumber(prNumber: number | null, workItemId: number): number {
  if (prNumber === null) {
    throw new Error(
      `issue_proposal_apply: work item ${workItemId} has no pr_number`,
    );
  }
  return prNumber;
}

async function run(
  approval_request_id: number,
  log: Logger,
): Promise<IssueProposalApplyResult> {
  const request = await getApprovalRequest(approval_request_id);
  if (request === null) {
    throw new Error(
      `issue_proposal_apply: no approval request with id ${approval_request_id}`,
    );
  }
  if (request.kind !== "issue_proposal") {
    throw new Error(
      `issue_proposal_apply: approval request ${approval_request_id} has kind "${request.kind}", expected "issue_proposal"`,
    );
  }
  if (request.status !== "approved" && request.status !== "rejected") {
    log.info("approval request is not decided, no-op", {
      approval_request_id,
      status: request.status,
    });
    return { ok: true, status: "no_op", label_applied: false };
  }
  if (request.decided_by === null) {
    throw new Error(
      `issue_proposal_apply: approval request ${approval_request_id} is decided but has no decided_by`,
    );
  }
  const decidedBy = request.decided_by;
  const decision = request.status === "approved" ? "approve" : "reject";
  const reason = request.reason ?? "";
  const withFactoryLabel = readWithFactoryLabel(request.decision_options);

  const proposal_id = request.subject_id;
  const proposal = await getIssueProposal(proposal_id);
  if (proposal === null) {
    throw new Error(
      `issue_proposal_apply: no issue proposal with id ${proposal_id}`,
    );
  }

  const classification = classifyIssueProposalDecision(proposal, {
    decision,
    reason,
    with_factory_label: withFactoryLabel,
  });
  if (classification.action === "refuse") {
    throw new Error(`issue_proposal_apply: ${classification.message}`);
  }
  if (classification.action === "already_done") {
    // A redispatch of an identical, fully completed decision (e.g. a
    // double click in the Console): nothing to do, and not a failure.
    log.info("issue proposal already applied, no-op", {
      proposal_id,
      created_issue_number: classification.created_issue_number,
    });
    return { ok: true, status: "no_op", label_applied: false };
  }

  const workItem = await getWorkItem(proposal.work_item_id);
  if (workItem === null) {
    throw new Error(
      `issue_proposal_apply: work item ${proposal.work_item_id} for issue proposal ${proposal_id} not found`,
    );
  }
  const owner = workItem.owner;
  const repo = workItem.repo;
  const workItemId = workItem.id;

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  // Issue body: a pr_fix proposal embeds the originating PR's own URL/number
  // (buildIssueProposalBody); an audit proposal has no PR to link, so it
  // names the audited period instead (buildAuditProposalBody, sourced from
  // the audit report this proposal was raised from).
  let body: string;
  if (proposal.origin === "pr_fix") {
    const prNumber = requirePrNumber(workItem.pr_number, proposal.work_item_id);
    const prUrl = `https://github.com/${owner}/${repo}/pull/${String(prNumber)}`;
    body = buildIssueProposalBody(proposal.body, prUrl, prNumber);
  } else {
    const report = await getAuditReportByWorkItem(workItem.id);
    if (report === null) {
      throw new Error(
        `issue_proposal_apply: audit report for work item ${String(workItem.id)} not found`,
      );
    }
    body = buildAuditProposalBody(
      proposal.body,
      formatAuditPeriodLabel(report.period_start, report.period_end),
    );
  }
  body = appendIssueProposalMarker(body, proposal_id);

  async function postDecisionReply(
    p: { readonly review_comment_id: number; readonly is_inline: boolean },
    prNumber: number,
    replyBody: string,
  ): Promise<void> {
    const target = chooseIssueProposalReplyTarget(p.is_inline);
    if (target === "inline") {
      await replyReviewComment(
        client,
        owner,
        repo,
        prNumber,
        p.review_comment_id,
        replyBody,
      );
    } else {
      await postIssueComment(client, owner, repo, prNumber, replyBody);
    }
  }

  let labelApplied = false;

  if (decision === "approve") {
    // Optimistic lock: only actually transitions the row when it is still
    // "pending". `classification` above already ruled out every case where
    // this call would be wrong (a genuine conflict, or an already-completed
    // approval), so a `false` return here means a concurrent/earlier call
    // already made the same transition — the rest of this branch still runs
    // (idempotently) regardless of which of the two won.
    await decideIssueProposal(proposal_id, {
      status: "approved",
      decided_by: decidedBy,
      decision_reason: null,
      with_factory_label: withFactoryLabel,
      created_issue_number: null,
      created_issue_url: null,
    });

    const current = await getIssueProposal(proposal_id);
    if (current === null) {
      throw new Error(
        `issue_proposal_apply: issue proposal ${proposal_id} disappeared mid-decision`,
      );
    }

    let created: { readonly number: number; readonly htmlUrl: string };
    if (current.created_issue_number !== null) {
      created = {
        number: current.created_issue_number,
        htmlUrl: current.created_issue_url ?? "",
      };
      // The Issue (and any label on it) was already decided by an earlier
      // call — reflect that recorded decision rather than re-deciding it.
      labelApplied = current.with_factory_label ?? false;
    } else {
      try {
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
          // Same rationale as above: the Issue (found via marker search
          // instead of the DB row) was already created by an earlier,
          // presumably-crashed call, so nothing new is decided here.
          labelApplied = current.with_factory_label ?? false;
        } else {
          const labelDecision = resolveFactoryLabel({
            requested: current.with_factory_label ?? false,
            origin: proposal.origin,
            repoAllowed: isRepoAllowed(config, owner, repo),
          });
          if (!labelDecision.apply && labelDecision.reason !== null) {
            log.warn("factory label not applied", {
              reason: labelDecision.reason,
            });
          }
          created = await createIssue(client, owner, repo, {
            title: buildIssueProposalTitle(proposal.title),
            body,
            ...(labelDecision.apply ? { labels: [config.trigger_label] } : {}),
          });
          labelApplied = labelDecision.apply;
        }
      } catch (err) {
        // No Issue number is known yet at this point, so the row would
        // otherwise be stuck "approved" with created_issue_number still
        // null and invisible to a human (see the module doc's "Keeping an
        // incomplete approval visible" note) — put it back to "pending" so
        // the Console Inbox shows it again for a retry.
        await revertIssueProposalToPending(proposal_id);
        throw new Error(
          `issue_proposal_apply: Issueの起票に失敗しました: ${maskSecrets(err instanceof Error ? err.message : String(err))}。Inboxから再度承認してください`,
        );
      }
      await setIssueProposalCreatedIssue(proposal_id, {
        created_issue_number: created.number,
        created_issue_url: created.htmlUrl,
      });
    }

    // A pr_fix proposal's reply/resolve targets the GitHub review thread it
    // was raised from; an audit proposal has neither (no originating PR
    // comment), so both are skipped for it entirely.
    if (proposal.origin === "pr_fix") {
      const prNumber = requirePrNumber(
        workItem.pr_number,
        proposal.work_item_id,
      );
      const replyBody = withMarker(
        "pr_fix",
        workItemId,
        renderIssueProposalApprovedReply(created.number),
      );
      await postDecisionReply(proposal, prNumber, replyBody);
      if (proposal.thread_id !== null) {
        try {
          await resolveReviewThread(client, proposal.thread_id);
        } catch (err) {
          log.warn("failed to resolve the review thread", {
            thread_id: proposal.thread_id,
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
      }
    }
  } else {
    // Reject ordering: record the decision first, then reply — same
    // crash-recoverable shape as approve above.
    await decideIssueProposal(proposal_id, {
      status: "rejected",
      decided_by: decidedBy,
      decision_reason: reason,
      with_factory_label: null,
      created_issue_number: null,
      created_issue_url: null,
    });
    if (proposal.origin === "pr_fix") {
      const prNumber = requirePrNumber(
        workItem.pr_number,
        proposal.work_item_id,
      );
      const replyBody = withMarker(
        "pr_fix",
        workItemId,
        renderIssueProposalRejectedReply(reason),
      );
      await postDecisionReply(proposal, prNumber, replyBody);
    }
  }

  const remaining = await countPendingIssueProposals(workItemId);
  const committedThisRound =
    proposal.origin === "pr_fix" &&
    ((await latestFixRound(workItemId))?.commit_shas.length ?? 0) > 0;
  const transition = decidePostProposalTransition(
    workItem.kind,
    remaining,
    committedThisRound,
  );
  if (transition.action === "swap") {
    await updateStatusIfCurrent(
      workItemId,
      transition.expectedFrom,
      transition.toStatus,
      `issue_proposal_apply: every issue proposal decided (${transition.toStatus})`,
    );

    // A tiny window remains between the count above and the status write
    // just made, during which another pr_fix round could record a
    // brand-new pending proposal for this same work item (an audit cannot:
    // nothing adds proposals to an audit once it is awaiting_approval).
    // Re-checking
    // once more here catches that: if a new pending proposal appeared, put
    // the work item straight back to where it was rather than leaving a
    // status that implies "nothing pending" when one actually is. Not a
    // full fix (a still-tinier window remains between this re-check and its
    // own write) — no transaction machinery, matching the original
    // implementation this script was ported from.
    const recheck = await countPendingIssueProposals(workItemId);
    if (recheck > 0) {
      await updateStatusIfCurrent(
        workItemId,
        transition.toStatus,
        transition.expectedFrom,
        "issue_proposal_apply: a new issue proposal appeared during the status swap",
      );
    }
  }

  return {
    ok: true,
    status: decision === "approve" ? "approved" : "rejected",
    label_applied: labelApplied,
  };
}

export async function main(
  approval_request_id: number,
): Promise<IssueProposalApplyResult> {
  const log = logger("issue_proposal_apply");
  try {
    return await run(approval_request_id, log);
  } catch (err) {
    const message = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    log.error("issue_proposal_apply failed", { error: message });
    try {
      await recordFailure({
        work_item_id: null,
        flow_path: "f/factory/steps/issue_proposal_apply",
        job_id: process.env.WM_JOB_ID ?? "unknown",
        step: null,
        error: message,
      });
    } catch (recordErr) {
      log.error("failed to record failure", {
        error: maskSecrets(
          recordErr instanceof Error ? recordErr.message : String(recordErr),
        ),
      });
    }
    try {
      const config = await loadConfig(() =>
        wmill.getResource("f/factory/factory_config"),
      );
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        await notify(webhookUrl, {
          kind: "job_failed",
          instance_name: config.instance_name,
          flow_path: "f/factory/steps/issue_proposal_apply",
          job_id: process.env.WM_JOB_ID ?? "unknown",
          error: message,
        });
      }
    } catch (notifyErr) {
      log.error("failed to send discord notification", {
        error: maskSecrets(
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        ),
      });
    }
    throw err;
  }
}
