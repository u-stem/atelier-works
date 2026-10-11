// `factory.approval_requests`の保留中の行に、承認か却下を記録する
// 手動実行用のscript。Windmill UIかFactory Console Appから、種別を問わず呼ぶ。
//
// 決定は`decideApprovalRequestIfPending`(不可分な比較交換)で行に記録し、
// 実際のGitHubやDBへの副作用は、種別ごとのハンドラscript(`handlerPathFor`)に
// `wmill.runScriptByPathAsync`で任せる。再開を待つ中断中のフローは無い。
//
// 記録する承認者は、呼び出し側が渡す文字列ではなく、ジョブのWindmill実行文脈
// (`WM_USERNAME`、無ければ`WM_EMAIL`。`deriveApprover`を参照)から導く。
// 引数の文字列は誰でも好きな値にできるため、本人の識別に使わない。
// `note`は補助の自由記述として`reason`に織り込むだけで、識別には使わない。
//
// 同じ行への並行・重複の呼び出しが、両方とも決定を記録してはならない。
// `classifyExistingDecision`が既存の状態を今回の決定と比べ、
// `pending`なら記録して起動し、同じ決定が記録済みなら起動だけをやり直す
// (決定の記録後にハンドラの起動が失敗した場合の冪等な再試行)。
// 異なる決定が記録済みの行と、期限切れの行は拒否する。
//
// 要件定義を承認するときは、記録の前に、現在のIssueの題名と本文が取り込み時点と
// 同じかを確かめ、違うか確かめられなければ承認を拒否する。
// 承認者が見た内容と、実装のClaudeに渡る内容を一致させるためである。
// このscriptはConsole用workerで動き、`gh`を起動できない。そのため、GitHubのREST APIを
// `fetch`で直接読む(`fetchIssueContent`)。別のworkerのscriptに確認を頼むと、
// defaultのworkerの待ち行列で、Console用workerの枠を塞ぐためである。
// `github_token`は`Authorization`ヘッダだけに載せる。

import * as wmill from "windmill-client@1.817.0";
import {
  buildRecordedReason,
  classifyExistingDecision,
  handlerPathFor,
  type IssueCheckVerdict,
  issueCheckRefusal,
  needsIssueCheck,
} from "./lib/approval_support.ts";
import { deriveApprover } from "./lib/approver.ts";
import {
  decideApprovalRequestIfPending,
  getApprovalRequest,
  getWorkItem,
} from "./lib/db.ts";
import { type FetchLike, fetchIssueContent } from "./lib/github.ts";
import { issueChangedSinceIntake } from "./lib/implement_support.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import { isOneOf, type WorkItem } from "./lib/types.ts";

const DECISIONS = ["approve", "reject"] as const;
type Decision = (typeof DECISIONS)[number];

export type ApprovalDecideInput = {
  readonly decision: Decision;
  readonly reason: string;
};

/**
 * 入力を検査し、却下なのに`reason`が空白だけなら例外を投げる。
 * 承認には理由を求めない。
 */
export function assertValidApprovalDecideInput(
  input: ApprovalDecideInput,
): void {
  if (input.decision === "reject" && input.reason.trim().length === 0) {
    throw new Error(
      'approval_decide: "reason" is required when decision is "reject"',
    );
  }
}

