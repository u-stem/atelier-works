// f/factory/investigateフローの1番目(登録)。実装は次のコミットで行う。

import type { NewInvestigateWorkItem } from "../lib/db.ts";
import type { Issue } from "../lib/github.ts";
import type { RepoOwnerGateResult } from "../lib/repo_owner_gate.ts";

export const INVESTIGATE_REGISTER_REFUSAL_REASONS = [
  "invalid_input",
  "repo_not_allowed",
  "owner_mismatch",
  "investigation_disabled",
  "issue_not_found",
  "issue_closed",
  "issue_is_pull_request",
  "issue_author_not_operator",
  "repo_mismatch",
  "probe_running",
  "investigation_in_progress",
] as const;

export type InvestigateRegisterRefusalReason =
  (typeof INVESTIGATE_REGISTER_REFUSAL_REASONS)[number];

export type InvestigateRegisterResult =
  | {
      readonly skip: false;
      readonly reason: null;
      readonly work_item_id: number;
    }
  | {
      readonly skip: true;
      readonly reason: InvestigateRegisterRefusalReason;
      readonly work_item_id: 0;
    };

export type InvestigateRegisterInput = {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly request: string;
  readonly flowJobId: string;
};

export type InvestigateRegisterDeps = {
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  readonly verifyRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<RepoOwnerGateResult>;
  readonly isEnabled: () => boolean;
  readonly getIssue: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<Issue>;
  readonly viewerLogin: string;
  readonly isProbeActive: () => Promise<boolean>;
  readonly insert: (item: NewInvestigateWorkItem) => Promise<number | null>;
};

export async function registerInvestigation(
  _input: InvestigateRegisterInput,
  _deps: InvestigateRegisterDeps,
): Promise<InvestigateRegisterResult> {
  return { skip: true, reason: "invalid_input", work_item_id: 0 };
}

export async function main(
  _owner: string,
  _repo: string,
  _issue_number: number,
  _request: string,
): Promise<InvestigateRegisterResult> {
  return { skip: true, reason: "invalid_input", work_item_id: 0 };
}
