import type { NewApprovalRequest } from "../lib/db.ts";
import type { NotifyBestEffortResult, NotifyEvent } from "../lib/discord.ts";
import type { DesignDraft, FactoryConfig, WorkItem } from "../lib/types.ts";

export const DESIGN_APPROVAL_WITHDRAWN_REASON = "";

export const DESIGN_APPROVAL_ALREADY_DECIDED_REASON = "";

export type DesignRequestApprovalResult =
  | { readonly ok: true; readonly approval_request_id: number }
  | { readonly ok: false; readonly reason: string };

export type DesignRequestApprovalDeps = {
  readonly leaseJobId: string;
  readonly now: () => Date;
  readonly config: Pick<FactoryConfig, "instance_name" | "windmill_public_url">;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly latestDesignDraft: (id: number) => Promise<DesignDraft | null>;
  readonly latestRequirementsApproval: (id: number) => Promise<{
    readonly draft_id: number;
    readonly status: string;
    readonly attempt: number;
  } | null>;
  readonly insertApprovalRequest: (
    input: NewApprovalRequest,
  ) => Promise<number>;
  readonly moveToAwaitingDesignApproval: () => Promise<boolean>;
  readonly withdrawRequest: (id: number) => Promise<boolean>;
  readonly notify: (event: NotifyEvent) => Promise<NotifyBestEffortResult>;
  readonly recordNotifyFailure: (message: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export async function runDesignRequestApproval(
  _deps: DesignRequestApprovalDeps,
  _input: { readonly work_item_id: number; readonly design_attempt: number },
): Promise<DesignRequestApprovalResult> {
  return { ok: false, reason: "stub" };
}
