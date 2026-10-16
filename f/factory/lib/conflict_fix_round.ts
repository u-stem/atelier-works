// マージの競合を直す回(競合回)の、pr_fixの各ステップとwatcherが共有する部品。
// 競合回かの判定、停止の注記の固定文、スキルのマーカー、手動の再開の拒否を置く。
// 注記の固定文は、止める側と、注記から保留の理由へ写す側(`pr_conflict_fix_recovery.ts`)が同じ定数を使う。
// 片方だけを変えて写せなくなることを防ぐためである。
// baseをmergeした結果のツリーの検査(保護パス、workflow)と、Claudeの解消の検査もここに置く。
// どちらもgitを呼ばない純関数で、入力は呼び出し側が`workspace.ts`の関数で作る。

import {
  type CiFixChange,
  displayPath,
  isDeniedPath,
  isSafeRepoPath,
  isTestPath,
  weakensChecks,
} from "./ci_fix_paths.ts";
import { escapeReasonSeparator } from "./log.ts";
import type {
  BothSidesChangedPaths,
  ConflictBlobs,
  MergeBaseResult,
} from "./workspace.ts";

/**
 * 競合回の理由の接頭辞。競合回が作る理由はすべてこの文字列で始まる。
 * 理由を保留の理由へ写す規則が、競合回の理由を見分けるために使う。
 */
export const CONFLICT_ROUND_REASON_PREFIX = "conflict round";

/** factory-fixスキルが、競合を直す節を持つことを示す固定のマーカー。 */
export const CONFLICT_FIX_SKILL_MARKER = "conflict-fix-skill:v1";

/**
 * 停止の注記のうち、保留の理由(`fix_hold_reason`)に写すものの固定文。
 * 接頭辞の`conflict round: `は含まない。
 * - 保留の理由に写るもの: `baseNotDefault`、`baseChangesWorkflows`、`protectedPath`、`unresolvable`、`checkFailed`、`markerMissing`。
 * - `upToDate`と`baseChanged`は止めた理由ではなく、pushせずに終えた回(`reviewed`)の注記である。
 *   `upToDate`はpushが要らなかった回、`baseChanged`はpushの直前にbaseが動いた回で、どちらも行に最終の保留を書かない。
 * - `treeChangedDuringChecks`は検査コマンドがツリーを書き換えたときの注記で、保留の理由に写さない。
 *   待っても解けないので、回復は`fix_stopped`で最終の保留にする。
 * - 残りは一時の停止の注記である。待てば解ける事情で止めた回で、回復が行に保留を書かずに結びだけを外す。
 *   行の状態が変わったか、PRのheadが動いたか、worktreeを別の処理が使っているか、実装のフローが動いているかのいずれかである。
 *   `headMovedAtPush`だけはpushの直前に見つけるので、Claudeを動かした後の停止である。
 */
export const CONFLICT_ROUND_DETAILS = {
  baseNotDefault: "base is not the default branch",
  baseChangesWorkflows: "base changes workflows",
  protectedPath: "a conflicted path is protected",
  unresolvable: "unresolvable conflict",
  checkFailed: "check failed",
  upToDate: "up_to_date",
  baseChanged: "the base branch moved",
  rowMissing: "the conflict check row of the work item does not exist",
  rowNotConflicted: "the conflict check is not conflicted",
  rowBoundToAnother: "the conflict check is bound to another work item",
  episodeOver: "the conflict episode of the work item is over",
  headMoved: "the PR head moved while the fix was in progress",
  headMovedAtPush: "the PR head moved before the push",
  treeChangedDuringChecks: "the tree changed during the checks",
  worktreeBusy: "the worktree is in use by another process",
  implementRunning: "an implement flow is running on the branch",
  markerMissing: `the factory-fix skill lacks the ${CONFLICT_FIX_SKILL_MARKER} marker`,
} as const;

/** 固定文`detail`に接頭辞を付けた、競合回の注記。 */
export function conflictRoundReason(detail: string): string {
  return `${CONFLICT_ROUND_REASON_PREFIX}: ${detail}`;
}

/**
 * 競合回で、回数に数えない一時の停止の注記(接頭辞付き)。完全一致で照合する。
 * Claudeを動かす前の準備が止めた回で、Claudeの費用を使っていない。
 * 数えないので、繰り返しを止めるのは行の起動の回数(`fix_attempts`)の上限だけである。
 * `headMovedAtPush`は、Claudeを動かした後のpushの直前に見つけるので含めない。
 */
