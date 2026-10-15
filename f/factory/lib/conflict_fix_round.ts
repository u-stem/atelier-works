// マージの競合を直す回(競合回)の、pr_fixの各ステップとwatcherが共有する部品。
// 競合回かの判定、停止の注記の固定文、スキルのマーカー、手動の再開の拒否を置く。
// 注記の固定文は、止める側と、注記から保留の理由へ写す側(`pr_conflict_fix_recovery.ts`)が同じ定数を使う。
// 片方だけを変えて写せなくなることを防ぐためである。

/**
 * 競合回の理由の接頭辞。競合回が作る理由はすべてこの文字列で始まる。
 * 理由を保留の理由へ写す規則が、競合回の理由を見分けるために使う。
 */
export const CONFLICT_ROUND_REASON_PREFIX = "conflict round";

/** factory-fixスキルが、競合を直す節を持つことを示す固定のマーカー。 */
export const CONFLICT_FIX_SKILL_MARKER = "conflict-fix-skill:v1";

/**
 * 停止の注記のうち、保留の理由(`fix_hold_reason`)に写すものの固定文。
 * 接頭辞の`conflict round: `は含まない。`upToDate`は止めた理由ではなく、
 * 何も変えずに終えた回(`reviewed`)の注記で、pushした回と区別するために使う。
 */
export const CONFLICT_ROUND_DETAILS = {
  baseNotDefault: "base is not the default branch",
  baseChangesWorkflows: "base changes workflows",
  protectedPath: "a conflicted path is protected",
  unresolvable: "unresolvable conflict",
  checkFailed: "check failed",
  upToDate: "up_to_date",
  markerMissing: `the factory-fix skill lacks the ${CONFLICT_FIX_SKILL_MARKER} marker`,
} as const;

/** 固定文`detail`に接頭辞を付けた、競合回の注記。 */
export function conflictRoundReason(detail: string): string {
  return `${CONFLICT_ROUND_REASON_PREFIX}: ${detail}`;
}

/** 競合回の作業項目か。`conflict_check_id`が非NULLなら、マージの競合を直す回である。 */
export function isConflictRound(item: {
  readonly conflict_check_id: number | null;
}): boolean {
  return item.conflict_check_id !== null;
}

/** factory-fixスキルの本文に、競合を直す節のマーカーがあるか。 */
export function hasConflictFixSkillMarker(skillText: string): boolean {
  return skillText.includes(CONFLICT_FIX_SKILL_MARKER);
}

/**
 * `retry_work_item`が、競合回の`pr_fix`を再開しない理由を返す。再開してよければnull。
 * 人が作業項目だけを再開しても、競合の行は直している作業項目を結んだままで、行と作業項目が食い違うため。
 * 理由の文は英語の1文で、そのままConsoleとWindmillに表示される。
 */
export function conflictRoundRetryRefusal(item: {
  readonly id: number;
  readonly kind: string;
  readonly conflict_check_id: number | null;
}): string | null {
  if (item.kind !== "pr_fix" || item.conflict_check_id === null) return null;
  return `retry_work_item: work item ${String(item.id)} is a conflict round; it was not restarted because the conflict check row stays bound to it. Resolve the conflict by pushing to the pull request instead`;
}
