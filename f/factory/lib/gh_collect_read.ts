// 収集が書いたGitHubの記録を、下流が読んでよいかの判定を持つ。
// リポジトリごとの鮮度と、使ってよい行の絞り込みを、通信もDBも持たない純粋関数で行う。

import type { GhPullRequest, GhRepoFreshnessRow } from "./types.ts";

/** 鮮度の判定が`stale`になる理由。 */
export type GhRepoStaleReason =
  | "no_record"
  | "unusable"
  | "not_collected"
  | "in_future"
  | "too_old";

export type GhRepoFreshness =
  | { readonly kind: "fresh" }
  | { readonly kind: "stale"; readonly reason: GhRepoStaleReason };

export function ghDetailStaleAfterMs(_ownerCount: number): number {
  return 0;
}

export function judgeGhRepoFreshness(
  _repo: GhRepoFreshnessRow | null,
  _openRows: readonly GhPullRequest[],
  _dbNow: Date,
  _staleAfterMs: number,
): GhRepoFreshness {
  return { kind: "stale", reason: "no_record" };
}

export function usableGhPullRequests(
  _owner: string,
  _repo: string,
  _repoId: number,
  _prs: readonly GhPullRequest[],
): GhPullRequest[] {
  return [];
}
