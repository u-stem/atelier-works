/** 反映の目標の決定、noopの判定、拒否の控え、失敗の回数の規則。 */

export type RejectionKind =
  | "compose_forbidden"
  | "mise_forbidden"
  | "unknown_service"
  | "caddy_invalid"
  | "not_ff"
  | "ci_failed"
  | "docker_version";

export type RejectionRecord = {
  readonly kind: RejectionKind;
  readonly at: string;
};

export const CONTENT_REJECTION_KINDS: readonly RejectionKind[] = [];

export function isContentRejection(_kind: RejectionKind): boolean {
  return false;
}

export function selectTarget(_commits: readonly string[]): string | null {
  return null;
}

export type TargetDecision =
  | { readonly kind: "noop" }
  | { readonly kind: "skip_rejected"; readonly rejection: RejectionKind }
  | { readonly kind: "continue_converging"; readonly sha: string }
  | { readonly kind: "proceed"; readonly target: string };

export type DecideTargetInput = {
  readonly tip: string;
  readonly applied: string | null;
  readonly tipIsAncestorOfApplied: boolean;
  readonly rejected: Readonly<Record<string, RejectionRecord>>;
  readonly converging: { readonly sha: string } | null;
};

export function decideTarget(_input: DecideTargetInput): TargetDecision {
  return { kind: "noop" };
}

export function recordRejection(
  rejected: Readonly<Record<string, RejectionRecord>>,
  _sha: string,
  _kind: RejectionKind,
  _at: string,
): Record<string, RejectionRecord> {
  return { ...rejected, stub: { kind: "not_ff", at: "" } };
}

export type RunOutcome =
  | "converged"
  | "failed"
  | "skipped_offline"
  | "pending"
  | "rejected"
  | "noop"
  | "disabled";

export function nextAttempts(_input: {
  readonly attempts: number;
  readonly lastTarget: string | null;
  readonly target: string;
  readonly outcome: RunOutcome;
}): number {
  return -1;
}

export function shouldThrottleRetry(_input: {
  readonly attempts: number;
  readonly lastFailureAt: string | null;
  readonly now: Date;
}): boolean {
  return true;
}
