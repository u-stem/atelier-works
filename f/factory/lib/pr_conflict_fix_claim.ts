// 競合している行について、競合を直す作業項目を起動してよいか(`decideConflictFixClaim`)と、
// 競合を通知してよいか(`decideConflictNotify`)を決める。
// 行を書く操作と起動は呼び出し側が行う。ここは何も書かず、読むだけである。
// 確かめる事実は、安く確かめられるものから順に、最初に当たった理由で止める。
// 事実はすべて`ConflictFixClaimReaders`で渡し、必要になるまで読まない。テストで差し替える。

import type { PrCommitMessages, PullRequest } from "./github.ts";
import type { MainCiState } from "./main_ci_support.ts";
import {
  allCommitsFromFactory,
  LAUNCH_FAILURE_ALLOWANCE,
} from "./pr_ci_fix_claim.ts";
import {
  isFinalPrConflictFixHold,
  type PrConflictFixHoldReason,
} from "./pr_conflict_support.ts";

/**
 * 直近の直す作業項目が終わってから、次を起動しない時間(ミリ秒)。
 * GitHubが競合の有無を更新するまで遅れることがあり、直した直後の競合を、直っていないと取り違えないためである。
 */
export const RECENTLY_FIXED_WINDOW_MS = 5 * 60_000;

/** 判定が読む事実。呼び出された順に読み、保留かskipが決まったら以後は読まない。 */
export type ConflictFixClaimReaders = {
  /** そのPRに、終端でない直す作業項目があるか。 */
  readonly hasActiveFix: () => Promise<boolean>;
  /** PRを読み直す。作業項目の状態より後に読む。 */
  readonly readPr: () => Promise<PullRequest>;
  /** リポジトリの既定のブランチの名前。 */
  readonly readDefaultBranch: () => Promise<string>;
  readonly readCommits: () => Promise<PrCommitMessages>;
  /** factory-fixスキルが、競合を直す節のマーカーを持つか。 */
  readonly hasSkillMarker: () => Promise<boolean>;
  /** 日次の予算を使い切ったか。 */
  readonly budgetExceeded: () => Promise<boolean>;
  /** 既定のブランチの先頭のコミットのmainのCIの状態。記録が無ければ`null`。 */
  readonly mainCiState: () => Promise<MainCiState | null>;
  /** 今の競合の回(`episode`)で起動した数。 */
  readonly countEpisodeRounds: () => Promise<number>;
  /** そのPRで、競合の回をまたいで起動した数。 */
  readonly countPrRounds: () => Promise<number>;
  /** 直近の競合を直す作業項目が、何も失敗せずに終わった時刻。無ければ`null`。 */
  readonly lastFixSettledAt: () => Promise<Date | null>;
};

export type ConflictFixClaimInput = {
  readonly row: {
    readonly head_sha: string;
    /** 行を起動した回数。起動の失敗で戻った回も数える。 */
    readonly fix_attempts: number;
  };
  readonly instanceName: string;
  /** 競合の1回で起動できる数の上限(`pr_conflict_fix_max_rounds`)。 */
  readonly maxRounds: number;
  /** 1つのPRで起動できる数の上限(`pr_conflict_fix_max_rounds_per_pr`)。 */
  readonly maxRoundsPerPr: number;
  readonly now: Date;
  readonly readers: ConflictFixClaimReaders;
};

/** 起動せず、行をそのままにする理由。次の巡回で読み直す。 */
export type ConflictFixClaimSkipReason = "pr_closed" | "head_moved";

export type ConflictFixClaimDecision =
  /** 起動してよい。`pr`は判定の途中で読み直したPRで、起動に使う。 */
  | { readonly kind: "claim"; readonly pr: PullRequest }
  /** 起動せず、行に保留の理由を書く。 */
  | { readonly kind: "hold"; readonly reason: PrConflictFixHoldReason }
  | { readonly kind: "skip"; readonly why: ConflictFixClaimSkipReason };

function hold(reason: PrConflictFixHoldReason): ConflictFixClaimDecision {
  return { kind: "hold", reason };
}

/**
 * 競合の行を起動してよいかを決める。次の順に確かめ、最初に当たったものを返す。
 * 1. 直す作業項目が動いていれば`last_fix_unsettled`で保留する。
 * 2. その後でPRを読み直す。閉じていれば、行のheadから進んでいれば、skipする。
 *    baseが既定のブランチでなければ`base_not_default`、ドラフトかauto-mergeが有効なら
 *    `pr_draft_or_auto_merge`で保留する。
 *    作業項目の状態を先に読むのは、読んでいる間に直す作業項目がpushしたとき、
 *    古いheadの行を起動しないためである。PRを先に読むと、その読み取りは古くなる。
 * 3. commitがすべてFactoryのものでなければ`not_factory_head`で保留する。
 * 4. スキルがマーカーを持たなければ`marker_missing`、予算を使い切っていれば`budget_exceeded`で保留する。
 * 5. 既定のブランチの先頭のmainのCIが失敗していれば`main_ci_failed`で保留する。
 *    記録が無い、判定待ち、期限切れ、CIなし、基準の行のときは止めない。
 * 6. 競合の1回の起動数か、PR全体の起動数が上限に達しているか、行の起動の回数が
 *    競合の1回の上限に`LAUNCH_FAILURE_ALLOWANCE`を足した数に達していれば`rounds_exhausted`で保留する。
 *    後者は、フローが起動しないまま起動し直し続けるのを止める。
 * 7. 直近の直す作業項目が終わってから`RECENTLY_FIXED_WINDOW_MS`未満なら`recently_fixed`で保留する。
 * 8. どれにも当たらなければ起動する。
 * 競合を直す起動は、Factoryのレビューの記録を要求しない。
 */