export const CONFLICT_UNCOUNTED_STOP_NOTES: readonly string[] = [
  CONFLICT_ROUND_DETAILS.rowMissing,
  CONFLICT_ROUND_DETAILS.rowNotConflicted,
  CONFLICT_ROUND_DETAILS.rowBoundToAnother,
  CONFLICT_ROUND_DETAILS.episodeOver,
  CONFLICT_ROUND_DETAILS.headMoved,
  CONFLICT_ROUND_DETAILS.worktreeBusy,
  CONFLICT_ROUND_DETAILS.implementRunning,
].map(conflictRoundReason);

/**
 * 一時の停止の注記(接頭辞付き)。待てば解ける事情で止めた回の注記で、回復が保留の理由に写さない。
 * 回数に数えない注記(`CONFLICT_UNCOUNTED_STOP_NOTES`)と、pushの直前のheadの不一致を合わせたものである。
 */
export const CONFLICT_TEMPORARY_STOP_NOTES: readonly string[] = [
  ...CONFLICT_UNCOUNTED_STOP_NOTES,
  conflictRoundReason(CONFLICT_ROUND_DETAILS.headMovedAtPush),
];

/**
 * Claudeの実行が失敗したときに、修正ステップが投げる例外の文の先頭。
 * 例外の文がそのまま作業項目の注記になるので、回復はこの先頭への一致で、Claudeの費用を使った失敗を見分ける。
 * 先頭の後ろには、失敗の理由の列挙値(`RunClaudeFailureReason`)だけを付ける。Claudeの出力は含めない。
 */
export const CONFLICT_CLAUDE_FAILED_NOTE_PREFIX = `pr_fix_apply: ${conflictRoundReason("claude run failed (")}`;

/** Claudeの実行の失敗を表す例外の文を作る。先頭は`CONFLICT_CLAUDE_FAILED_NOTE_PREFIX`である。 */
export function conflictClaudeFailedMessage(reason: string): string {
  return `${CONFLICT_CLAUDE_FAILED_NOTE_PREFIX}${reason})`;
}

/**
 * 一時の停止の理由を返す。競合回は固定文`detail`の注記、それ以外の回は元の理由`original`のままにする。
 * 競合回の注記は、回復が完全一致で行き先を決めるので、動的な値(shaや保持者)を含めない。
 */
export function roundStopReason<T extends string | null>(
  conflictRound: boolean,
  detail: string,
  original: T,
): string | T {
  return conflictRound ? conflictRoundReason(detail) : original;
}

/**
 * 準備のステップが`conflict_blocked`で返す理由の、注記の固定文(接頭辞付き)。
 * 完了のステップは、この一覧にある理由だけを作業項目の注記にする。回復が注記を保留の理由に写すとき、完全一致で照合するためである。
 */
export const CONFLICT_BLOCKED_NOTES: readonly string[] = [
  conflictRoundReason(CONFLICT_ROUND_DETAILS.baseNotDefault),
  conflictRoundReason(CONFLICT_ROUND_DETAILS.baseChangesWorkflows),
  conflictRoundReason(CONFLICT_ROUND_DETAILS.protectedPath),
  conflictRoundReason(CONFLICT_ROUND_DETAILS.unresolvable),
];

/** 準備のステップが、baseのmergeの結果を記録していないときの理由。何を解くかが分からないまま進めない。 */
export const CONFLICT_MERGE_NOT_RECORDED_REASON = conflictRoundReason(
  "the merge of the base was not recorded",
);

/** 競合回のClaudeの出力が返信を持つときの理由。返信を持つ出力は受け付けない。 */
export const CONFLICT_ROUND_REPLIES_REASON = conflictRoundReason(
  "the output of Claude carries replies",
);

/**
 * `evaluateMergedTree`が止めた理由を、注記の固定文に写す。
 * 結果のツリーにどちらの親にも無いパスがあるときと、安全でないパスがあるときは、直せない競合として扱う。
 */
export function mergedTreeStopDetail(reason: MergedTreeStopReason): string {
  switch (reason) {
    case "base_changes_workflows":
      return CONFLICT_ROUND_DETAILS.baseChangesWorkflows;
    case "protected_path":
      return CONFLICT_ROUND_DETAILS.protectedPath;
    case "unexpected_path":
    case "unsafe_path":
      return CONFLICT_ROUND_DETAILS.unresolvable;
  }
}

