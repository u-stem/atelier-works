/** 反映の目標の決定、noopの判定、拒否の控え、失敗の回数の規則。 */

import {
  ATTEMPT_THROTTLE_AFTER,
  ATTEMPT_THROTTLE_INTERVAL_MS,
  FAILED_NOTIFY_AFTER,
} from "./constants.ts";

export type RejectionKind =
  | "compose_forbidden"
  | "mise_forbidden"
  | "unknown_service"
  | "caddy_invalid"
  | "not_ff"
  | "tree_forbidden"
  | "ci_failed"
  | "docker_version";

export type RejectionRecord = {
  readonly kind: RejectionKind;
  readonly at: string;
  readonly executor_version: string;
};

/**
 * 目標の内容だけで決まる拒否。同じ目標では結果が変わらないので、控えて飛ばす。
 * `ci_failed`と`docker_version`は、CIの再実行やdockerの更新で変わるので含めない。
 * `not_ff`は適用済みのコミットで決まるので、適用済みが進めば結果が変わる。控えずに毎回確かめる。
 */
export const CONTENT_REJECTION_KINDS: readonly RejectionKind[] = [
  "compose_forbidden",
  "mise_forbidden",
  "unknown_service",
  "caddy_invalid",
  "tree_forbidden",
];

export function isContentRejection(kind: RejectionKind): boolean {
  return CONTENT_REJECTION_KINDS.includes(kind);
}

/**
 * 古い順のコミットの並びから目標を選ぶ。目標は先端の1つだけで、途中のコミットは評価しない。
 */
export function selectTarget(commits: readonly string[]): string | null {
  return commits[commits.length - 1] ?? null;
}

export type TargetDecision =
  | { readonly kind: "noop" }
  | { readonly kind: "skip_rejected"; readonly rejection: RejectionKind }
  | { readonly kind: "continue_converging"; readonly sha: string }
  | { readonly kind: "proceed"; readonly target: string };

export type DecideTargetInput = {
  /** `origin/main`の先端。 */
  readonly tip: string;
  readonly applied: string | null;
  /** 先端が`applied`の祖先であるか。 */
  readonly tipIsAncestorOfApplied: boolean;
  readonly rejected: Readonly<Record<string, RejectionRecord>>;
  readonly converging: { readonly sha: string } | null;
  readonly executorVersion: string;
};

/**
 * 今回の実行が何を扱うかを決める。
 * 排水を始めた目標があれば、先端が変わっていても先にそれを終える。
 * 先端が適用済みと同じか祖先なら、拒否せずnoopにする。
 */
export function decideTarget(input: DecideTargetInput): TargetDecision {
  if (input.converging !== null) {
    return { kind: "continue_converging", sha: input.converging.sha };
  }
  if (input.tip === input.applied || input.tipIsAncestorOfApplied) {
    return { kind: "noop" };
  }
  const record = input.rejected[input.tip];
  if (
    record !== undefined &&
    record.executor_version === input.executorVersion &&
    isContentRejection(record.kind)
  ) {
    return { kind: "skip_rejected", rejection: record.kind };
  }
  return { kind: "proceed", target: input.tip };
}

/**
 * 内容で決まる拒否だけを控えに足した写しを返す。環境や適用済みのコミットで変わる拒否は足さない。
 * 控えには実行役の版を持たせる。判定の規則が変わった版では、古い控えを使わない。
 */
export function recordRejection(
  rejected: Readonly<Record<string, RejectionRecord>>,
  sha: string,
  kind: RejectionKind,
  at: string,
  executorVersion: string,
): Record<string, RejectionRecord> {
  if (!isContentRejection(kind)) return { ...rejected };
  return {
    ...rejected,
    [sha]: { kind, at, executor_version: executorVersion },
  };
}

export type RunOutcome =
  | "converged"
  | "failed"
  | "skipped_offline"
  | "pending"
  | "rejected"
  | "noop"
  | "disabled";

/**
 * 連続した失敗の回数の次の値を返す。
 * 収束に成功したときは0へ戻す。目標が変わったときは、その回の失敗を1と数え、失敗でなければ0にする。
 * 失敗だけを数え、オフライン、保留、拒否などは数えない。
 */
export function nextAttempts(input: {
  readonly attempts: number;
  readonly lastTarget: string | null;
  readonly target: string;
  readonly outcome: RunOutcome;
}): number {
  if (input.outcome === "converged") return 0;
  if (input.lastTarget !== input.target) {
    return input.outcome === "failed" ? 1 : 0;
  }
  if (input.outcome === "failed") return input.attempts + 1;
  return input.attempts;
}

/**
 * 失敗が続いた目標の再試行を、間引くべきかを返す。
 * 失敗の回数が閾値を超えたら、最後の失敗から一定の間隔が空くまで再試行しない。
 * 時刻が読めないときは、再試行を止めない。
 */
export function shouldThrottleRetry(input: {
  readonly attempts: number;
  readonly lastFailureAt: string | null;
  readonly now: Date;
}): boolean {
  if (input.attempts <= ATTEMPT_THROTTLE_AFTER) return false;
  if (input.lastFailureAt === null) return false;
  const last = Date.parse(input.lastFailureAt);
  if (Number.isNaN(last)) return false;
  return input.now.getTime() - last < ATTEMPT_THROTTLE_INTERVAL_MS;
}

/** 連続した失敗の回数が、通知する回数に達したか。 */
export function shouldNotifyRepeatedFailure(attempts: number): boolean {
  return attempts >= FAILED_NOTIFY_AFTER;
}
