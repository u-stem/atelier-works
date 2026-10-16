// 競合回の修正ステップの流れ。Claudeを起動する前の確認、プロンプトの組み立て、出力の検査を行う。
// I/O(スキルの読み取り、Claudeの起動、gitleaks)は呼び出し側が注入する。
// 競合ファイルが無いmerge(GitHubは競合と判定したが、ローカルではきれいにmergeできた)は、Claudeを起動しない。

import { isSafeRepoPath } from "./ci_fix_paths.ts";
import { type CiTextScanner, guardCiRoundText } from "./ci_log_support.ts";
import type { RunClaudeFailureReason } from "./claude.ts";
import {
  buildConflictFixPrompt,
  type ConflictFixClaudeOutput,
  type ConflictFixPromptPr,
} from "./conflict_fix_prompt.ts";
import {
  CONFLICT_CLAUDE_FAILED_NOTE_PREFIX,
  CONFLICT_ROUND_DETAILS,
  conflictRoundReason,
  hasConflictFixSkillMarker,
} from "./conflict_fix_round.ts";
import { escapeReasonSeparator } from "./log.ts";

/**
 * Claudeの実行の失敗を表す例外の文を作る。先頭は`CONFLICT_CLAUDE_FAILED_NOTE_PREFIX`である。
 * 型を`RunClaudeFailureReason`にするので、列挙値以外の文字列は入らない。
 * 型を使う`claude.ts`への依存は、`conflict_fix_round.ts`に持たせない。持たせると、CIのテストの依存の範囲が広がる。
 */
export function conflictClaudeFailedMessage(
  reason: RunClaudeFailureReason,
): string {
  return `${CONFLICT_CLAUDE_FAILED_NOTE_PREFIX}${reason})`;
}

/** 競合ファイルが無いときの、修正ステップの要約。Claudeを起動しなかったことを示す。 */
export const CONFLICT_CLEAN_MERGE_SUMMARY =
  "競合ファイルが無かったため、Claudeを起動せずにbaseをmergeしました。";

/** 競合ファイルが無いmergeの結果。Claudeを起動せず、検査とpushへ進む。 */
export const CONFLICT_CLEAN_MERGE_RESULT = {
  kind: "finished",
  outcome: "done",
  reason: null,
  summary: CONFLICT_CLEAN_MERGE_SUMMARY,
} as const;

/** 要約の長さの上限(コードポイント)。Claudeの出力を、記録と通知にそのまま運ばないためである。 */
export const CONFLICT_SUMMARY_MAX_CHARS = 1000;

/** 止めた理由の長さの上限(コードポイント)。 */
export const CONFLICT_BLOCKED_REASON_MAX_CHARS = 300;

/** Claudeの`blocked_reason`の先頭に付ける接頭辞。次の操作の選択は、先頭の固定の文だけに当たる。 */
const CLAUDE_BLOCKED_PREFIX = conflictRoundReason("claude blocked");

/** Claudeの1回の実行の結果。失敗には詳細を持たせない。詳細は秘密値の検査を通っていないためである。 */
export type ConflictClaudeOutcome =
  | { readonly kind: "success"; readonly output: ConflictFixClaudeOutput }
  | { readonly kind: "failure"; readonly reason: RunClaudeFailureReason };

export type ConflictFixApplyDeps = {
  /** Factoryのcloneにある、factory-fixスキルの本文。 */
  readonly readSkillText: () => Promise<string>;
  readonly startClaude: (prompt: string) => Promise<ConflictClaudeOutcome>;
  readonly scan: CiTextScanner;
};

export type ConflictFixApplyInput = {
  readonly pr: ConflictFixPromptPr;
  readonly conflictedPaths: readonly string[];
};

export type ConflictFixApplyResult =
  /** Claudeが返した結果。文字列は検査を通っている。 */
  | {
      readonly kind: "finished";
      readonly outcome: "done" | "blocked";
      readonly reason: string | null;
      readonly summary: string;
    }
  /** Claudeを起動しなかったか、出力を受け付けなかった。 */
  | { readonly kind: "blocked"; readonly reason: string }
  /** Claudeの実行が失敗した。呼び出し側が、`.git`の確認の後に例外にする。 */
  | {
      readonly kind: "claude_failure";
      readonly reason: RunClaudeFailureReason;
    };

/** 文字列を、コードポイントで`max`までに切る。 */
function cutText(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join("");
}

/**
 * 競合回の修正を1回行う。
 * 競合ファイルが無ければ、Claudeを起動せずに`done`を返す。
 * Claudeを起動する前に、次を確かめ、満たさなければ起動せずに`blocked`を返す。
 * - factory-fixスキルが競合回のマーカーを持つ。持たないと、競合回の規約を知らないClaudeに直させることになる。
 * - 競合ファイルのパスが、リポジトリの相対パスとして安全である。
 * Claudeが返した要約と理由は、長さを切り、gitleaksで1回検査する。
 * 検出があったとき、検査できなかったときは、文字列を返さずに`blocked`にする。
 */
export async function runConflictFixApply(
  deps: ConflictFixApplyDeps,
  input: ConflictFixApplyInput,
): Promise<ConflictFixApplyResult> {
  if (input.conflictedPaths.length === 0) return CONFLICT_CLEAN_MERGE_RESULT;
  if (!hasConflictFixSkillMarker(await deps.readSkillText())) {
    return {
      kind: "blocked",
      reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.markerMissing),
    };
  }
  if (!input.conflictedPaths.every((path) => isSafeRepoPath(path))) {
    return {
      kind: "blocked",
      reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.unresolvable),
    };
  }
  const claude = await deps.startClaude(
    buildConflictFixPrompt({
      pr: input.pr,
      conflictedPaths: input.conflictedPaths,
    }),
  );
  if (claude.kind === "failure") {
    return { kind: "claude_failure", reason: claude.reason };
  }
  const { output } = claude;
  const guarded = await guardCiRoundText(
    {
      commit_subject: "",
      commit_body: null,
      summary: cutText(output.summary, CONFLICT_SUMMARY_MAX_CHARS),
      blocked_reason:
        output.blocked_reason === null
          ? null
          : cutText(output.blocked_reason, CONFLICT_BLOCKED_REASON_MAX_CHARS),
    },
    { scan: deps.scan },
  );
  if (guarded.kind === "secret_detected") {
    return {
      kind: "blocked",
      reason: conflictRoundReason(
        `the output of Claude matched the secret scan (${guarded.reason})`,
      ),
    };
  }
  const { fields } = guarded;
  const blockedReason =
    fields.blocked_reason === null
      ? null
      : `${CLAUDE_BLOCKED_PREFIX}: ${escapeReasonSeparator(fields.blocked_reason)}`;
  return {
    kind: "finished",
    outcome: output.outcome,
    reason:
      output.outcome === "blocked"
        ? (blockedReason ?? CLAUDE_BLOCKED_PREFIX)
        : null,
    summary: fields.summary,
  };
}
