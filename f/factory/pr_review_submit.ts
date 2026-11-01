import type { ActionAudit, ActionSqlClient } from "./lib/console_actions.ts";
import type { Logger } from "./lib/log.ts";
import type { FactoryConfig } from "./lib/types.ts";

export const PR_REVIEW_SUBMIT_REFUSAL_REASONS = [
  "invalid_owner",
  "invalid_repo",
  "invalid_pr_number",
  "repo_not_allowed",
  "actor_unknown",
  "already_reviewing",
] as const;

export type PrReviewSubmitRefusalReason =
  (typeof PR_REVIEW_SUBMIT_REFUSAL_REASONS)[number];

export type PrReviewSubmitResult =
  | {
      readonly refused: true;
      readonly reason: PrReviewSubmitRefusalReason;
    }
  | {
      readonly refused: false;
      readonly flow_job_id: string;
      readonly action_audit?: ActionAudit;
    };

export type PrReviewSubmitInput = {
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
};

export type PrReviewSubmitDeps = {
  readonly loadConfig: () => Promise<
    Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">
  >;
  readonly deriveActor: () => string;
  readonly hasActiveReview: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<boolean>;
  readonly runFlow: (
    path: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  readonly log: Pick<Logger, "info">;
};

export async function submitPrReview(
  _input: PrReviewSubmitInput,
  _deps: PrReviewSubmitDeps,
): Promise<PrReviewSubmitResult> {
  return { refused: true, reason: "actor_unknown" };
}

export async function submitPrReviewRecorded(
  input: PrReviewSubmitInput,
  deps: PrReviewSubmitDeps,
  _sql: ActionSqlClient,
): Promise<PrReviewSubmitResult> {
  return await submitPrReview(input, deps);
}

export async function main(
  _owner: string,
  _repo: string,
  _pr_number: number,
): Promise<PrReviewSubmitResult> {
  return { refused: true, reason: "actor_unknown" };
}
