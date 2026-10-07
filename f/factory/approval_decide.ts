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

import * as wmill from "windmill-client@1.817.0";
import {
  buildRecordedReason,
  classifyExistingDecision,
  handlerPathFor,
} from "./lib/approval_support.ts";
import { deriveApprover } from "./lib/approver.ts";
import {
  decideApprovalRequestIfPending,
  getApprovalRequest,
} from "./lib/db.ts";
import { isOneOf } from "./lib/types.ts";

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
