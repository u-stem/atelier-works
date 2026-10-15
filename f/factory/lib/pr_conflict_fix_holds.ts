// 競合を直す作業の保留の理由(`fix_hold_reason`)の語彙と、種別(一時か最終か)。
// DBの関数(`db.ts`)が一時の理由の一覧を読むので、依存を持たない小さなモジュールに分ける。
// `pr_conflict_support.ts`が同じ名前で再エクスポートする。

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

/** 一時の保留の理由の一覧。起動の文が、保留のままでも起動してよい行を絞るのに使う。 */
export const PR_CONFLICT_FIX_TEMPORARY_HOLD_REASONS: readonly PrConflictFixHoldReason[] =
  PR_CONFLICT_FIX_HOLD_REASONS.filter(
    (reason) => PR_CONFLICT_FIX_HOLD_INFO[reason].temporary,
  );