export async function decideConflictFixClaim(
  input: ConflictFixClaimInput,
): Promise<ConflictFixClaimDecision> {
  const { row, readers } = input;
  // 作業項目はPRが示す正規の綴りで引く。引き漏らしても、DBの起動が小文字で二重に守る。
  if (await readers.hasActiveFix()) return hold("last_fix_unsettled");

  const pr = await readers.readPr();
  if (pr.state !== "open") return { kind: "skip", why: "pr_closed" };
  if (pr.headSha !== row.head_sha) return { kind: "skip", why: "head_moved" };
  if (pr.baseRef !== (await readers.readDefaultBranch())) {
    return hold("base_not_default");
  }
  if (pr.draft || pr.autoMergeEnabled) return hold("pr_draft_or_auto_merge");

  if (!allCommitsFromFactory(await readers.readCommits(), input.instanceName)) {
    return hold("not_factory_head");
  }
  if (!(await readers.hasSkillMarker())) return hold("marker_missing");
  if (await readers.budgetExceeded()) return hold("budget_exceeded");
  if ((await readers.mainCiState()) === "failed") return hold("main_ci_failed");

  if (
    row.fix_attempts >= input.maxRounds + LAUNCH_FAILURE_ALLOWANCE ||
    (await readers.countEpisodeRounds()) >= input.maxRounds ||
    (await readers.countPrRounds()) >= input.maxRoundsPerPr
  ) {
    return hold("rounds_exhausted");
  }

  const settledAt = await readers.lastFixSettledAt();
  if (
    settledAt !== null &&
    input.now.getTime() - settledAt.getTime() < RECENTLY_FIXED_WINDOW_MS
  ) {
    return hold("recently_fixed");
  }
  return { kind: "claim", pr };
}

export type ConflictNotifyInput = {
  /** 競合を直す作業項目の起動が有効か(`pr_conflict_fix_enabled`)。 */
  readonly fixEnabled: boolean;
  /** 起動が有効になった時刻(`pr_conflict_fix_enabled_since`)。 */
  readonly enabledSince: Date | null;
  /** 一時の保留のまま通知を待つ時間(分)。 */
  readonly graceMin: number;
  readonly now: Date;
  readonly row: {
    readonly fix_hold_reason: string | null;
    readonly fix_work_item_id: number | null;
    /** 今の競合の回が始まった時刻。 */
    readonly episode_started_at: Date;
  };
};

/**
 * 通知していない競合の行を、通知するか、待つか、起動の判断に回すか。
 * - `notify`: 通知する。
 * - `defer`: 通知も起動もせず待つ。直す作業項目が動いている間である。
 * - `claim`: 通知せず、起動の判断(`decideConflictFixClaim`)に回す。一時の保留は、解ければ外れるので、
 *   猶予の間も毎回判断し直す。
 *
 * 次の順に決める。
 * 1. 起動が無効なら、常に`notify`である。起動を足す前の通知と同じ挙動を保つ。
 * 2. 起動が有効になる前に始まった競合の回は、起動の対象にしないので`notify`する。
 *    有効になった時刻が分からないときも`notify`する。
 * 3. 最終の保留は、猶予を待たずに`notify`する。語彙に無い保留も最終として扱う。
 * 4. 直す作業項目が動いていれば`defer`する。
 * 5. 一時の保留がある行と、保留も作業項目も無い行は、競合の回の開始から猶予が過ぎたら`notify`し、それまでは`claim`する。
 *    猶予は保留を書いた時刻でなく、競合の回の開始から数える。保留が付け外しされても、通知が遅れ続けないためである。
 *    保留が無い行にも猶予を掛けるのは、起動の判断が例外を投げ続けたり、起動の文が`null`を返し続けたりしても、通知を必ず出すためである。
 */
export function decideConflictNotify(
  input: ConflictNotifyInput,
): "notify" | "defer" | "claim" {
  if (!input.fixEnabled) return "notify";
  const { row } = input;
  if (
    input.enabledSince === null ||
    row.episode_started_at.getTime() < input.enabledSince.getTime()
  ) {
    return "notify";
  }
  if (isFinalPrConflictFixHold(row.fix_hold_reason)) return "notify";
  if (row.fix_work_item_id !== null) return "defer";
  // 保留があってもなくても、競合の回の開始から猶予が過ぎたら通知する。
  // 保留なしのまま起動できない行(判断の例外が続く、起動の文が毎回`null`を返す)で、通知が永久に出なくなるのを防ぐ。
  const graceEnd = row.episode_started_at.getTime() + input.graceMin * 60_000;
  return input.now.getTime() >= graceEnd ? "notify" : "claim";
}