/** 競合の行のうち、準備のステップが照合する列。 */
export type ConflictRoundRowFacts = {
  readonly state: string;
  readonly episode: number;
  readonly head_sha: string;
  readonly fix_work_item_id: number | null;
};

export type ConflictRoundPrepareGuardInput = {
  readonly workItemId: number;
  /** 作業項目が直している競合の回(`work_items.conflict_episode`)。 */
  readonly workItemEpisode: number | null;
  /** いまのPRのhead。 */
  readonly prHeadSha: string;
  /** PRの`baseRef`。 */
  readonly baseRef: string;
  /** リポジトリの既定のブランチ。 */
  readonly defaultBranch: string;
  /** 作業項目の`conflict_check_id`が指す行。無ければnull。 */
  readonly row: ConflictRoundRowFacts | null;
};

export type ConflictRoundGuardResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** 準備のステップが返す結果。行の食い違いは`guard_blocked`、baseが既定のブランチでなければ`conflict_blocked`。 */
      readonly outcome: "guard_blocked" | "conflict_blocked";
      readonly reason: string;
    };

/**
 * 競合回を始めてよいかを、行と作業項目の対応で確かめる。
 * 行が競合のままで、この作業項目に結ばれ、作業項目と同じ競合の回で、PRのheadが行のheadと同じでなければ始めない。
 * 古い作業項目や、起動し直された作業項目が、別の競合を直すのを防ぐため。
 * PRのbaseが既定のブランチでなければ、直せない競合として`conflict_blocked`にする。
 */
export function evaluateConflictRoundPrepareGuard(
  input: ConflictRoundPrepareGuardInput,
): ConflictRoundGuardResult {
  const blocked = (detail: string): ConflictRoundGuardResult => ({
    ok: false,
    outcome: "guard_blocked",
    reason: conflictRoundReason(detail),
  });
  const { row } = input;
  if (row === null) return blocked(CONFLICT_ROUND_DETAILS.rowMissing);
  if (row.state !== "conflicted") {
    return blocked(CONFLICT_ROUND_DETAILS.rowNotConflicted);
  }
  if (row.fix_work_item_id !== input.workItemId) {
    return blocked(CONFLICT_ROUND_DETAILS.rowBoundToAnother);
  }
  if (input.workItemEpisode === null || row.episode !== input.workItemEpisode) {
    return blocked(CONFLICT_ROUND_DETAILS.episodeOver);
  }
  if (row.head_sha !== input.prHeadSha) {
    return blocked(CONFLICT_ROUND_DETAILS.headMoved);
  }
  if (input.baseRef !== input.defaultBranch) {
    return {
      ok: false,
      outcome: "conflict_blocked",
      reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.baseNotDefault),
    };
  }
  return { ok: true };
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

/**
 * 衝突マーカーに見える行(`<<<<<<<`、`|||||||`、`>>>>>>>`、`=======`のちょうど7文字で、空白か行末が続く行)を含むか。
 * 元のファイルにこの行があると、gitが書いたマーカーと本文を見分けられない。
 * 8文字以上の行は、gitがマーカーとして扱わないので含めない。
 */
export function hasConflictMarkerLikeLine(text: string): boolean {
  return /^(?:<{7}|>{7}|\|{7}|={7})(?:[ \t]|\r?$)/m.test(text);
}

/**
 * 衝突マーカー行のラベル(`<<<<<<< HEAD`の`HEAD`など)を取り除く。行末の改行は残す。
 * gitがmergeで書いたラベルと、`merge-file`の`-L`で付けたラベルは別の文字列なので、
 * 本文の食い違いを調べる前に、ラベルの違いだけを消すために使う。
 */
export function stripConflictMarkerLabels(text: string): string {
  return text.replace(/^(<{7}|>{7}|\|{7})(?: [^\r\n]*)?(?=\r?$)/gm, "$1");
}

// ---------------------------------------------------------------------------
// マージ結果のツリーの検査
// ---------------------------------------------------------------------------

/** `evaluateMergedTree`が止める理由。 */
export type MergedTreeStopReason =
  | "base_changes_workflows"
  | "protected_path"
  | "unexpected_path"
  | "unsafe_path";

