// PathScript step for f/factory/manual_intake__flow: claims the Issue
// `manual_intake_create_issue` just opened exactly the way poll_issues.ts
// claims a discovered one (spec-cycle2.md §3 M5, §7 item 1), inserts the
// work_items row, posts the claim comment, notifies Discord, and starts
// f/factory/pipeline for it.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import { insertWorkItem, setFlowJobId } from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import {
  claimIssue,
  commentIssue,
  type GhClient,
  getViewer,
} from "../lib/github.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { assertGitHubName } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

/** Same treatment as poll_issues.ts's own `notifySafe`: an unset webhook
 * URL is a no-op, and a Discord failure is logged (masked) rather than
 * failing the flow step — a notification hiccup should never block the
 * work item it's reporting on. */
async function notifySafe(
  webhookUrl: string,
  event: NotifyEvent,
  log: Logger,
): Promise<void> {
  if (webhookUrl.length === 0) return;
  try {
    await notify(webhookUrl, event);
  } catch (err) {
    log.warn("discord notify failed", { error: maskSecrets(String(err)) });
  }
}

export type ManualIntakeRegisterResult = {
  readonly work_item_id: number;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly flow_job_id: string;
};

export async function main(
  owner: string,
  repo: string,
  issue_number: number,
  issue_url: string,
  title: string,
  body: string,
): Promise<ManualIntakeRegisterResult> {
  const log = logger("manual_intake_register");
  assertGitHubName(owner);
  assertGitHubName(repo);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  const viewer = await getViewer(client);

  const claim = await claimIssue(client, owner, repo, issue_number, {
    wipLabel: config.wip_label,
    assignee: viewer.login,
  });
  if (!claim.claimed) {
    throw new Error(
      `manual_intake: failed to claim ${owner}/${repo}#${issue_number}: ${claim.reason}`,
    );
  }

  const workItemId = await insertWorkItem({
    cycle: 1,
    source: "manual",
    kind: "issue",
    owner,
    repo,
    issue_number,
    issue_url,
    pr_number: null,
    title,
    body,
    status: "picked",
    attempt: 1,
    claimed_by: viewer.login,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  });

  await commentIssue(
    client,
    owner,
    repo,
    issue_number,
    "issue",
    workItemId,
    `Claimed by factory instance \`${config.instance_name}\`.`,
    viewer.login,
  );

  const flowJobId = await wmill.runFlowAsync("f/factory/pipeline", {
    work_item_id: workItemId,
    attempt: 1,
  });
  await setFlowJobId(workItemId, flowJobId);

  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  await notifySafe(
    webhookUrl,
    {
      kind: "issue_claimed",
      instance_name: config.instance_name,
      owner,
      repo,
      issue_number,
      issue_url,
      title,
    },
    log,
  );

  return {
    work_item_id: workItemId,
    issue_number,
    issue_url,
    flow_job_id: flowJobId,
  };
}
