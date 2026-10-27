// 判断済みの設計の承認依頼(`factory.approval_requests`の`kind = "design"`)を処理する。
// `f/factory/approval_decide.ts`が人の判断を記録した直後に
// `wmill.runScriptByPathAsync`で起動する、フローから独立したジョブである。

import type { RequirementsApprovalForGate } from "../lib/approval_gate.ts";
import type { IssueVerdictForRejection } from "../lib/design_apply_support.ts";
import type { StartImplementOutcome } from "../lib/implement_launch_support.ts";
import type {
  ApprovalRequest,
  DesignApprovalRef,
  FactoryConfig,
  WorkItem,
} from "../lib/types.ts";
import type {
  NotifyContext,
  RejectedRetryDeps,
  StartDesignPorts,
} from "./requirements_apply.ts";

export type DesignApplyOutcome =
  | "approved"
  | "regenerating"
  | "requirements_returned"
  | "needs_human"
  | "no_op";

export type DesignApplyResult = {
  readonly outcome: DesignApplyOutcome;
  readonly implement_started?: boolean;
  readonly design_started?: boolean;
};

export type DesignNeedsHumanDeps = {
  readonly moveToNeedsHuman: (reason: string) => Promise<boolean>;
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export type DesignApprovedDeps = DesignNeedsHumanDeps & {
  readonly casToApproved: () => Promise<boolean>;
  readonly startImplement: (() => Promise<StartImplementOutcome>) | null;
};

export type DesignRejectedDeps = DesignNeedsHumanDeps & {
  readonly config: Pick<FactoryConfig, "instance_name">;
  readonly ctx: NotifyContext;
  readonly ports?: StartDesignPorts;
  readonly casToDesigning: (note: string) => Promise<boolean>;
  readonly requirementsRelaunchDeps: (note: string) => RejectedRetryDeps;
};

export type DesignApplyDeps = {
  readonly getApprovalRequest: (id: number) => Promise<ApprovalRequest | null>;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly readIssueVerdict: (
    workItem: WorkItem,
  ) => Promise<IssueVerdictForRejection>;
  readonly latestDesignApproval: (
    workItemId: number,
  ) => Promise<DesignApprovalRef | null>;
  readonly latestRequirementsApproval: (
    workItemId: number,
  ) => Promise<RequirementsApprovalForGate | null>;
  readonly countAppliedDesignRejections: (
    workItemId: number,
  ) => Promise<number>;
  readonly maxDesignAttempts: number;
  readonly needsHumanDepsFor: (workItem: WorkItem) => DesignNeedsHumanDeps;
  readonly approvedDepsFor: (workItem: WorkItem) => DesignApprovedDeps;
  readonly rejectedDepsFor: (
    workItem: WorkItem,
    issueNumber: number,
  ) => DesignRejectedDeps;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export async function applyDesignApproved(
  _deps: DesignApprovedDeps,
  _state: {
    readonly workItem: Pick<WorkItem, "attempt" | "design_attempt">;
    readonly requirementsApproval: RequirementsApprovalForGate | null;
    readonly designApproval: DesignApprovalRef | null;
  },
): Promise<DesignApplyResult> {
  return { outcome: "no_op" };
}

export async function applyDesignRejected(
  _deps: DesignRejectedDeps,
  _input: {
    readonly issue: IssueVerdictForRejection;
    readonly appliedRejections: number;
    readonly maxDesignAttempts: number;
    readonly feedback: string;
  },
): Promise<DesignApplyResult> {
  return { outcome: "no_op" };
}

export async function run(
  _deps: DesignApplyDeps,
  _approvalRequestId: number,
): Promise<DesignApplyResult> {
  return { outcome: "no_op" };
}

export async function main(
  _approval_request_id: number,
): Promise<DesignApplyResult> {
  return { outcome: "no_op" };
}