export type MergedTreeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MergedTreeStopReason };

/** workflowの定義のディレクトリ(小文字)。PATに`workflow`スコープが無いので、この配下に差が出るmergeはpushできない。 */
const WORKFLOWS_DIRECTORY = ".github/workflows/";

/**
 * baseをmergeした結果のツリーが、競合回で扱える範囲かを判定する。Claudeを起動する前に使う。
 * 次の順で最初に当たる理由を返す。
 * 1. 結果が、どちらの親にも無いパスを持つ(`unexpected_path`)。mergeからは生まれないので、改ざんを疑う。
 * 2. `.github/workflows/`の配下に、PRのheadから結果への差がある(`base_changes_workflows`)。baseの側が変えたもので、
 *    PRのheadとbaseの片方だけが変えたパスも含む。大文字小文字は区別しない。
 * 3. 競合ファイルか、両側の親と違うパスが、安全なパスでない(`unsafe_path`)。
 * 4. 競合ファイルか、両側の親と違うパスが、保護パスに当たる(`protected_path`)。
 * baseの側だけが変えたパスは、結果がbaseと同じで、すでにレビューとマージを経ているので、保護パスでも止めない。
 */
export function evaluateMergedTree(input: {
  readonly conflictedPaths: readonly string[];
  readonly bothSides: BothSidesChangedPaths;
}): MergedTreeVerdict {
  const { bothSides } = input;
  if (bothSides.addedInBoth.length > 0) {
    return { ok: false, reason: "unexpected_path" };
  }
  if (
    bothSides.headToResult.some((path) =>
      path.toLowerCase().startsWith(WORKFLOWS_DIRECTORY),
    )
  ) {
    return { ok: false, reason: "base_changes_workflows" };
  }
  const checked = [...input.conflictedPaths, ...bothSides.bothSides];
  if (!checked.every((path) => isSafeRepoPath(path))) {
    return { ok: false, reason: "unsafe_path" };
  }
  if (checked.some((path) => isDeniedPath(path))) {
    return { ok: false, reason: "protected_path" };
  }
  return { ok: true };
}

/** 準備のステップが、mergeの結果から決める次の動き。 */
export type ConflictPreparePlan =
  /** Claudeに解かせる(競合ファイルが空なら、Claudeを起動せずにpushへ進む)。 */
  | {
      readonly kind: "proceed";
      readonly baseSha: string;
      readonly autoSha: string;
      readonly autoTreeSha: string;
      readonly conflictedPaths: string[];
      readonly conflictBlobs: ConflictBlobs[];
    }
  /** baseがすでにPRの履歴にある。何もpushしない。 */
  | { readonly kind: "up_to_date" }
  /** 競合回で直せない。`reason`は注記の固定文(接頭辞付き)である。 */
  | { readonly kind: "blocked"; readonly reason: string }
  /** worktreeのHEADがPRのheadと違う。誰かが先にpushした。 */
  | { readonly kind: "head_changed"; readonly currentSha: string };

/**
 * `mergeBaseIntoWorktree`の結果から、準備のステップの次の動きを決める。
 * `merged`は、結果のツリーがどちらの親とも違うパスを`listBothSides`で求め、保護パスとworkflowを調べる(`evaluateMergedTree`)。
 * 競合ファイルが空の`merged`(GitHubが競合と判定したが、ローカルではきれいにmergeできた)も同じ検査を通し、
 * 通れば`proceed`にする。Claudeを起動するかは、競合ファイルが空かどうかで呼び出し側が決める。
 * `unresolvable`は、理由の種類によらず、固定の注記(`unresolvable`)にまとめる。
 */
