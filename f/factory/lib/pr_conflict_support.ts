// FactoryのPRのマージの競合を判断する純粋関数群。
// I/Oは持たない。GitHubの読み取り、DB、通知は`pr_conflict_watch.ts`が行う。
// 通知の本文には、固定文とPRのリンクだけを載せ、外部由来の文字列は載せない。

import type { PullRequest } from "./github.ts";
import { isCommitSha } from "./main_ci_support.ts";
import { pullRequestPageUrl } from "./pr_ci_support.ts";
import type { PrConflictFixHoldReason } from "./pr_conflict_fix_holds.ts";
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
 * - `not_factory`: 読み直したPRが、FactoryのPR(PATのアカウントが作った、forkでない、Factoryのブランチ)でない。
 */
export const PR_CONFLICT_SKIP_REASONS = [
  "draft",
  "unknown",
  "not_dirty",
  "invalid_sha",
  "not_factory",
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

export {
  isFinalPrConflictFixHold,
  isPrConflictFixHoldReason,
  PR_CONFLICT_FIX_HOLD_INFO,
  PR_CONFLICT_FIX_HOLD_REASON_MAX_LENGTH,
  PR_CONFLICT_FIX_HOLD_REASONS,
  PR_CONFLICT_FIX_TEMPORARY_HOLD_REASONS,
  type PrConflictFixHoldInfo,
  type PrConflictFixHoldReason,
} from "./pr_conflict_fix_holds.ts";

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
  /** 自動で直さなかった理由。渡すと、通知の本文に載せる。 */
  readonly hold?: PrConflictFixHoldReason;
};

/**
 * 保留の理由ごとの、自動で直さない理由の短い説明。通知の本文に載せる。
 * 理由の識別子は載せず、人が読んで状況が分かる言葉にする。
 */
export const PR_CONFLICT_FIX_HOLD_NOTE: Readonly<
  Record<PrConflictFixHoldReason, string>
> = {
  last_fix_unsettled: "直す作業が終わらないため",
  budget_exceeded: "日次の予算を使い切ったため",
  recently_fixed: "直した後も競合が残っているため",
  marker_missing: "factory-fixスキルが競合を直す手順を持たないため",
  main_ci_failed: "mainのCIが失敗しているため",
  pr_draft_or_auto_merge: "PRがドラフトか、auto-mergeが有効なため",
  not_factory_head: "Factoryが作っていないコミットがPRにあるため",
  rounds_exhausted: "直す回数の上限に達したため",
  base_not_default: "PRのbaseが既定のブランチでないため",
  base_changes_workflows:
    "mainの更新が.github/workflowsを変え、Factoryはpushできないため",
  protected_path: "競合したパスが保護パスのため",
  unresolvable: "競合が自動で解ける形でないため",
  check_failed: "解消した後の検査が失敗したため",
  fix_stopped: "直す作業が自動では解けない理由で止まったため",
};

/** 保留の理由によって、人が取る操作が違うときの固定文。 */
const PR_CONFLICT_FIX_HOLD_NEXT_ACTION: Partial<
  Readonly<Record<PrConflictFixHoldReason, string>>
> = {
  base_changes_workflows:
    "ローカルかwebでPRのブランチにベースブランチをmergeして競合を解消し、pushする。pushした後は、Factoryの自動修正の対象から外れる",
};

/**
 * 人が次にすることの固定文。保留の理由によって違うときだけ、理由ごとの文を返す。
 * 保留が無いときと、操作が共通の理由では、`PR_CONFLICT_NEXT_ACTION`を返す。
 */
export function prConflictNextAction(
  hold: PrConflictFixHoldReason | null,
): string {
  if (hold === null) return PR_CONFLICT_NEXT_ACTION;
  return PR_CONFLICT_FIX_HOLD_NEXT_ACTION[hold] ?? PR_CONFLICT_NEXT_ACTION;
}

/**
 * 競合を知らせるnoticeの本文。接頭辞、次の操作、PRのリンクだけを入れる。
 * 自動で直さなかった理由(`hold`)を渡すと、固定の説明(`PR_CONFLICT_FIX_HOLD_NOTE`)も入れる。
 * コミットのshaも、PRの題名やブランチ名のような外部由来の文字列も入れない。
 * 同じPRと同じ理由の本文は常に同じになり、未解決の通知がある間は重ねて登録されない。
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
  const why =
    input.hold === undefined
      ? ""
      : `自動では直しません(${PR_CONFLICT_FIX_HOLD_NOTE[input.hold]})。`;
  const action = prConflictNextAction(input.hold ?? null);
  return `${prefix}マージの競合があります。${why}次の操作: ${action}。PR: ${link}`;
}
