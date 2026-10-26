import type { WorkItem } from "../lib/types.ts";

export const DESIGN_PREPARE_MOVED_ON_REASON = "";

export type DesignPrepareResult =
  | { readonly skip: true; readonly reason: string }
  | {
      readonly skip: false;
      readonly worktree_dir: string;
      readonly owner: string;
      readonly repo: string;
      readonly issue_number: number;
      readonly head_sha: string;
    };

export type DesignWorktreeOps = {
  readonly exists: (repoDir: string, dir: string) => Promise<boolean>;
  readonly ensureLockFree: (dir: string) => Promise<void>;
  readonly remove: (repoDir: string, dir: string) => Promise<void>;
  readonly add: (repoDir: string, dir: string, sha: string) => Promise<void>;
};

export type DesignPrepareDeps = {
  readonly leaseJobId: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly leaseWaitMs: number;
  readonly leasePollMs: number;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly latestRequirementsApproval: (
    id: number,
  ) => Promise<{ readonly status: string; readonly attempt: number } | null>;
  readonly moveFromDesigning: (
    to: "needs_human" | "cancelled",
    reason: string,
  ) => Promise<boolean>;
  readonly verifyRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: string }
  >;
  readonly getIssueState: (
    owner: string,
    repo: string,
    issueNumber: number,
  ) => Promise<string>;
  readonly setDesignAttempt: (designAttempt: number) => Promise<boolean>;
  readonly prepareRepo: (
    owner: string,
    repo: string,
  ) => Promise<{ readonly repoDir: string; readonly headSha: string }>;
  readonly worktrees: DesignWorktreeOps;
  readonly notifyNeedsHuman: (item: WorkItem, reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export async function runDesignPrepare(
  _deps: DesignPrepareDeps,
  _input: { readonly work_item_id: number; readonly design_attempt: number },
): Promise<DesignPrepareResult> {
  return { skip: true, reason: "stub" };
}
