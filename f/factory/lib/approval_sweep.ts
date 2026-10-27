import type { LatestApprovalGuard, LatestApprovalRequest } from "./db.ts";
import type {
  ApprovalRequest,
  ApprovalRequestKind,
  WorkItem,
  WorkItemStatus,
} from "./types.ts";

export type ApprovalExpiryPlan = {
  readonly from: WorkItemStatus;
  readonly note: string;
};

export function expiryPlanFor(
  _kind: ApprovalRequestKind,
): ApprovalExpiryPlan | null {
  return null;
}

export const SWEEP_REDISPATCH_GRACE_MS = 0;
export const SWEEP_REDISPATCH_LIMIT = 0;
export const SWEEP_REDISPATCH_MAX_PER_REQUEST = 0;

export function approvalRedispatchNote(_requestId: number): string {
  return "";
}

export function approvalApplyStalledReason(_attempts: number): string {
  return "";
}

export type SweepDeps = {
  readonly now: () => Date;
  readonly listWorkItemsByStatuses: (
    statuses: readonly WorkItemStatus[],
  ) => Promise<WorkItem[]>;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly latestApprovalRequest: (
    workItemId: number,
    kind: ApprovalRequestKind,
  ) => Promise<LatestApprovalRequest | null>;
  readonly updateStatusIfLatestApproval: (
    id: number,
    from: WorkItemStatus,
    to: WorkItemStatus,
    note: string,
    latest: LatestApprovalGuard,
  ) => Promise<boolean>;
  readonly listExpiredPendingApprovalRequests: (
    now: Date,
  ) => Promise<ApprovalRequest[]>;
  readonly expireApprovalRequestIfPending: (id: number) => Promise<boolean>;
  readonly countApprovalRedispatches: (
    workItemId: number,
    note: string,
  ) => Promise<number>;
  readonly recordApprovalRedispatch: (
    workItemId: number,
    status: WorkItemStatus,
    note: string,
  ) => Promise<boolean>;
  readonly redispatch: (
    kind: ApprovalRequestKind,
    approvalRequestId: number,
  ) => Promise<void>;
  readonly notifyNeedsHuman: (item: WorkItem, reason: string) => Promise<void>;
  readonly recordFailure: (
    step: string,
    err: unknown,
    workItemId: number,
  ) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export async function sweepApprovals(_deps: SweepDeps): Promise<number> {
  return 0;
}