export type IssueCheckDeps = {
  readonly getWorkItem: (
    id: number,
  ) => Promise<Pick<
    WorkItem,
    "owner" | "repo" | "issue_number" | "title" | "body"
  > | null>;
  readonly getToken: () => Promise<string>;
  readonly fetchFn: FetchLike;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * 作業項目に取り込んだ時点の題名・本文と、GitHub上の現在のIssueを比べる。
 * 比べられなかったとき(作業項目やIssue番号が無い、トークンを読めない、
 * 通信の失敗、締め切り超過、2xx以外の応答、形の違う応答)は、例外を投げずに`unavailable`を返す。
 * 警告のログには、理由を`maskSecrets`に通して残す。Issueの内容は載せない。
 */
export async function checkIssueAgainstIntake(
  workItemId: number,
  deps: IssueCheckDeps,
): Promise<Exclude<IssueCheckVerdict, "not_applicable">> {
  try {
    const workItem = await deps.getWorkItem(workItemId);
    if (workItem === null || workItem.issue_number === null) {
      deps.warn("work item has no issue to compare", {
        work_item_id: workItemId,
      });
      return "unavailable";
    }
    const live = await fetchIssueContent(
      deps.fetchFn,
      await deps.getToken(),
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
    );
    return issueChangedSinceIntake(workItem, live) ? "changed" : "match";
  } catch (err) {
    deps.warn("the issue could not be read", {
      work_item_id: workItemId,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return "unavailable";
  }
}

/**
 * Issueが取り込み時点と同じかを確かめ、違うか、確かめられなかったときは例外を投げる。
 * 呼び出し側は、承認を記録する前に、`needsIssueCheck`が真のときだけ呼ぶ。
 * 確認から記録までの間のIssueの書き換えは防げない。
 * 実装を終えたときの比較(PR本文の注記)が残りを拾う。
 */
export async function assertIssueMatchesIntake(
  approvalRequestId: number,
  workItemId: number,
  deps: IssueCheckDeps,
): Promise<void> {
  const verdict = await checkIssueAgainstIntake(workItemId, deps);
  const refusal = issueCheckRefusal(verdict, approvalRequestId);
  if (refusal !== null) {
    throw new Error(refusal);
  }
}

export type ApprovalDecideResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly job_id: string;
};

export async function main(
  approval_request_id: number,
  decision: string,
  reason: string,
  note: string,
  options: Record<string, unknown> = {},
): Promise<ApprovalDecideResult> {
  if (!isOneOf(decision, DECISIONS)) {
    throw new Error(
      `approval_decide: "decision" must be "approve" or "reject" (got ${JSON.stringify(decision)})`,
    );
  }
  assertValidApprovalDecideInput({ decision, reason });

  const request = await getApprovalRequest(approval_request_id);
  if (request === null) {
    throw new Error(
      `approval_decide: no approval request with id ${approval_request_id}`,
    );
  }

  const recordedStatus = decision === "approve" ? "approved" : "rejected";

  function classify(status: string): "record_and_dispatch" | "redispatch" {
    const action = classifyExistingDecision(status, recordedStatus);
    if (action === "refuse") {
      throw new Error(
        `approval_decide: approval request ${approval_request_id} already has a recorded decision (${status}) that differs from this request (${recordedStatus}), or has expired — refusing to overwrite it`,
      );
    }
    return action;
  }

  const initialAction = classify(request.status);

  if (initialAction === "record_and_dispatch") {
    // 状態を変える記録の前に、必ず確認を済ませる。断られたときは、記録に進まない。
    if (needsIssueCheck(initialAction, decision, request.kind)) {
      await assertIssueMatchesIntake(
        approval_request_id,
        request.work_item_id,
        {
          getWorkItem: (id) => getWorkItem(id),
          getToken: () => wmill.getVariable("f/factory/github_token"),
          fetchFn: fetch,
          warn: (message, fields) =>
            logger("approval_decide").warn(message, fields),
        },
      );
    }
    const approver = deriveApprover({
      WM_USERNAME: process.env.WM_USERNAME,
      WM_EMAIL: process.env.WM_EMAIL,
    });
    const recorded = await decideApprovalRequestIfPending(approval_request_id, {
      status: recordedStatus,
      decided_by: approver,
      reason: buildRecordedReason(reason, note),
      decision_options: options,
    });
    if (!recorded) {
      // 上の読み取りとこの書き込みの間に他の呼び出しが記録した。
      // 行を読み直し、現在の状態で分類し直す。
      const current = await getApprovalRequest(approval_request_id);
      if (current === null) {
        throw new Error(
          `approval_decide: approval request ${approval_request_id} disappeared mid-decision`,
        );
      }
      classify(current.status);
    }
  }

  const jobId = await wmill.runScriptByPathAsync(handlerPathFor(request.kind), {
    approval_request_id,
  });

  return { ok: true, status: recordedStatus, job_id: jobId };
}
