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
 * 下書きは新しい競合の対象にしないが、競合が解けたかの判定は行う。
 */
export function decidePrConflict(pr: PrConflictFacts): PrConflictDecision {
  if (pr.state === "closed" || pr.merged) return { kind: "close" };
  // 競合が解けた判定は、下書きでも行う。下書きに戻したPRの通知を残さないためである。
  if (pr.mergeable === true) return { kind: "clear" };
  if (pr.draft) return { kind: "skip", reason: "draft" };
  if (pr.mergeable === null) return { kind: "skip", reason: "unknown" };
  if (pr.mergeableState !== "dirty") {
    return { kind: "skip", reason: "not_dirty" };
  }
  if (!isCommitSha(pr.headSha)) return { kind: "skip", reason: "invalid_sha" };
  return { kind: "conflict", headSha: pr.headSha };
}

// ---------------------------------------------------------------------------
// 競合を直す作業の保留の理由
// ---------------------------------------------------------------------------

/** `fix_hold_reason`列の長さの上限。DBのCHECK制約と同じ値にする。 */
export const PR_CONFLICT_FIX_HOLD_REASON_MAX_LENGTH = 64;

/**
 * 競合を直す作業項目を起動しない理由(`fix_hold_reason`)の語彙。
 * DBの検査は長さだけなので、書く側をこの型で縛る。
 *
 * 一時の理由は、解ければ外れる。起動の判断が毎回見直す。
 * - `last_fix_unsettled`: 直近の直す作業項目が、まだ終わっていない。
 * - `budget_exceeded`: 日次の予算を使い切った。
 * - `recently_fixed`: 直近の直す作業項目が終わってから日が浅い。GitHubのマージ可否の更新を待つ。
 * - `marker_missing`: Factoryのクローンのスキルが、競合を直す節を持たない。
 * - `main_ci_failed`: 既定のブランチの先頭のmainのCIが失敗している。
 *
 * 最終の理由は、人が直すまで起動し直さない。
 * - `pr_draft_or_auto_merge`: PRがドラフトか、auto-mergeが有効である。
 * - `not_factory_head`: PRのコミットにFactoryのものでないものがある。
 * - `rounds_exhausted`: 直す回数の上限に達した。
 * - `base_not_default`: PRのbaseが既定のブランチでない。
 * - `base_changes_workflows`: 既定のブランチの更新が`.github/workflows/`を変える。
 * - `protected_path`: 競合したパスが保護パスである。
 * - `unresolvable`: 競合が自動で解ける形でない。
 * - `check_failed`: 解消した後の検査コマンドが失敗した。
 * - `fix_stopped`: 直す作業項目が、上のどれにも当たらない理由で止まった。
 */
export const PR_CONFLICT_FIX_HOLD_REASONS = [
  "last_fix_unsettled",
  "budget_exceeded",
  "recently_fixed",
  "marker_missing",
  "main_ci_failed",
  "pr_draft_or_auto_merge",
  "not_factory_head",
  "rounds_exhausted",
  "base_not_default",
  "base_changes_workflows",
  "protected_path",
  "unresolvable",
  "check_failed",
  "fix_stopped",
] as const;

export type PrConflictFixHoldReason =
  (typeof PR_CONFLICT_FIX_HOLD_REASONS)[number];

export function isPrConflictFixHoldReason(
  value: unknown,
): value is PrConflictFixHoldReason {
  return PR_CONFLICT_FIX_HOLD_REASONS.some((reason) => reason === value);
}

export type PrConflictFixHoldInfo = {
  /** 解ければ外れる理由か。そうでなければ、人が直すまで起動し直さない。 */
  readonly temporary: boolean;
};

/** 保留の理由ごとの種別。 */
export const PR_CONFLICT_FIX_HOLD_INFO: Readonly<
  Record<PrConflictFixHoldReason, PrConflictFixHoldInfo>
> = {
  last_fix_unsettled: { temporary: true },
  budget_exceeded: { temporary: true },
  recently_fixed: { temporary: true },
  marker_missing: { temporary: true },
  main_ci_failed: { temporary: true },
  pr_draft_or_auto_merge: { temporary: false },
  not_factory_head: { temporary: false },
  rounds_exhausted: { temporary: false },
  base_not_default: { temporary: false },
  base_changes_workflows: { temporary: false },
  protected_path: { temporary: false },
  unresolvable: { temporary: false },
  check_failed: { temporary: false },
  fix_stopped: { temporary: false },
};

/**
 * 保留の理由が最終か。保留が無ければ偽である。
 * 語彙に無い値は最終として扱う。人に知らせず放置するより、通知に倒すためである。
 */
export function isFinalPrConflictFixHold(reason: string | null): boolean {
  if (reason === null) return false;
  if (!isPrConflictFixHoldReason(reason)) return true;
  return !PR_CONFLICT_FIX_HOLD_INFO[reason].temporary;
}

/**
 * このPRのnoticeの本文の接頭辞。
 * 自動解決は、種類とこの接頭辞で対象を選ぶ。末尾の区切りまで含めるので、
 * `acme/app#1: `は`acme/app#12: `に当たらない。
 * `owner`と`repo`は小文字にして作る。GitHubが返す綴りが場面によって違っても、通知と解決の接頭辞が一致するためである。
 */
export function prConflictNoticePrefix(
  owner: string,
  repo: string,
  prNumber: number,
): string {
  assertGitHubName(owner);
  assertGitHubName(repo);
  return `${owner}/${repo}#${String(prNumber)}: `.toLowerCase();
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
  // GitHubのURLは大文字小文字を区別しない。接頭辞と同じ綴りにそろえる。
  const link = pullRequestPageUrl(
    input.owner.toLowerCase(),
    input.repo.toLowerCase(),
    input.prNumber,
  );
  const prefix = prConflictNoticePrefix(
    input.owner,
    input.repo,
    input.prNumber,
  );
  return `${prefix}マージの競合があります。次の操作: ${PR_CONFLICT_NEXT_ACTION}。PR: ${link}`;
}
