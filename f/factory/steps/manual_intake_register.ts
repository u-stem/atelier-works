// f/factory/manual_intakeフローのステップ。
// `manual_intake_create_issue`が作ったIssueを、`poll_issues.ts`が見つけたIssueと
// 同じ手順で確保し、`work_items`に行を追加して、f/factory/pipelineを起動し、
// Discordに通知する。
// この段階ではGitHubにコメントしない。
// GitHubには成果物だけを載せ、運用上の通知はDiscordとConsoleに出す方針のため。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import { insertWorkItem, setFlowJobId } from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import { claimIssue, type GhClient, getViewer } from "../lib/github.ts";
import { parseFlowJobId } from "../lib/implement_launch_support.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { assertGitHubName } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

/**
 * Discordに通知する。`poll_issues.ts`の`notifySafe`と同じ扱いにしている。
 * webhookのURLが空なら何もしない。
 * 送信に失敗しても例外にせず、秘密をマスクして警告ログに残す。
 * 通知の一時的な失敗で、通知対象の作業項目の処理を止めないため。
 */
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
    triggerLabel: config.trigger_label,
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

  // 応答がジョブIDでなければ例外にし、起動の失敗と同じくステップを失敗させて`on_error_flow`に任せる。
  const flowJobId = parseFlowJobId(
    await wmill.runFlowAsync("f/factory/pipeline", {
      work_item_id: workItemId,
      attempt: 1,
    }),
    "runFlowAsync",
  );
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
