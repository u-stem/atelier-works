// f/factory/manual_intakeフローのステップ。
// `manual_intake_create_issue`が作ったIssueを、`poll_issues.ts`が見つけたIssueと
// 同じ手順で確保し、`work_items`に行を追加して、f/factory/pipelineを起動し、
// Discordに通知する。
// この段階ではGitHubにコメントしない。
// GitHubには成果物だけを載せ、運用上の通知はDiscordとConsoleに出す方針のため。

import * as wmill from "windmill-client@1.817.0";
import { recordAssigneeMissing } from "../lib/claim_support.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  insertWorkItem,
  setFlowJobId,
} from "../lib/db.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import { claimIssue, type GhClient, getViewer } from "../lib/github.ts";
import { parseFlowJobId } from "../lib/implement_launch_support.ts";
import { type Logger, logger } from "../lib/log.ts";
import { assertGitHubName } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

export type ManualIntakeStartedResult = {
  readonly skipped: false;
  readonly work_item_id: number;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly flow_job_id: string;
};

/** 取得できなかったので何も始めなかった。`poll_issues`が、残っているラベルから拾い直す。 */
export type ManualIntakeSkippedResult = {
  readonly skipped: true;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly reason: string;
};

export type ManualIntakeRegisterResult =
  | ManualIntakeStartedResult
  | ManualIntakeSkippedResult;

export type ManualIntakeClaimDeps = {
  readonly claimIssue: typeof claimIssue;
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
};

const defaultClaimDeps: ManualIntakeClaimDeps = {
  claimIssue,
  addNoticeUnlessUnresolved,
};

/**
 * 手動投入のIssueを取得し、作業を始めてよいか返す。
 * 取得の所有は、自分のラベルの削除が成功したことで決まる(`claimIssue`を参照)。
 * - 取得できたときは、assigneeが付いていなくても作業を続ける。
 *   付いていないときは、`poll_issues`と同じ`claim_assignee_missing`のnoticeを残す。
 * - ほかが先にラベルを外した、またはラベルの削除に失敗してラベルが残っているときは、
 *   失敗にせず見送る。ラベルが残っていれば`poll_issues`が扱い、
 *   ほかが外したのならそのインスタンスが扱う。
 * - 所有したか判断できなかったときは、`ClaimOwnershipUnknownError`をそのまま投げる。
 *   フローの失敗として`on_error_flow`が人へ知らせる。
 */
export async function claimManualIntakeIssue(
  input: {
    readonly client: GhClient;
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly triggerLabel: string;
    readonly viewerLogin: string;
    readonly log: Logger;
  },
  deps: ManualIntakeClaimDeps = defaultClaimDeps,
): Promise<
  | { readonly claimed: true }
  | { readonly claimed: false; readonly reason: string }
> {
  const { owner, repo, issueNumber, log } = input;
  const target = `${owner}/${repo}#${issueNumber}`;
  const claim = await deps.claimIssue(input.client, owner, repo, issueNumber, {
    triggerLabel: input.triggerLabel,
    assignee: input.viewerLogin,
    log,
  });
  if (!claim.claimed) {
    log.warn("manual intake skipped the claim", {
      target,
      outcome: claim.outcome,
      reason: claim.reason,
    });
    return { claimed: false, reason: claim.reason };
  }
  if (claim.assignee === "missing") {
    await recordAssigneeMissing(
      target,
      input.viewerLogin,
      deps.addNoticeUnlessUnresolved,
      log,
    );
  }
  return { claimed: true };
}

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

  const claim = await claimManualIntakeIssue({
    client,
    owner,
    repo,
    issueNumber: issue_number,
    triggerLabel: config.trigger_label,
    viewerLogin: viewer.login,
    log,
  });
  if (!claim.claimed) {
    return { skipped: true, issue_number, issue_url, reason: claim.reason };
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
  await notifyBestEffort(
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
    skipped: false,
    work_item_id: workItemId,
    issue_number,
    issue_url,
    flow_job_id: flowJobId,
  };
}
