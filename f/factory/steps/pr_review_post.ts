// PathScript step for f/factory/pr_review: posts the review as a GitHub PR
// review (event COMMENT — GitHub review "approve"/"request_changes" events
// are never used, per spec-cycle2.md §3 M6 and the factory-review skill;
// `verdict` is recorded in factory.reviews / Discord only), records it,
// transitions the work item to "reviewed", removes the wip and review_label
// labels (team-lead rule, 2026-09-26: idempotent — only re-applying the
// label starts a fresh cycle), notifies Discord, and removes the detached
// worktree pr_review_prepare.ts built.
//
// `review_post_mode: "gated"` is reserved (spec-cycle2.md §7 item 8): this
// records the review and moves the work item to "reviewed" with a notice,
// but never calls createPrReview — the Inbox-gated posting UI itself is out
// of this cycle's scope.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, insertReview, updateStatusIfCurrent } from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import { createPrReview, type GhClient, withMarker } from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import {
  isOneOf,
  type ReviewFinding,
  type ReviewVerdict,
} from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import {
  buildReviewBody,
  mapFindingsToReviewComments,
  removeTerminalLabels,
} from "./pr_workflow_support.ts";

const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "approve",
  "comment",
  "request_changes",
];

export type PrReviewPostResult = {
  readonly skip: boolean;
  readonly posted: boolean;
  readonly posted_review_id: string | null;
};

export async function main(
  work_item_id: number,
  skip: boolean,
  owner: string,
  repo: string,
  pr_number: number,
  review_sha: string,
  summary: string,
  verdict: string | null,
  findings: ReviewFinding[],
  pr_files: string[],
  worktree_dir: string,
  repo_dir: string,
): Promise<PrReviewPostResult> {
  const log = logger("pr_review_post");

  if (skip || verdict === null) {
    return { skip: true, posted: false, posted_review_id: null };
  }
  if (!isOneOf(verdict, REVIEW_VERDICTS)) {
    throw new Error(`pr_review_post: unexpected verdict "${verdict}"`);
  }

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  try {
    const currentItem = await getWorkItem(work_item_id);
    if (currentItem === null) {
      throw new Error(`pr_review_post: no work item with id ${work_item_id}`);
    }
    if (currentItem.status !== "reviewing") {
      log.warn("work item is no longer reviewing; not posting", {
        work_item_id,
        status: currentItem.status,
      });
      return { skip: true, posted: false, posted_review_id: null };
    }

    const { comments, droppedCount } = mapFindingsToReviewComments(
      findings,
      pr_files,
    );
    const body = withMarker(
      "pr_review",
      work_item_id,
      buildReviewBody(summary, verdict, findings.length, droppedCount),
    );

    let postedReviewId: string | null = null;
    let notice: string | null = null;
    if (config.review_post_mode === "comment_only") {
      const created = await createPrReview(client, owner, repo, pr_number, {
        event: "COMMENT",
        body,
        comments,
      });
      postedReviewId = String(created.id);
    } else {
      notice = "review_post_mode is gated: recorded without posting";
    }

    await insertReview({
      work_item_id,
      head_sha: review_sha,
      verdict,
      summary,
      findings,
      posted_review_id: postedReviewId,
    });

    const moved = await updateStatusIfCurrent(
      work_item_id,
      "reviewing",
      "reviewed",
      notice,
    );
    if (moved) {
      await removeTerminalLabels(
        client,
        owner,
        repo,
        pr_number,
        [config.wip_label, config.review_label],
        log,
      );
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        const event: NotifyEvent = {
          kind: "pr_reviewed",
          instance_name: config.instance_name,
          owner,
          repo,
          pr_number,
          pr_url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
          verdict,
        };
        try {
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

    return {
      skip: false,
      posted: postedReviewId !== null,
      posted_review_id: postedReviewId,
    };
  } finally {
    try {
      await removeWorktree({
        run: runCommand,
        repoDir: repo_dir,
        dir: worktree_dir,
        force: true,
      });
    } catch (err) {
      log.warn("failed to remove review worktree", {
        worktree_dir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
}