export async function planConflictPrepare(
  merge: MergeBaseResult,
  listBothSides: (
    autoTreeSha: string,
    baseSha: string,
  ) => Promise<BothSidesChangedPaths>,
): Promise<ConflictPreparePlan> {
  switch (merge.outcome) {
    case "up_to_date":
      return { kind: "up_to_date" };
    case "base_not_default":
      return {
        kind: "blocked",
        reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.baseNotDefault),
      };
    case "head_changed":
      return { kind: "head_changed", currentSha: merge.currentSha };
    case "unresolvable":
      return {
        kind: "blocked",
        reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.unresolvable),
      };
    case "merged": {
      const conflictedPaths = [...merge.conflictedPaths];
      const verdict = evaluateMergedTree({
        conflictedPaths,
        bothSides: await listBothSides(merge.autoTreeSha, merge.baseSha),
      });
      if (!verdict.ok) {
        return {
          kind: "blocked",
          reason: conflictRoundReason(mergedTreeStopDetail(verdict.reason)),
        };
      }
      return {
        kind: "proceed",
        baseSha: merge.baseSha,
        autoSha: merge.autoSha,
        autoTreeSha: merge.autoTreeSha,
        conflictedPaths,
        conflictBlobs: [...merge.conflictBlobs],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Claudeの解消の検査
// ---------------------------------------------------------------------------

/** 衝突マーカーのラベル。 */
export type ConflictMarkerLabels = {
  readonly ours: string;
  readonly base: string;
  readonly theirs: string;
};

const NONCE_PATTERN = /^[A-Za-z0-9]{8,64}$/;

/**
 * 解消の検査用に3つの版から作り直す衝突ブロックのラベルを、`nonce`から作る。
 * ファイルの内容が同じ文字列を書いても、ブロックの境目に見せかけられないようにする。
 * `nonce`は英数字の8〜64字で、それ以外は例外を投げる。
 */
export function conflictMarkerLabels(nonce: string): ConflictMarkerLabels {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("invalid nonce");
  return {
    ours: `ours-${nonce}`,
    base: `base-${nonce}`,
    theirs: `theirs-${nonce}`,
  };
}

/** 競合ファイル1つの、検査の入力。 */
export type ConflictFileInput = {
  readonly path: string;
  /** 共通の祖先の版(ステージ1)の本文。 */
  readonly base: string;
  /** PRのhead側の版(ステージ2)の本文。 */
  readonly ours: string;
  /** baseの側の版(ステージ3)の本文。 */
  readonly theirs: string;
  /**
   * 3つの版から`git merge-file -p --diff3 -L ours-<nonce> -L base-<nonce> -L theirs-<nonce>`で
   * 作り直した、衝突マーカー入りの本文。作業ファイルのテキストは使わない。
   * ファイルを書き換えられると、ブロックの境目を偽れるため。
   */
  readonly reconstructed: string;
  /** Claudeの解消後の本文。削除されていれば`null`。 */
  readonly result: string | null;
};

export type ConflictResolutionInput = {
  /** 作り直したときのラベルの`nonce`。 */
  readonly nonce: string;
  readonly files: readonly ConflictFileInput[];
  /** Claudeが基準コミットから加えた変更の一覧(`collectCiFixChanges`の結果)。 */
  readonly changes: readonly CiFixChange[];
};

/**
 * 解消の違反の種類。
 * - `unsafe_path`: リポジトリの相対パスとして信頼できない。
 * - `outside_conflict`: 競合ファイル以外を変えた(新規ファイルを含む)。
 * - `symlink`、`unsupported_change`: 通常のファイルでない。
 * - `file_deleted`: 競合ファイルを削除した。
 * - `marker_like_input`: 3つの版のどれかが、衝突マーカーに見える行を持つ。
 * - `marker_left`: 解消後に衝突マーカーが残った。
 * - `too_large`: 行数か衝突ブロックの数が多すぎて照合できない。
 * - `reconstruction_failed`: 作り直した本文のブロックが読めない。
 * - `not_in_conflict_block`: 衝突ブロックの外の行を変えた。
 * - `alignment_budget_exceeded`: 解消後の行を作り直した形に重ねる探索が、回数の上限に達した。安全側の失敗である。
 * - `reordered`: ブロックの中で、片側の行の順序を入れ替えた。
 * - `weakens_checks`: 新しく足した行が検査を弱める。
 * - `unknown_import`: 新しく足した行が、どちらの版も読み込まないモジュールを読み込む。
 * - `test_count_decreased`: テストファイルの`test(`、`it(`、`expect(`の数が、両側の大きい方を下回った。
 */
export type ConflictViolationCode =
  | "unsafe_path"
  | "outside_conflict"
  | "symlink"
  | "unsupported_change"
  | "file_deleted"
  | "marker_like_input"
  | "marker_left"
  | "too_large"
  | "reconstruction_failed"
  | "not_in_conflict_block"
  | "alignment_budget_exceeded"
  | "reordered"
  | "weakens_checks"
  | "unknown_import"
  | "test_count_decreased";

export type ConflictViolation = {
  readonly code: ConflictViolationCode;
  /** 表示してよい形に直したパス。 */
  readonly path: string;
};

export type ConflictResolutionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly ConflictViolation[] };

/** 1ファイルの行数の上限。超えたら照合せずに止める。 */
const MAX_RESOLUTION_LINES = 20_000;

/**
 * 解消後の行を作り直した形に重ねる探索の、回数の上限。
 * ブロックが隣り合い、行数が多い入力では、探索の回数が行数の2乗に比例して増える。
 * 上限に達したら重ねられなかったものとして止め、検査の時間を有界にする。
 */
const ALIGNMENT_STEP_BUDGET = 1_000_000;

/**
 * 作り直した形の区分(衝突ブロックとその外の行)の数の上限。
 * 重ねる探索の再帰の深さは区分の数に比例するので、上限を超える入力は探索せずに止める。
 * スタックを使い切って`RangeError`になるのを避けるためである。
 */
const MAX_ALIGNMENT_SEGMENTS = 1_000;

const SYMLINK_MODE = "120000";
const REGULAR_FILE_MODES: readonly string[] = ["100644", "100755"];

type ConflictBlock = {
  readonly kind: "block";
  readonly ours: readonly string[];
  readonly base: readonly string[];
  readonly theirs: readonly string[];
};

type ContextSegment = {
  readonly kind: "context";
  readonly lines: readonly string[];
};

type ConflictSegment = ContextSegment | ConflictBlock;

/**
 * 作り直した本文を、衝突ブロックと、その外の行に分ける。
 * ブロックの境目は、`nonce`入りのラベルの行と、base側の後ろの最初の`=======`だけで決める。
 * 形が崩れていれば(閉じていない、入れ子、ブロックの外のマーカー風の行)`null`を返す。
 */
function parseReconstruction(
  text: string,
  labels: ConflictMarkerLabels,
): ConflictSegment[] | null {
  const segments: ConflictSegment[] = [];
  let context: string[] = [];
  let section: "context" | "ours" | "base" | "theirs" = "context";
  let ours: string[] = [];
  let base: string[] = [];
  let theirs: string[] = [];
  const oursMarker = `<<<<<<< ${labels.ours}`;
  const baseMarker = `||||||| ${labels.base}`;
  const theirsMarker = `>>>>>>> ${labels.theirs}`;
  for (const raw of text.split("\n")) {
    // CRLFのファイルでは、gitはマーカー行も`\r\n`で書く。境目の判定では行末の`\r`を見ない。
    // ブロックの中の行は、`\r`を含めたまま持ち、解消後の行と1行ずつ比べる。
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (section === "context") {
      if (line === oursMarker) {
        segments.push({ kind: "context", lines: context });
        context = [];
        section = "ours";
      } else if (line === baseMarker || line === theirsMarker) {
        return null;
      } else if (hasConflictMarkerLikeLine(raw)) {
        return null;
      } else {
        context.push(raw);
      }
    } else if (section === "ours") {
      if (line === baseMarker) section = "base";
      else if (line === oursMarker || line === theirsMarker) return null;
      else ours.push(raw);
    } else if (section === "base") {
      if (line === "=======") section = "theirs";
      else if (line === oursMarker || line === baseMarker) return null;
      else base.push(raw);
    } else if (line === theirsMarker) {
      segments.push({ kind: "block", ours, base, theirs });
      ours = [];
      base = [];
      theirs = [];
      section = "context";
    } else if (line === oursMarker || line === baseMarker) {
      return null;
    } else {
      theirs.push(raw);
    }
  }
  if (section !== "context") return null;
  segments.push({ kind: "context", lines: context });
  return segments;
}

type BlockResolution = {
  readonly block: ConflictBlock;
  readonly lines: readonly string[];
};

function matchesAt(
  lines: readonly string[],
  position: number,
  expected: readonly string[],
): boolean {
  if (position + expected.length > lines.length) return false;
  return expected.every((line, index) => lines[position + index] === line);
}

/** 探索の回数が上限に達したことを、再帰の外へ伝える内部の例外。 */
class AlignmentBudgetExceeded extends Error {}

/**
 * 解消後の行を、作り直した形の区分に重ねる。ブロックの外の行は、1行ずつ同じでなければならない。
 * ブロックの中の解消は、次の区分の行が始まる最も手前で終わるものとする。
 * 重ねられなければ`null`を、探索の回数が`ALIGNMENT_STEP_BUDGET`に達したら`"budget_exceeded"`を返す。
 */
function alignResolution(
  segments: readonly ConflictSegment[],
  lines: readonly string[],
): BlockResolution[] | null | "budget_exceeded" {
  const failed = new Set<number>();
  let steps = 0;
  const spend = (): void => {
    steps += 1;
    if (steps > ALIGNMENT_STEP_BUDGET) throw new AlignmentBudgetExceeded();
  };
  const solve = (index: number, position: number): BlockResolution[] | null => {
    spend();
    if (index === segments.length) {
      return position === lines.length ? [] : null;
    }
    const key = index * (lines.length + 1) + position;
    if (failed.has(key)) return null;
    const segment = segments[index];
    let found: BlockResolution[] | null = null;
    if (segment?.kind === "context") {
      if (matchesAt(lines, position, segment.lines)) {
        found = solve(index + 1, position + segment.lines.length);
      }
    } else if (segment?.kind === "block") {
      for (
        let end = position;
        end <= lines.length && found === null;
        end += 1
      ) {
        spend();
        const rest = solve(index + 1, end);
        if (rest !== null) {
          found = [
            { block: segment, lines: lines.slice(position, end) },
            ...rest,
          ];
        }
      }
    }
    if (found === null) failed.add(key);
    return found;
  };
  try {
    return solve(0, 0);
  } catch (err) {
    // 区分の数の上限で防いでいるが、実行環境のスタックが浅いときの備えとして、`RangeError`も同じに扱う。
    if (err instanceof AlignmentBudgetExceeded || err instanceof RangeError) {
      return "budget_exceeded";
    }
    throw err;
  }
}

/** `lines`が、`source`の部分列(順序を保って、同じ行を重ねて使わない)か。 */
function isSubsequence(
  lines: readonly string[],
  source: readonly string[],
): boolean {
  let next = 0;
  for (const line of lines) {
    while (next < source.length && source[next] !== line) next += 1;
    if (next === source.length) return false;
    next += 1;
  }
  return true;
}

/** 行の読み込みの指定子。`from "x"`、`import "x"`、動的なimport、requireの引数の文字列を拾う。 */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`\n]+)\1/g;

function importSpecifiers(text: string): Set<string> {
  return new Set(
    [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[2] ?? ""),
  );
}

/** テストの数え方。`test(`、`it(`、`expect(`の出現数。 */
function countTestCalls(text: string): number {
  return [...text.matchAll(/\b(?:test|it|expect)\(/g)].length;
}

/** 解消後に残ってはいけない、衝突マーカーの行頭。`=======`は本文にありうるので見ない。 */
const LEFTOVER_MARKER = /^(?:<{7}|\|{7}|>{7}) /m;

/** 1ファイルの本文の検査で見つけた違反の種類を返す(重複なし)。 */
function contentViolationsOf(
  file: ConflictFileInput,
  result: string,
  labels: ConflictMarkerLabels,
): ConflictViolationCode[] {
  if (
    [file.base, file.ours, file.theirs].some((text) =>
      hasConflictMarkerLikeLine(text),
    )
  ) {
    return ["marker_like_input"];
  }
  if (LEFTOVER_MARKER.test(result)) return ["marker_left"];
  const resultLines = result.split("\n");
  if (
    resultLines.length > MAX_RESOLUTION_LINES ||
    file.reconstructed.split("\n").length > MAX_RESOLUTION_LINES
  ) {
    return ["too_large"];
  }
  const segments = parseReconstruction(file.reconstructed, labels);
  if (segments === null) return ["reconstruction_failed"];
  if (segments.length > MAX_ALIGNMENT_SEGMENTS) return ["too_large"];
  const resolutions = alignResolution(segments, resultLines);
  if (resolutions === "budget_exceeded") return ["alignment_budget_exceeded"];
  if (resolutions === null) return ["not_in_conflict_block"];

  const codes = new Set<ConflictViolationCode>();
  const newLines: string[] = [];
  for (const { block, lines } of resolutions) {
    const oursSet = new Set(block.ours);
    const theirsSet = new Set(block.theirs);
    const oursOnly = lines.filter((l) => oursSet.has(l) && !theirsSet.has(l));
    const theirsOnly = lines.filter((l) => theirsSet.has(l) && !oursSet.has(l));
    if (
      !isSubsequence(oursOnly, block.ours) ||
      !isSubsequence(theirsOnly, block.theirs)
    ) {
      codes.add("reordered");
    }
    newLines.push(...lines.filter((l) => !oursSet.has(l) && !theirsSet.has(l)));
  }
  if (weakensChecks(newLines)) codes.add("weakens_checks");
  const known = new Set([
    ...importSpecifiers(file.ours),
    ...importSpecifiers(file.theirs),
  ]);
  if (
    [...importSpecifiers(newLines.join("\n"))].some((spec) => !known.has(spec))
  ) {
    codes.add("unknown_import");
  }
  if (
    isTestPath(file.path) &&
    countTestCalls(result) <
      Math.max(countTestCalls(file.ours), countTestCalls(file.theirs))
  ) {
    codes.add("test_count_decreased");
  }
  return [...codes];
}

/**
 * Claudeによる競合の解消が、許された範囲に収まるかを検査する。1件でも違反があれば`ok: false`にする。
 *
 * 変更の範囲は、競合ファイルだけである。競合ファイル以外の変更は、新規ファイルを含めてすべて違反になる。
 * 競合ファイルは、通常のファイルのままで、削除してはいけない。
 *
 * 衝突ブロックは、作業ファイルのテキストではなく、3つの版から作り直した形(`reconstructed`)で決める。
 * ブロックの外の行は、作り直した形と1行ずつ同じで、順序も保つ。
 * ブロックの中の解消は、PRのheadの側とbaseの側の行を、それぞれ順序を保って選んだものと、新しく足した行だけである。
 * 新しく足した行は、検査を弱める記述(`weakensChecks`)を持たず、読み込む指定子がどちらの版にも現れるものに限る。
 * テストファイルは、`test(`、`it(`、`expect(`の出現数が、両側の大きい方を下回ってはいけない。
 * 同じ行を両側が変えた競合を1行にまとめる解消は、数が減らないので許す。
 * 衝突マーカーが結果に残ってはいけない。
 *
 * 意味の競合(署名の変更と、自動でmergeされた箇所に足した呼び出しの食い違い)は検出できない。
 * それは検査コマンドの失敗として現れる。
 */
export function checkConflictResolution(
  input: ConflictResolutionInput,
): ConflictResolutionVerdict {
  const labels = conflictMarkerLabels(input.nonce);
  const found = new Map<string, ConflictViolation>();
  const flagged = new Set<string>();
  const add = (code: ConflictViolationCode, path: string): void => {
    const shown = displayPath(path);
    found.set(`${code}\u0000${shown}`, { code, path: shown });
  };
  const conflicted = new Map(input.files.map((file) => [file.path, file]));

  for (const change of input.changes) {
    const { path } = change;
    if (!isSafeRepoPath(path)) {
      add("unsafe_path", path);
      flagged.add(path);
    } else if (!conflicted.has(path)) {
      add("outside_conflict", path);
    } else if (change.status === "deleted") {
      add("file_deleted", path);
      flagged.add(path);
    } else if (change.mode === SYMLINK_MODE || change.status === "typechange") {
      add("symlink", path);
      flagged.add(path);
    } else if (
      change.status === "unknown" ||
      !REGULAR_FILE_MODES.includes(change.mode)
    ) {
      add("unsupported_change", path);
      flagged.add(path);
    }
  }

  for (const file of input.files) {
    if (!isSafeRepoPath(file.path)) {
      add("unsafe_path", file.path);
      continue;
    }
    if (flagged.has(file.path)) continue;
    if (file.result === null) {
      add("file_deleted", file.path);
      continue;
    }
    for (const code of contentViolationsOf(file, file.result, labels)) {
      add(code, file.path);
    }
  }

  const violations = [...found.values()];
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * 解消の違反を、止める理由の一覧にする。
 * 理由は`conflict round: change not allowed (<違反の種類>): <パス>`の形である。
 * パスは外部由来なので、理由の区切り(`; `)を含めないようにする。
 */
export function conflictResolutionReasons(
  violations: readonly ConflictViolation[],
): string[] {
  return violations.map((violation) =>
    escapeReasonSeparator(
      conflictRoundReason(
        `change not allowed (${violation.code}): ${violation.path}`,
      ),
    ),
  );
}
