// FactoryのPRのマージの競合を判断する純粋関数群。
// I/Oは持たない。GitHubの読み取り、DB、通知は`pr_conflict_watch.ts`が行う。
// 通知の本文には、固定文とPRのリンクだけを載せ、外部由来の文字列は載せない。

import type { PullRequest } from "./github.ts";
import { isCommitSha } from "./main_ci_support.ts";
import { pullRequestPageUrl } from "./pr_ci_support.ts";
import { assertGitHubName } from "./types.ts";

/** マージの競合を知らせるnoticeの種類。 */
export const PR_CONFLICT_KIND = "pr_conflict";

/**
 * 自動で解決したnoticeの`resolved_by`に記録する名前。
 * Consoleが日本語の名前に直すので、変えるときは`console/src/lib/systemView.ts`も直す。
 */
export const PR_CONFLICT_RESOLVED_BY = "watch_pr_conflicts";

/** Discordの通知に載せる理由のコード。 */
export const PR_CONFLICT_REASON = "merge_conflict";

/** 人が次にすることの固定文。noticeの本文とDiscordの通知に載せる。 */
export const PR_CONFLICT_NEXT_ACTION =
  "PRのブランチにベースブランチをmergeして競合を解消し、pushする";

/** 判断に使う、PRの列。 */
export type PrConflictFacts = Pick<
  PullRequest,
  "state" | "merged" | "draft" | "headSha" | "mergeable" | "mergeableState"
>;

/**
 * 何もしない理由。
 * - `draft`: 下書きのPRは対象にしない。
 * - `unknown`: GitHubがまだ計算していない(`mergeable`が`null`)。真偽に丸めず、次の巡回で判定し直す。
 * - `not_dirty`: 競合していないとは言えないが、競合とも言えない(`mergeable`は偽で`mergeable_state`が`dirty`でない)。
 * - `invalid_sha`: 競合しているが、headが完全なコミットshaでなく、記録できない。
 */
export const PR_CONFLICT_SKIP_REASONS = [
  "draft",
  "unknown",
  "not_dirty",
  "invalid_sha",
] as const;

export type PrConflictSkipReason = (typeof PR_CONFLICT_SKIP_REASONS)[number];

export function isPrConflictSkipReason(
  value: unknown,
): value is PrConflictSkipReason {
  return PR_CONFLICT_SKIP_REASONS.some((reason) => reason === value);
}

/** PRの今の状態から決めた扱い。 */
export type PrConflictDecision =
  /** PRが閉じられたか、マージされた。 */
  | { readonly kind: "close" }
  /** 競合している。記録するheadのコミット。 */
  | { readonly kind: "conflict"; readonly headSha: string }
  /** 競合していない(`mergeable`が真)。 */
  | { readonly kind: "clear" }
  | { readonly kind: "skip"; readonly reason: PrConflictSkipReason };

/**
 * PRの今の状態から、競合の扱いを決める。
 * 競合とみなすのは、`mergeable`が偽で`mergeable_state`が`dirty`のときだけである。
 * `mergeable`が`null`のときは、GitHubが計算中なので何も決めない。
 * 競合が解けたとみなすのは、`mergeable`が真のときだけである。checksやレビューで`blocked`でも、競合はしていない。
 */
export function decidePrConflict(pr: PrConflictFacts): PrConflictDecision {
  if (pr.state === "closed" || pr.merged) return { kind: "close" };
  if (pr.draft) return { kind: "skip", reason: "draft" };
  if (pr.mergeable === null) return { kind: "skip", reason: "unknown" };
  if (pr.mergeable) return { kind: "clear" };
  if (pr.mergeableState !== "dirty") {
    return { kind: "skip", reason: "not_dirty" };
  }
  if (!isCommitSha(pr.headSha)) return { kind: "skip", reason: "invalid_sha" };
  return { kind: "conflict", headSha: pr.headSha };
}

/**
 * このPRのnoticeの本文の接頭辞。
 * 自動解決は、種類とこの接頭辞で対象を選ぶ。末尾の区切りまで含めるので、
 * `acme/app#1: `は`acme/app#12: `に当たらない。
 */
export function prConflictNoticePrefix(
  owner: string,
  repo: string,
  prNumber: number,
): string {
  assertGitHubName(owner);
  assertGitHubName(repo);
  return `${owner}/${repo}#${String(prNumber)}: `;
}

export type PrConflictNoticeInput = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
};

/**
 * 競合を知らせるnoticeの本文。接頭辞、次の操作、PRのリンクだけを入れる。
 * コミットのshaも、PRの題名やブランチ名のような外部由来の文字列も入れない。
 * 同じPRの本文は常に同じになり、未解決の通知がある間は重ねて登録されない。
 * `owner`と`repo`がGitHubの名前の形でないとき、PR番号が正の整数でないときは例外を投げる。
 */
export function prConflictNoticeMessage(input: PrConflictNoticeInput): string {
  const link = pullRequestPageUrl(input.owner, input.repo, input.prNumber);
  const prefix = prConflictNoticePrefix(
    input.owner,
    input.repo,
    input.prNumber,
  );
  return `${prefix}マージの競合があります。次の操作: ${PR_CONFLICT_NEXT_ACTION}。PR: ${link}`;
}
