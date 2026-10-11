// 要件定義の承認の前に、現在のIssueの題名と本文が取り込み時点と同じかを確かめる。
// `approval_decide`が承認を記録する前に同期で呼ぶ。
//
// GitHubを呼ぶので`github_token`を読む。Console用workerに`github_token`を読ませないため、
// このscriptは、tagを付けずにdefaultのworkerで動かす。
// 結果は判定だけで、現在のIssueの内容は返さない。

import * as wmill from "windmill-client@1.817.0";
import type { IssueCheckVerdict } from "../lib/approval_support.ts";
import { getApprovalRequest, getWorkItem } from "../lib/db.ts";
import { type GhClient, getIssue } from "../lib/github.ts";
import { issueChangedSinceIntake } from "../lib/implement_support.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import type { ApprovalRequest, WorkItem } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

export type CheckApprovalIssueDeps = {
  readonly getApprovalRequest: (
    id: number,
  ) => Promise<Pick<ApprovalRequest, "kind" | "work_item_id"> | null>;
  readonly getWorkItem: (
    id: number,
  ) => Promise<Pick<
    WorkItem,
    "owner" | "repo" | "issue_number" | "title" | "body"
  > | null>;
  readonly getIssue: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<{ readonly title: string; readonly body: string }>;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
};

export type ApprovalIssueCheckResult = {
  readonly verdict: IssueCheckVerdict;
};

/**
 * 承認依頼の作業項目に取り込んだ時点の題名・本文と、GitHub上の現在のIssueを比べる。
 * 取り込み時点の内容は、承認者がConsoleで見て、実装のClaudeにも渡る内容である。
 * 要件定義以外の承認依頼は比べずに`not_applicable`を返す。
 * 取得に失敗したときと、比べる材料が欠けているときは、例外を投げずに`unavailable`を返す。
 * 呼び出し側は`unavailable`を承認を通さない結果として扱う(安全側)。
 */
export async function checkApprovalIssue(
  approvalRequestId: number,
  deps: CheckApprovalIssueDeps,
): Promise<ApprovalIssueCheckResult> {
  const request = await deps.getApprovalRequest(approvalRequestId);
  if (request === null) {
    deps.warn("approval request not found", {
      approval_request_id: approvalRequestId,
    });
    return { verdict: "unavailable" };
  }
  if (request.kind !== "requirements") {
    return { verdict: "not_applicable" };
  }
  const workItem = await deps.getWorkItem(request.work_item_id);
  if (workItem === null || workItem.issue_number === null) {
    deps.warn("work item has no issue to compare", {
      approval_request_id: approvalRequestId,
      work_item_id: request.work_item_id,
    });
    return { verdict: "unavailable" };
  }
  try {
    const live = await deps.getIssue(
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
    );
    return {
      verdict: issueChangedSinceIntake(workItem, live) ? "changed" : "match",
    };
  } catch (err) {
    deps.warn("fetching the issue failed", {
      approval_request_id: approvalRequestId,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return { verdict: "unavailable" };
  }
}

export async function main(
  approval_request_id: number,
): Promise<ApprovalIssueCheckResult> {
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const log = logger("approval_check_issue");
  return await checkApprovalIssue(approval_request_id, {
    getApprovalRequest: (id) => getApprovalRequest(id),
    getWorkItem: (id) => getWorkItem(id),
    getIssue: (owner, repo, number) => getIssue(client, owner, repo, number),
    warn: (message, fields) => log.warn(message, fields),
  });
}
