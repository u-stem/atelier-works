import type { PullRequest } from "../lib/github.ts";
import type {
  PrReviewObserved,
  PrReviewStartInput,
  PrReviewStartResult,
} from "../lib/pr_review_start.ts";

export const PR_REVIEW_REGISTER_REFUSAL_REASONS = [
  "invalid_pr_number",
  "repo_not_allowed",
  "pr_not_found",
  "pr_closed",
  "fork_head",
  "owner_mismatch",
  "repo_mismatch",
  "already_reviewing",
] as const;

export type PrReviewRegisterRefusalReason =
  (typeof PR_REVIEW_REGISTER_REFUSAL_REASONS)[number];

export type PrReviewRegisterResult =
  | {
      readonly status: "started";
      readonly work_item_id: number;
      readonly flow_job_id: string;
    }
  | {
      readonly status: "refused";
      readonly reason: PrReviewRegisterRefusalReason;
    };

export type PrReviewRegisterDeps = {
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
  readonly verifyRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: string }
  >;
  readonly recordForkHeadDenied: (target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  }) => Promise<void>;
  readonly viewerLogin: string;
  readonly readObserved: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PrReviewObserved>;
  readonly findLinkedParent: (
    prBody: string,
    owner: string,
    repo: string,
  ) => Promise<number | null>;
  readonly start: (input: PrReviewStartInput) => Promise<PrReviewStartResult>;
};

export async function registerPrReviewIntake(
  _input: {
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  },
  _deps: PrReviewRegisterDeps,
): Promise<PrReviewRegisterResult> {
  return { status: "refused", reason: "repo_not_allowed" };
}

export async function main(
  _owner: string,
  _repo: string,
  _pr_number: number,
): Promise<PrReviewRegisterResult> {
  return { status: "refused", reason: "repo_not_allowed" };
}
