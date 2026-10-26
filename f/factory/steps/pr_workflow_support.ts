// pr_reviewとpr_fixのステップスクリプトが使う判断ロジックと、
// 小さなI/O補助をまとめる。
// 判断ロジックはI/Oを持たない純粋関数で、偽物の入力だけでテストできる。
// 各ステップの`main`はこれらを呼び、その結果に従ってI/Oだけを行う。
// I/O補助(gitの実行やworktreeのファイル読み取りなど)は、
// `lib/`にまだ同等の関数が無い操作に限って置く。

import { lstat, readlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  CheckEnvironmentError,
  isCheckEnvironmentReason,
} from "../lib/check_sandbox.ts";
import {
  CI_FIX_GITLEAKS_TIMEOUT_MS,
  CI_ROUND_DETAILS,
  CI_ROUND_REASON_PREFIX,
  CI_TEST_BASE_UNKNOWN_REASON_PREFIX,
  ciRoundApplyTimeoutMisfit,
  ciRoundReason,
  ciRoundVerifyTimeoutMisfit,
  isCiFixOutputAllowed,
} from "../lib/ci_fix_round.ts";
import { conflictRoundReason } from "../lib/conflict_fix_round.ts";
import {
  DEPENDABOT_DRY_RUN_REASON,
  DEPENDABOT_HOLD_UNREADABLE_PREFIX,
  DEPENDABOT_MERGE_FORBIDDEN_REASON,
  DEPENDABOT_MERGE_HELD_REASON,
  DEPENDABOT_MERGE_REFUSED_REASON,
  DEPENDABOT_REASON_PREFIX,
  DEPENDABOT_RESULT_UNKNOWN_REASON,
  DEPENDABOT_TIMEOUT_MISFIT_REASON,
} from "../lib/dependabot_flow_support.ts";
import { isViewerBumpBranch } from "../lib/drawio_viewer_bump.ts";
import {
  endsWithMarkerLine,
  type GhClient,
  getBranchProtected,
  getBranchRuleCount,
  getDefaultBranch,
  isOwnPost,
  type PrReview,
  type ReviewThread,
  withMarker,
} from "../lib/github.ts";
import {
  decideGapReroute,
  SECRETS_NOT_PUSHED_REASON,
} from "../lib/implement_finish_support.ts";
import { parseFlowJobId } from "../lib/implement_launch_support.ts";
import { gitPointerStopReason } from "../lib/implement_loop.ts";
import { escapeReasonSeparator, maskSecrets } from "../lib/log.ts";
import { holdReasonForStoppedItem } from "../lib/pr_ci_fix_recovery.ts";
import { prCiFixHoldInfo } from "../lib/pr_ci_support.ts";
import { type LockOwner, WorktreeBusyError } from "../lib/process_lock.ts";
import {
  ASCII_BOUNDARY_CLASS,
  COMMIT_MESSAGE_RULES,
  checkProseFields,
  GITHUB_PROSE_RULES,
  JAPANESE_CHAR_CLASS,
} from "../lib/prose_check.ts";
import {
  type ChangedPath,
  type ChangedPathStatus,
  isNewShellScript,
  matchesForbiddenPath,
} from "../lib/protected_paths.ts";
import { isRepoOwnerStopReason } from "../lib/repo_owner_gate.ts";
import {
  assertSha,
  type FactoryConfig,
  type FixOutcome,
  type FixReply,
  type FixReplyDecision,
  type IssueProposalStatus,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  type LabelerAssociation,
  type NoticeRecord,
  type ReviewFinding,
  type ReviewFindingKind,
  type ReviewOutcome,
  type ReviewRecord,
  type ReviewSeverity,
  type ReviewVerdict,
  type WorkItem,
  type WorkItemKind,
  type WorkItemStatus,
} from "../lib/types.ts";
import {
  assertOutputComplete,
  buildGitArgv,
  type CommandRunner,
  type ConflictBlobs,
  type GitleaksScan,
  localGitEnv,
  readGitShowFile,
} from "../lib/workspace.ts";

// `pr_fix_verify.ts`と既存のテストがこのファイルから読み込めるよう、
// `lib/protected_paths.ts`の定義を再エクスポートする。
// 定義を`lib/`に置くのは、`lib/implement_support.ts`も
// `steps/`を読み込まずに同じ分類を使うため。
export {
  type ChangedPath,
  type ChangedPathStatus,
  FORBIDDEN_BASENAME_PATTERNS,
  FORBIDDEN_PATH_PREFIXES,
  IMPLEMENT_PROTECTED_PATH_PREFIXES,
  isNewShellScript,
  matchesForbiddenPath,
} from "../lib/protected_paths.ts";

// ---------------------------------------------------------------------------
// 役割タグ。Factoryは専用のbotではなく運用者自身のアカウントで
// GitHubに投稿するため、投稿の1行目にどのジョブが書いたかを示す。
// タグが無いと、PRのタイムラインを読む人は、Factoryの投稿と
// 運用者が手で書いた投稿を見分けられない。
// タグの文言は投稿形式の固定部分で、運用者が調整する設定ではないので、
// `factory_config`ではなくここに置く。
// ---------------------------------------------------------------------------

/**
 * バイナリのファイルの一覧に並べるパスの上限。残りは件数だけを書く。
 * プロンプトの同名の定数(`prompts.ts`)と同じ値にする。
 * importを足すと、メタデータの事前検査が辿る回数が予算に近づくため、値を複製し、テストで確かめる。
 */
export const BINARY_LIST_MAX_FILES = 20;

export const ROLE_TAGS = {
  pr_review: "[pr_review 自動レビュー]",
  pr_fix: "[pr_fix 自動返信]",
} as const;

// ---------------------------------------------------------------------------
// 日本語の書式の正規化。このプロジェクトの規約では英字と日本語の間に
// 半角スペースを入れないが、Claudeの構造化出力の文章(指摘の`message`と
// `suggestion`、レビューの`summary`、pr_fixの返信の`body`)には、
// ときどきスペースが入る(「3件」が「3 件」になるなど)。
// Claudeの出力は信頼できない入力の影響を受ける自由文なので、
// プロンプトの指示だけに頼らず、描画時(下の`renderInlineComment`、
// `renderReviewSummary`、`renderFixReply`)に直す。
// ---------------------------------------------------------------------------

// 「日本語の文字」と「英字の並びの端」の範囲は、文章の検査(`lib/prose_check.ts`)と同じものを使う。

const JAPANESE_CHAR_RE = new RegExp(`[${JAPANESE_CHAR_CLASS}]`);
const ASCII_BOUNDARY_RE = new RegExp(`[${ASCII_BOUNDARY_CLASS}]`);

/**
 * 複数行にわたるフェンス(```...```)のブロックか、
 * 改行をまたがないインラインの`...`に一致する。
 * 改行をまたがないのは、Markdownのインラインコードと同じ扱いにするため。
 * 一致した範囲は`normalizeJapaneseText`が変更しない。
 */
const CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * 英字の並びと日本語の文字の間にある半角スペース1つを、
 * どちらの順でも取り除く(例: 「N 件」→「N件」、「LGTM です」→「LGTMです」、
 * 「`code` です」→「`code`です」)。
 * 英字の並びとは、英数字、`)`、`]`、閉じバッククォートで終わる(始まる)並びを指す。
 * フェンスのブロックとインラインのバッククォートの中は、
 * 内側の端にあるスペースも含めて変更しない。
 * スパンの閉じバッククォートは、その外側のスペースに対しては英字の境界として数えるが、
 * スパンの内側のスペースは対象にしない。
 * 取り除くのは`" "`だけで、改行には触れず、改行をまたがない。
 */
export function normalizeJapaneseText(text: string): string {
  const protectedRanges: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(CODE_SEGMENT_PATTERN)) {
    const start = match.index;
    protectedRanges.push([start, start + match[0].length]);
  }
  const isProtected = (index: number): boolean =>
    protectedRanges.some(([start, end]) => index >= start && index < end);

  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const before = text[i - 1] ?? "";
    const after = text[i + 1] ?? "";
    const removable =
      char === " " &&
      !isProtected(i) &&
      before.length > 0 &&
      after.length > 0 &&
      ((ASCII_BOUNDARY_RE.test(before) && JAPANESE_CHAR_RE.test(after)) ||
        (JAPANESE_CHAR_RE.test(before) && ASCII_BOUNDARY_RE.test(after)));
    if (!removable) {
      result += char;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// レビュー結果。PRにはFactoryが付け替える状態ラベルを付けない
// (`poll_prs.ts`の`listTrackedPrs`は`work_items`からPRを見つけ直す)。
// そのため結果はDiscordの通知だけに使う値で、GitHubへの副作用は無い。
// ---------------------------------------------------------------------------

/**
 * 投稿したレビューの結果を返す。
 * 今回の指摘に`must`が1件でもあるか、`openMustCount`
 * (`countOpenMustThreads`の値)が0より大きければ`"changes_requested"`を返す。
 * 前のラウンドから残った未解決の`[MUST]`は、新しい指摘を投稿しないラウンド
 * (`ReviewBodyMode`の`"rereview_open"`)でも、変更が必要なPRとして扱うため。
 * `openMustCount`が`null`のときは、スレッドの一覧を読めず残りの有無が分からない。
 * 今回の指摘に`must`が無ければ`"unverified"`を返す。0件と同じ`"reviewed"`にすると、
 * 未解決の`[MUST]`が残るPRを、人の承認を待てる状態と誤って示すため。
 * それ以外(指摘が無く、未解決の`must`も無いと分かっている場合を含む)は`"reviewed"`を返す。
 * これは止める理由が無く、人の承認を待つ状態である。
 */
export function reviewResultFor(
  findings: readonly ReviewFinding[],
  openMustCount: number | null,
): ReviewOutcome {
  if (findings.some((finding) => finding.kind === "must")) {
    return "changes_requested";
  }
  if (openMustCount === null) return "unverified";
  return openMustCount > 0 ? "changes_requested" : "reviewed";
}

/**
 * `factory.reviews`に書く行を組み立てる。
 * `result`は、今回の指摘と`openMustCount`から`reviewResultFor`で決める。
 * Discordの通知もConsoleのレビュー行も、この値で状態を出す。
 * `verdict`が`approve`で今回の指摘が0件でも、未解決の`[MUST]`が残れば`changes_requested`になる。
 * 未解決の指摘を読めなかった(`unverified`)ときは、`result`を`null`にして記録する。
 * Consoleのレビュー行は、`null`を「修正必須の有無の記録なし」と出す。
 */
export function buildReviewRecord(input: {
  readonly workItemId: number;
  readonly headSha: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly openMustCount: number | null;
  readonly postedReviewId: string | null;
}): ReviewRecord {
  const outcome = reviewResultFor(input.findings, input.openMustCount);
  return {
    work_item_id: input.workItemId,
    head_sha: input.headSha,
    verdict: input.verdict,
    result: outcome === "unverified" ? null : outcome,
    summary: input.summary,
    findings: [...input.findings],
    posted_review_id: input.postedReviewId,
  };
}

// ---------------------------------------------------------------------------
// pr_review_prepare: 処理を進めるかの判断(純粋関数)
// ---------------------------------------------------------------------------

export type ReviewPrepareDecision =
  | { readonly skip: true; readonly reason: string }
  | { readonly skip: false };

/**
 * 作業項目がまだ`reviewing`状態の`pr_review`のときだけ処理を進める。
 * それ以外(`poll_issues`のreconcileが取り消した競合や、
 * `flow_job_id`の配線の誤り)は飛ばし、ここでは再試行しない。
 */
export function decideReviewPrepare(
  workItem: Pick<WorkItem, "kind" | "status">,
): ReviewPrepareDecision {
  if (workItem.kind !== "pr_review") {
    return {
      skip: true,
      reason: `work item kind is "${workItem.kind}", not "pr_review"`,
    };
  }
  if (workItem.status !== "reviewing") {
    return {
      skip: true,
      reason: `work item status is "${workItem.status}", not "reviewing"`,
    };
  }
  return { skip: false };
}

// ---------------------------------------------------------------------------
// pr_review_generate: diffを切り詰めたことの注記(純粋関数)
// ---------------------------------------------------------------------------

export type PrDiffLike = {
  readonly diff: string;
  readonly truncated: boolean;
  readonly totalLines: number;
};

/**
 * `github.ts`の`getPrDiff`が`config.diff_max_lines`でdiffを切り詰めたとき、
 * `reviewPrompt`に渡すdiffの末尾に、切り詰めたことの注記を足す。
 * 残りの部分は、別に渡す変更ファイルの一覧からClaudeが`Read`できる。
 * 注記は、切り詰めたことを本文の中で明示するためのもの。
 * `Read`で読むファイルは、差分と違って制御文字の置き換えを通らないので、
 * 見えない文字と制御文字を自分で探して指摘するよう、固定の文で促す。
 */
export function buildReviewDiffText(prDiff: PrDiffLike): string {
  if (!prDiff.truncated) {
    return prDiff.diff;
  }
  return `${prDiff.diff}\n\n[diff truncated: showing a prefix of ${prDiff.totalLines} total diff lines. See the changed files list below and use Read to inspect the rest. Files read with Read are not escaped, so look for invisible and control characters in them and report them.]`;
}

// ---------------------------------------------------------------------------
// pr_review_generate: Claudeの構造化出力の型ガード(純粋関数)
// ---------------------------------------------------------------------------

const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "approve",
  "comment",
  "request_changes",
];
const REVIEW_SEVERITIES: readonly ReviewSeverity[] = [
  "blocker",
  "major",
  "minor",
  "nit",
];
const REVIEW_FINDING_KINDS: readonly ReviewFindingKind[] = [
  "must",
  "imo",
  "nits",
  "q",
];

export type ReviewClaudeOutput = {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: ReviewFinding[];
};

function isReviewFindingShape(value: unknown): value is ReviewFinding {
  if (!isRecord(value)) return false;
  if (!isString(value.path)) return false;
  if (value.line !== null && !isNumber(value.line)) return false;
  if (value.end_line !== null && !isNumber(value.end_line)) return false;
  if (!isOneOf(value.severity, REVIEW_SEVERITIES)) return false;
  if (!isOneOf(value.kind, REVIEW_FINDING_KINDS)) return false;
  if (!isString(value.message)) return false;
  if (value.suggestion !== null && !isString(value.suggestion)) return false;
  if (value.suggested_code !== null && !isString(value.suggested_code)) {
    return false;
  }
  return true;
}

/**
 * `prompts.ts`の`REVIEW_SCHEMA`と完全に一致する形かを判定する。
 * 基準にするのは`claude -p --json-schema`に実際に渡すこのスキーマで、
 * `.claude/skills/factory-review`のJSONスキーマの節ではない。
 */
export function isReviewClaudeOutput(
  value: unknown,
): value is ReviewClaudeOutput {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.verdict, REVIEW_VERDICTS)) return false;
  if (!isString(value.summary)) return false;
  if (!Array.isArray(value.findings)) return false;
  return value.findings.every(isReviewFindingShape);
}

// ---------------------------------------------------------------------------
// pr_review_post: 指摘からインラインのレビューコメントへの変換(純粋関数)
// ---------------------------------------------------------------------------

export type ReviewCommentLike = {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly start_line?: number;
  readonly body: string;
};

/**
 * 指摘をGitHubのインラインのレビューコメントに変換する。
 * 次の指摘は除く。`path`がPRの変更ファイルに無いもの(diffの外のパスへの
 * インラインコメントはGitHubが拒否する)と、`line`でコメントの位置を
 * 決められないもの(`null`か0以下)。
 * 除いた指摘は、件数だけでなく指摘そのものも返す。
 * 黙って捨てずに、まとめのコメントに載せるため。
 *
 * `end_line`が別の行を指す指摘は、範囲に固定したコメント
 * (`lib/github.ts`の`ReviewComment.start_line`)にする。
 * GitHubのReview APIは`start_line`を最初の行、`line`を最後の行として受け取るので、
 * `start_line = finding.line`、`line = finding.end_line`とする。
 * `end_line`が`line`より前だと範囲として不正で、GitHubがレビュー全体を拒否するため、
 * その場合は1行のコメントとして扱う。
 * Claudeの`end_line`は信頼できない入力の影響を受ける出力で、
 * 正しい形だと仮定できない。
 */
export function mapFindingsToReviewComments(
  findings: readonly ReviewFinding[],
  prFiles: readonly string[],
): {
  readonly comments: ReviewCommentLike[];
  readonly droppedFindings: ReviewFinding[];
} {
  const fileSet = new Set(prFiles);
  const comments: ReviewCommentLike[] = [];
  const droppedFindings: ReviewFinding[] = [];
  for (const finding of findings) {
    if (
      finding.line === null ||
      finding.line <= 0 ||
      !fileSet.has(finding.path)
    ) {
      droppedFindings.push(finding);
      continue;
    }
    const endLine = finding.end_line;
    const range =
      endLine !== null && endLine > finding.line
        ? { start_line: finding.line, line: endLine }
        : { line: finding.line };
    comments.push({
      path: finding.path,
      side: "RIGHT",
      ...range,
      body: renderInlineComment(finding),
    });
  }
  return { comments, droppedFindings };
}

const REVIEW_FINDING_KIND_PREFIXES: Record<ReviewFindingKind, string> = {
  must: "[MUST]",
  imo: "[IMO]",
  nits: "[NITS]",
  q: "[Q]",
};

/**
 * `suggested_code`のブロックを囲むフェンスを返す。
 * 長さは3と、`code`に含まれる最長の連続バッククォートより1つ長い数の、大きい方。
 * 固定の` ```suggestion `のフェンスでは、提案コード自体が3つ以上の
 * 連続バッククォートを含むとき(Markdownのフェンスを編集する提案など)、
 * フェンスが途中で閉じたり入れ子が崩れたりする。
 * GitHubは3以上ならどの長さのフェンスでも提案を同じように表示するので、
 * フェンスを長くしても普通の提案コードの表示は変わらない。
 */
export function fenceFor(code: string): string {
  const backtickRuns = code.match(/`+/g);
  const longestRun =
    backtickRuns === null
      ? 0
      : Math.max(...backtickRuns.map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * `code`を` ```suggestion `のブロックとして描画する。
 * フェンスは`fenceFor`で決めるので、`code`がどんな連続バッククォートを含んでも崩れない。
 */
function renderSuggestionBlock(code: string): string {
  const fence = fenceFor(code);
  return `\n\n${fence}suggestion\n${code}\n${fence}`;
}

/**
 * レビューの出力のうちPRに載る文章(指摘の`message`と`suggestion`)を、
 * `factory-writing`スキルの規則で検査する。規則に反していても投稿は止めない。
 * レビューを作り直すと費用が倍になるので、呼び出し側は問題をログに残すだけにする。
 * `summary`はGitHubに投稿しない(総評は固定の文面)ので検査しない。
 */
export function reviewOutputProseIssues(output: ReviewClaudeOutput): string[] {
  return checkProseFields(
    output.findings.flatMap((finding, index) => [
      {
        label: `findings[${index}].message`,
        text: finding.message,
        rules: GITHUB_PROSE_RULES,
      },
      ...(finding.suggestion === null
        ? []
        : [
            {
              label: `findings[${index}].suggestion`,
              text: finding.suggestion,
              rules: GITHUB_PROSE_RULES,
            },
          ]),
    ]),
  );
}

/**
 * pr_fixの返信、Issue化の提案、コミットメッセージを、`factory-writing`スキルの規則で検査する。
 * 規則に反していてもpushと返信は止めない。修正をやり直すと費用が倍になるので、
 * 呼び出し側は問題をログに残すだけにする。
 */
export function fixOutputProseIssues(
  replies: readonly FixReply[],
  commitSubject: string,
  commitBody: string | null,
): string[] {
  return checkProseFields([
    ...replies.flatMap((reply, index) => [
      {
        label: `replies[${index}].body`,
        text: reply.body,
        rules: GITHUB_PROSE_RULES,
      },
      ...(reply.issue_proposal === null || reply.issue_proposal === undefined
        ? []
        : [
            {
              label: `replies[${index}].issue_proposal.title`,
              text: reply.issue_proposal.title,
              rules: GITHUB_PROSE_RULES,
            },
            {
              label: `replies[${index}].issue_proposal.body`,
              text: reply.issue_proposal.body,
              rules: GITHUB_PROSE_RULES,
            },
          ]),
    ]),
    {
      label: "commit_subject",
      text: commitSubject,
      rules: COMMIT_MESSAGE_RULES,
    },
    {
      label: "commit_body",
      text: commitBody ?? "",
      rules: COMMIT_MESSAGE_RULES,
    },
  ]);
}

/**
 * 1件の指摘を、factory-reviewスキルの投稿形式に沿ったインラインコメントの本文にする。
 * 1行目は`pr_review`の投稿と分かる役割タグ、2行目は`kind`に応じた
 * `[MUST]` / `[IMO]` / `[NITS]` / `[Q]`の接頭辞と`message`。
 * 続けて、あれば`suggestion`の注記と、`suggested_code`の` ```suggestion `ブロックを置く。
 * 複数行の指摘は`mapFindingsToReviewComments`が`start_line` / `line`を
 * 指摘の`line` / `end_line`に合わせるので、ブロックは常にGitHubが表示する範囲に
 * 適用される。本文に範囲の注記は要らない。
 * `message`と`suggestion`は`normalizeJapaneseText`を通す。
 * `suggested_code`は文章ではなくコードなので変更しない。
 */
export function renderInlineComment(finding: ReviewFinding): string {
  const prefix = REVIEW_FINDING_KIND_PREFIXES[finding.kind];
  const message = normalizeJapaneseText(finding.message);
  const suggestionText =
    finding.suggestion !== null
      ? `\n\n提案: ${normalizeJapaneseText(finding.suggestion)}`
      : "";
  const codeBlock =
    finding.suggested_code === null
      ? ""
      : renderSuggestionBlock(finding.suggested_code);
  return `${ROLE_TAGS.pr_review}\n${prefix} ${message}${suggestionText}${codeBlock}`;
}

/**
 * `renderReviewSummary`が描画する、レビュー本体のコメントの5つの固定形式。
 * レビューの本文には、Claudeが自由に書いた`summary`を使わず、
 * 必ずこの5つのどれかにする。
 * `hasPriorReview`(`db.ts`の`hasPriorReview`)で、
 * このPRの再レビューか最初のレビューかを区別する。
 * `"rereview_open"`は`"rereview_clean"`の対になる形式で、このラウンドでは
 * 新しい指摘が無いが、このラウンドでスレッドを解決した後も前のラウンドの
 * `[MUST]`の指摘が1件以上残っているときに使う。
 * そのときにLGTMだけの本文にすると、必須の指摘が残っているのに
 * 「もう対応は要らない」と読めてしまうため。
 * `"rereview_unverified"`も同じ理由の形式で、未解決のスレッドの一覧を読めず、
 * 残りがあるか分からないときに使う。LGTMとは書かず、確認を求める。
 */
export type ReviewBodyMode =
  | "findings"
  | "rereview_clean"
  | "first_clean"
  | "rereview_open"
  | "rereview_unverified";

/**
 * 本文の形式を、次の情報だけから選ぶ。このラウンドでインラインに投稿した指摘か
 * 除いた指摘があるか、このPRにFactoryのレビューがすでにあるか、
 * このラウンドの解決処理の後もFactory自身の`[MUST]`のスレッドがいくつ残るか
 * (`openMustCount`。呼び出し側が、解決前のスレッド一覧から解決予定のidを除いて
 * `countOpenMustThreads`で数える。スレッドの一覧を読めなかったときは`null`)。
 * 除いた指摘(`path`がdiffに無いなどでインラインに投稿できなかったもの)があれば、
 * `postedCommentCount`が0でも`"findings"`にする。
 * `renderReviewSummary`は固定の2行目の下に除いた指摘を必ず並べるので、
 * その一覧の直上にLGTMの行を出さないため。
 * それ以外で未解決の`must`が残っていれば(`openMustCount > 0`)、指摘の無い形式
 * (`"rereview_clean"`、理屈の上では`"first_clean"`も)の代わりに`"rereview_open"`にする。
 * ただし、PRの最初のレビューに前の未解決スレッドがあることはない。
 * `openMustCount`が`null`で、投稿する指摘も無いときは、残りの有無が分からないので
 * `"rereview_unverified"`にする。
 */
export function decideReviewBodyMode(
  postedCommentCount: number,
  droppedCount: number,
  hasPriorReview: boolean,
  openMustCount: number | null,
): ReviewBodyMode {
  if (postedCommentCount + droppedCount > 0) return "findings";
  if (openMustCount === null) return "rereview_unverified";
  if (openMustCount > 0) return "rereview_open";
  return hasPriorReview ? "rereview_clean" : "first_clean";
}

/**
 * factory-reviewスキルの投稿形式に沿って、レビュー本体のコメントの本文を組み立てる。
 * 1行目は`pr_review`の投稿と分かる役割タグと`@author`へのメンション、
 * 2行目は`mode`で選ぶ5つの固定の文、インラインに投稿できなかった指摘があれば
 * その箇条書きを続ける。
 * 箇条書きの`path`は改行を空白にまとめて1行にし、`path`と`message`の`<!--`は
 * `neutralizeHtmlComment`で無害にする。どちらもClaudeの出力で、
 * 本文の末尾の目印を偽ったり隠したりさせないため。
 * Claudeの`summary`はここに載せない(`factory.reviews`への記録とDiscordだけに使う)。
 * `verdict`も同じく載せない(DBとDiscordだけで、PRの本文には出さない)。
 * `<!-- factory:pr_review:<id> -->`とレビューしたshaの印は、呼び出し側が`withReviewMarkers`で足す。
 *
 * `binaryFiles`か`binaryUnlistedCount`が1件以上あるときは、モードによらず、固定の一文とパスの一覧を足す
 * (`renderBinaryFilesLines`)。差分に内容が出ないファイルを、Claudeの出力に頼らず、
 * 読まれていない可能性のあるものとして、投稿に必ず残すため。
 * 指摘の無い2つの形式は、そのとき「LGTMです」を言わず、差分に指摘が無いことだけを書く。
 * 読めていないファイルが残るのに、LGTMと読める行を出さないため。
 *
 * `"findings"`には「最終的なApproveは人が判断する」という免責の行を付けない。
 * 指摘のある投稿はすでに作成者に確認を求めている(「確認お願いします。」)ので、
 * 免責は重複になる。
 * 直すものが無い`"rereview_clean"`と`"first_clean"`は、3行目に免責を付ける。
 * LGTMの形の投稿こそ、人が「もう何もしなくてよい」と読みかねないため。
 * `"rereview_open"`は`openMustCount`で残っている`[MUST]`の件数を伝える。
 * これもすでに確認を求めているので、免責を付けない。
 * ここの文字列はすべて、英数字と日本語の間に半角スペースを入れない規約に従う
 * (`docs/coding-guidelines.md`)。
 */
export function renderReviewSummary(
  authorLogin: string,
  postedCommentCount: number,
  mode: ReviewBodyMode,
  droppedFindings: readonly ReviewFinding[],
  openMustCount: number | null,
  binaryFiles: readonly string[] = [],
  binaryUnlistedCount = 0,
): string {
  const lines = [`${ROLE_TAGS.pr_review} @${authorLogin}`];
  const hasBinary = binaryFiles.length + binaryUnlistedCount > 0;
  switch (mode) {
    case "findings":
      lines.push(
        `${String(postedCommentCount)}件コメントしました。確認お願いします。`,
      );
      break;
    case "rereview_clean":
      lines.push(
        hasBinary ? "修正を確認しました。" : "修正を確認しました。LGTMです。",
      );
      lines.push("最終的なApprove判断は人が行ってください。");
      break;
    case "first_clean":
      lines.push(
        hasBinary ? "差分に指摘はありません。" : "指摘はありません。LGTMです。",
      );
      lines.push("最終的なApprove判断は人が行ってください。");
      break;
    case "rereview_open":
      lines.push(
        `新しい指摘はありません。未対応の指摘が${String(openMustCount)}件残っています。確認お願いします。`,
      );
      break;
    case "rereview_unverified":
      lines.push(
        "新しい指摘はありません。未解決の指摘を読み取れなかったため、残りがあるかは確認できていません。確認お願いします。",
      );
      break;
  }
  lines.push(...renderBinaryFilesLines(binaryFiles, binaryUnlistedCount));
  lines.push(...renderUnanchoredFindingLines(droppedFindings));
  return lines.join("\n");
}

/**
 * 差分に内容が出ないバイナリのファイルの固定の一文と、パスの箇条書き。無ければ空。
 * 先頭に空行を置き、直前の行(LGTMや免責の行)と続けて読まれないようにする。
 * パスは、改行を空白にまとめ、200文字で切り、`<!--`を無害にしてから、コードスパンで囲む(`pathCodeSpan`)。
 * 上限を超えた分は「ほかN件」と書く。
 * `unlistedCount`は、パスを変更ファイルと照合できず並べなかった件数で、件数と注記にだけ加える。
 */
function renderBinaryFilesLines(
  binaryFiles: readonly string[],
  unlistedCount: number,
): string[] {
  const total = binaryFiles.length + unlistedCount;
  if (total === 0) return [];
  const shown = binaryFiles.slice(0, BINARY_LIST_MAX_FILES);
  const rest = binaryFiles.length - shown.length;
  return [
    "",
    `内容を差分で読めないバイナリのファイルが${String(total)}件あります。人が内容を確認してください。`,
    ...shown.map((path) => `- ${pathCodeSpan(path)}`),
    ...(rest > 0 ? [`(ほか${String(rest)}件)`] : []),
    ...(unlistedCount > 0
      ? [`(パスを確認できなかったものが${String(unlistedCount)}件あります)`]
      : []),
  ];
}

/** 総評に並べる`path`の最大の文字数(コードポイント)。超えた分は「…」にする。 */
const PATH_MAX_CHARS = 200;

/**
 * 総評に並べる`path`の文字列。改行は空白にまとめ、200文字で切り(切ったら末尾に「…」)、
 * `<!--`は無害にする。長いパスで総評が埋まらないようにし、目印の偽造も防ぐ。
 */
function oneLinePath(path: string): string {
  const oneLine = path.replace(/\s*[\r\n]+\s*/g, " ");
  const chars = Array.from(oneLine);
  const cut =
    chars.length > PATH_MAX_CHARS
      ? `${chars.slice(0, PATH_MAX_CHARS).join("")}…`
      : oneLine;
  return neutralizeHtmlComment(cut);
}

/**
 * `text`をコードスパンで囲む。`@`のメンションやリンクとして描画させないため。
 * 中のバッククォートの最長の連なりより長いフェンスで囲み、
 * 先頭か末尾がバッククォートなら、フェンスと混ざらないよう空白を挟む。
 */
function codeSpan(text: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** 総評に並べる`path`を、整えてコードスパンで囲んだ文字列。 */
function pathCodeSpan(path: string): string {
  return codeSpan(oneLinePath(path));
}

/** 指摘の位置。範囲の指摘は`path:line-end_line`、1行の指摘は`path:line`、行が無ければ`path`だけ。 */
function findingLocation(finding: ReviewFinding): string {
  const path = oneLinePath(finding.path);
  if (finding.line === null) return codeSpan(path);
  const end =
    finding.end_line !== null && finding.end_line > finding.line
      ? `-${String(finding.end_line)}`
      : "";
  return codeSpan(`${path}:${String(finding.line)}${end}`);
}

/**
 * 行に紐づけられなかった指摘の見出しと箇条書き。指摘が無ければ空。
 * `commented`の指摘は、行コメントにするはずだったもので、位置(`path:line`)を添える。
 */
function renderUnanchoredFindingLines(
  findings: readonly ReviewFinding[],
  commented: readonly ReviewFinding[] = [],
): string[] {
  if (findings.length + commented.length === 0) return [];
  const lines = ["", "(行に紐づけられなかった指摘)"];
  for (const finding of [...commented, ...findings]) {
    const prefix = REVIEW_FINDING_KIND_PREFIXES[finding.kind];
    const location = commented.includes(finding)
      ? findingLocation(finding)
      : pathCodeSpan(finding.path);
    const message = neutralizeHtmlComment(
      normalizeJapaneseText(finding.message),
    );
    lines.push(`- ${prefix} ${location}: ${message}`);
  }
  return lines;
}

/**
 * GitHubが行コメントの行を解決できず、レビューを拒否したときの総評を組み立てる。
 * 行コメントにするはずだった指摘(`commentedFindings`)は、位置を添えて、行に紐づけられなかった指摘(`droppedFindings`)と
 * 同じ一覧に並べる。後者の形は通常の総評と同じにする。
 * 「N件コメントしました」は、行コメントを1件も付けていないので書かない。
 * `binaryFiles`があれば、`renderReviewSummary`と同じ固定の一文とパスの一覧を足す。
 */
export function renderUnresolvedLineSummary(
  authorLogin: string,
  commentedFindings: readonly ReviewFinding[],
  droppedFindings: readonly ReviewFinding[],
  binaryFiles: readonly string[] = [],
  binaryUnlistedCount = 0,
): string {
  return [
    `${ROLE_TAGS.pr_review} @${authorLogin}`,
    "GitHubが行を解決できなかったため、行コメントにする指摘を総評に移しました。",
    "確認お願いします。",
    ...renderBinaryFilesLines(binaryFiles, binaryUnlistedCount),
    ...renderUnanchoredFindingLines(droppedFindings, commentedFindings),
  ].join("\n");
}

/**
 * 行コメントになった指摘を返す。`findings`のうち、行に紐づけられず総評に回った`droppedFindings`
 * (`mapFindingsToReviewComments`の戻り値)に含まれないものを、元の順で返す。
 * 行コメントになった指摘と総評に回った指摘の和は、元の指摘と一致する。
 */
export function commentedFindingsOf(
  findings: readonly ReviewFinding[],
  droppedFindings: readonly ReviewFinding[],
): ReviewFinding[] {
  return findings.filter((finding) => !droppedFindings.includes(finding));
}

/**
 * HTMLのコメントの開始`<!--`を`&lt;!--`に置き換える。
 * 総評に載せるClaudeの出力が、目印に見える行を差し込んだり、
 * 閉じないコメントで後ろの目印を表示から隠したりしないようにする。
 * 通常の文中ではGitHubは`&lt;!--`を`<!--`と表示する。
 * ただしコードスパンやコードブロックの中では`&lt;!--`がそのまま表示される。
 * 対象は行に紐づけられなかった指摘の箇条書きだけで、見た目が崩れるだけなので許容する。
 */
function neutralizeHtmlComment(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

/**
 * `body`が、それだけで対応を完了させる`pr_fix`の返信(`renderFixReply`)かを返す。
 * 条件は、1行目が`pr_fix`の役割タグで、いずれかの行が
 * `対応: \`<sha>\``(バッククォートで囲んだ7〜40桁の16進数)の形であること。
 * この形は、実際にコミットを作った`"fixed"`の返信だけが持つ。
 * `対応: 見送り`(Claudeが対応しないと判断した)と`対応: 変更なし`(結果として
 * 何もコミットされなかった)は該当しない。
 * この2つはまだ人の判断が要るので、スレッドを開いたままにする。
 */
export function isFixedFixReply(body: string): boolean {
  const lines = body.split("\n");
  if (lines[0] !== ROLE_TAGS.pr_fix) return false;
  return lines.some((line) => /^対応: `[0-9a-f]{7,40}`$/.test(line));
}

/**
 * `pr_review_post.ts`がこの投稿で解決するレビュースレッドを選ぶ。
 * 対象は、このPRにあるFactory自身の未解決の`pr_review`のインラインコメントのスレッド。
 * スレッドの最初のコメントが`viewer`の投稿(大文字小文字を区別しない。
 * `isOwnPost`と同じ扱い)で、かつ`pr_review`の役割タグで始まること。
 * これは`isFactoryPost`の「loginが一致し、かつ印がある」規則に合わせている。
 * Factoryは運用者自身のGitHubアカウントで動くので、loginだけでは
 * Factoryのスレッドと人のスレッドを見分けられない。
 * GitHubがすでに解決済みにしたスレッドには触れない。人が始めたスレッドは、
 * 後でFactoryが返信していても触れない。解決するのはFactory自身が始めたスレッドに限る。
 *
 * スレッドの最後のコメントもFactory自身(`viewer`)の投稿である必要がある。
 * Factoryの指摘の後でも人の返信が残っていれば、最後に発言したのはFactoryではないので、
 * 人が実際に解決できるよう開いたままにする。
 *
 * `mode`で、`viewer`の最後のコメントのうちどれを「対応済み」とみなすかを決める。
 * `pr_review_post.ts`は`openMustCount`を反映する前の形式を渡すので
 * (理由は`countOpenMustThreads`のコメントを参照)、実際には`"findings"`、
 * `"rereview_clean"`、`"first_clean"`のどれかで、`"rereview_open"`にはならない。
 *   - `"rereview_clean"`(再レビューで指摘ゼロ)と、念のため同じ規則を使う
 *     `"rereview_open"`: 手つかずの`pr_review`の指摘(人が手で直したなど、
 *     もう直すものが無い)か、コミットを示す`pr_fix`の返信(`isFixedFixReply`)。
 *   - `"findings"`(指摘が残る再レビューか、最初のレビュー): コミットを示す
 *     `pr_fix`の返信だけ。この投稿で新しい指摘を残したばかりかもしれず、
 *     古い指摘はpr_fix自身の確認でしか閉じないので、手つかずの指摘は開いたままにする。
 *   - `"first_clean"`(最初のレビューで指摘ゼロ): 何も解決しない。
 *     運用者が対応しうる前のFactoryのレビューが存在しないため。
 */
export function selectThreadsToResolve(
  threads: readonly ReviewThread[],
  viewer: string,
  mode: ReviewBodyMode,
): string[] {
  if (mode === "first_clean") return [];
  const viewerLower = viewer.toLowerCase();
  return threads
    .filter((thread) => !thread.isResolved)
    .filter(
      (thread) => thread.firstCommentAuthorLogin.toLowerCase() === viewerLower,
    )
    .filter((thread) => thread.firstCommentBody.startsWith(ROLE_TAGS.pr_review))
    .filter(
      (thread) => thread.lastCommentAuthorLogin.toLowerCase() === viewerLower,
    )
    .filter((thread) =>
      mode === "rereview_clean" || mode === "rereview_open"
        ? thread.lastCommentBody.startsWith(ROLE_TAGS.pr_review) ||
          isFixedFixReply(thread.lastCommentBody)
        : isFixedFixReply(thread.lastCommentBody),
    )
    .map((thread) => thread.id);
}

/**
 * このPRにあるFactory自身の`pr_review`の指摘のうち、未解決の`[MUST]`を数える。
 * `pr_review_post.ts`が、新しい指摘を投稿しないラウンドでLGTMだけの本文にせず
 * `"rereview_open"`にするかを決めるのに使う(`decideReviewBodyMode`の`openMustCount`)。
 * Factoryの投稿かどうかは、`selectThreadsToResolve`と同じく最初のコメントで判定する
 * (loginが大文字小文字を区別せず一致し、`pr_review`の役割タグで始まる)。
 * GitHubがすでに解決済みにしたスレッドと、このラウンドで解決する予定のスレッド
 * (`resolvedIds`。`selectThreadsToResolve`が、ここに渡すのと同じ解決前の`threads`から
 * 求めた戻り値)は数えない。
 * さらに、最初のコメントの2行目(`renderInlineComment`の形式での種別の接頭辞)が
 * `[MUST]`(`REVIEW_FINDING_KIND_PREFIXES.must`)であることを求める。
 * `[IMO]` / `[NITS]` / `[Q]`の指摘は、指摘の無い再レビューの本文を妨げない。
 */
export function countOpenMustThreads(
  threads: readonly ReviewThread[],
  viewer: string,
  resolvedIds: readonly string[],
): number {
  const viewerLower = viewer.toLowerCase();
  const resolvedIdSet = new Set(resolvedIds);
  return threads.filter((thread) => {
    if (thread.isResolved) return false;
    if (resolvedIdSet.has(thread.id)) return false;
    if (thread.firstCommentAuthorLogin.toLowerCase() !== viewerLower) {
      return false;
    }
    if (!thread.firstCommentBody.startsWith(ROLE_TAGS.pr_review)) return false;
    const secondLine = thread.firstCommentBody.split("\n")[1] ?? "";
    return secondLine.startsWith(REVIEW_FINDING_KIND_PREFIXES.must);
  }).length;
}

export type OpenFindingForPrompt = {
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

/**
 * このPRにあるFactory自身の未解決の`pr_review`の指摘を、
 * `reviewPrompt`の`openFindings`の入力に変換する。
 * 再レビューで、未解決の指摘と実質的に同じ指摘を重ねて投稿させないために、
 * `pr_review_generate.ts`がこれらをすべてClaudeに渡す。
 * Factoryの投稿かどうかは`selectThreadsToResolve`と同じく判定する
 * (loginが大文字小文字を区別せず一致し、最初のコメントが`pr_review`の役割タグで始まる)。
 * ただし`mode`や最後のコメントの状態には関係しない。
 * ここで気にするのは指摘自体が未解決かどうかで、その後に誰が返信したかではない。
 * `body`からは役割タグの行を取り除く。Factoryの投稿の付け方をClaudeが知る必要は無いため。
 * 最初のレビューではスレッドがまだ無いので空になる。
 */
export function openFindingsForPrompt(
  threads: readonly ReviewThread[],
  viewer: string,
): OpenFindingForPrompt[] {
  const viewerLower = viewer.toLowerCase();
  return threads
    .filter((thread) => !thread.isResolved)
    .filter(
      (thread) => thread.firstCommentAuthorLogin.toLowerCase() === viewerLower,
    )
    .filter((thread) => thread.firstCommentBody.startsWith(ROLE_TAGS.pr_review))
    .map((thread) => ({
      path: thread.path,
      line: thread.line,
      body: stripRoleTagLine(thread.firstCommentBody),
    }));
}

/**
 * Factoryの投稿の本文から、1行目にある`pr_review`の役割タグの行を取り除く(あれば)。
 * Claudeに指摘の中身だけを見せるため、`openFindingsForPrompt`が使う。
 */
function stripRoleTagLine(body: string): string {
  const newlineIndex = body.indexOf("\n");
  if (newlineIndex === -1) return body;
  if (body.slice(0, newlineIndex) !== ROLE_TAGS.pr_review) return body;
  return body.slice(newlineIndex + 1);
}

/**
 * レビュー本文に入れる、レビューしたcommitのshaの目印の行。
 * GitHubのレビューの`commit_id`は投稿した時点のPRのheadで、
 * レビューしたshaと一致するとは限らないため、本文に残す。
 * `factory:`ではなく`factory-review-sha:`で始めるのは、shaがすべて数字のときに
 * `github.ts`の`hasMarker`が読むFactoryの目印の形にならないようにするため。
 */
function reviewShaMarkerLine(reviewSha: string): string {
  return `<!-- factory-review-sha:${reviewSha} -->`;
}

/**
 * レビューの本文に、レビューしたshaの目印と`<!-- factory:pr_review:<id> -->`の目印を足す。
 * shaの目印は`pr_review`の目印の前に置き、`pr_review`の目印が本文の最後の行であることを保つ。
 * pr_fixの指摘の収集やFactory自身の投稿の判定は、最後の行の目印だけを読むので、
 * shaの目印を足しても読み方は変わらない。
 */
export function withReviewMarkers(
  body: string,
  workItemId: number,
  reviewSha: string,
): string {
  return withMarker(
    "pr_review",
    workItemId,
    `${body}\n\n${reviewShaMarkerLine(reviewSha)}`,
  );
}

/** `findPostedReviewId`が見るレビューの項目。 */
export type PostedReviewCandidate = Pick<
  PrReview,
  "id" | "authorLogin" | "body"
>;

/**
 * この作業項目が`reviewSha`に対して投稿済みのレビューを探し、最初に見つかったもののidを返す。
 * 無ければnullを返す。
 * 投稿者が`viewer`で(大文字小文字を区別しない)、本文が`withReviewMarkers`の足す
 * 2つの目印(`reviewSha`の目印と、この作業項目の`pr_review`の目印)でこの順に終わるものを
 * 投稿済みとみなす。末尾の空白は無視し、改行のCRLFはLFとして比べる。
 * 目印は誰でも本文に貼り付けられるので、投稿者も確かめる。
 * 目印の位置まで確かめるのは、本文の途中に貼られたshaの目印に一致させないため。
 * shaの目印の無いレビューは、どのshaに対するものか分からないので一致させない。
 */
export function findPostedReviewId(
  reviews: readonly PostedReviewCandidate[],
  viewer: string,
  workItemId: number,
  reviewSha: string,
): number | null {
  const trailer = withReviewMarkers("", workItemId, reviewSha);
  const found = reviews.find(
    (review) =>
      isOwnPost(review.authorLogin, viewer) &&
      review.body.replace(/\r\n/g, "\n").replace(/\s+$/, "").endsWith(trailer),
  );
  return found === undefined ? null : found.id;
}

// ---------------------------------------------------------------------------
// pr_fix_prepare: 関門の結果(純粋関数)
// ---------------------------------------------------------------------------

/**
 * `pr_fix_prepare.ts`の結果の判別子。
 * `"proceed"`なら後続のステップ(collect、apply、verify)を実行する。
 * 残りは終端で、`pr_fix_finish.ts`に直接進む。
 * これらは`PrFixFinishOutcome`の値でもある(下の`decideFixFinishAction`を参照)。
 * `conflict_up_to_date`と`conflict_blocked`は競合回だけが返す。
 */
export type PrFixGateOutcome =
  | "proceed"
  | "skip"
  | "guard_blocked"
  | "round_exhausted"
  | "conflict_up_to_date"
  | "conflict_blocked";

// ---------------------------------------------------------------------------
// pr_fix_prepare: 安全のための関門(純粋関数)。
// 方針は`docs/security.md`の「PR修正の安全策」を参照。
// ---------------------------------------------------------------------------

export type PrFixGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * PRのheadがbaseと同じリポジトリにあるかを判定する。
 * forkのPRと、headのリポジトリを取得できないPR(forkの削除など)は通さない。
 * forkの内容は第三者が書いたもので、レビューにもpushにも信頼して渡せないためである。
 * レビューを始める判定(`poll_prs`)と、レビューと修正の準備のステップで同じ判定を使う。
 */
export function evaluateSameRepoHeadGuard(
  headRepoFullName: string | null,
  baseRepoFullName: string,
): PrFixGuardResult {
  if (headRepoFullName === null || headRepoFullName !== baseRepoFullName) {
    return {
      ok: false,
      reason: "head repository differs from base repository (fork PR)",
    };
  }
  return { ok: true };
}

/**
 * draw.ioのビューアの固定を上げるPRのブランチ(`isViewerBumpBranch`が真の名前)は、修正を始めない。
 * このPRは保護パスを変える。修正を許すと、固定のファイル以外も書き換えたcommitを、
 * 人が気づかずにマージするおそれがある。直すときは、人が行う。
 * 修正を始める判定(`poll_prs`)と、修正の準備のステップで同じ判定を使う。
 */
export function evaluateHumanOnlyBranchGuard(
  headRef: string,
): PrFixGuardResult {
  if (isViewerBumpBranch(headRef)) {
    return {
      ok: false,
      reason: `the branch ${headRef} is fixed by a person only (draw.io viewer pin update)`,
    };
  }
  return { ok: true };
}

export type PrFixSafetyGuardInput = {
  readonly open: boolean;
  readonly headRepoFullName: string | null;
  readonly baseRepoFullName: string;
  readonly draft: boolean;
  readonly autoMergeEnabled: boolean;
  /** 読まなかったときは`null`。openで同一リポジトリのdraftでないPRに`null`が来たら止める。 */
  readonly headBranch: PrFixHeadBranchState | null;
};

export type PrFixHeadBranchState = {
  /** branches APIの`protected`。 */
  readonly headProtected: boolean;
  /** headブランチに効くrulesetの規則が1件以上ある。globで対象を指定したrulesetも含む。 */
  readonly headHasRules: boolean;
  readonly headIsDefaultBranch: boolean;
};

/**
 * headブランチの状態を読む対象のPRかを判定する。
 * forkや閉じたPRのheadはこのリポジトリに無いことがあり、読むと失敗する。
 * draftは次の関門が先に止めるので、読まずに理由をそのまま残す。
 */
export function shouldReadPrFixHeadState(
  open: boolean,
  draft: boolean,
  headRepoFullName: string | null,
  baseRepoFullName: string,
): boolean {
  return (
    open &&
    !draft &&
    evaluateSameRepoHeadGuard(headRepoFullName, baseRepoFullName).ok
  );
}

/**
 * PRのheadブランチが保護ブランチか、リポジトリのデフォルトブランチかを読む。
 * pr_fixがpushするのはheadブランチなので、baseの保護は見ない。
 * mainを保護するruleset(対象は既定のブランチ)は`protected: true`として返ることを確かめた。
 * globで対象を指定するrulesetなどが`protected`に反映されるかは確かめていないので、
 * ブランチに効くrulesetの規則も別に読み、1件でもあれば止める。
 * 呼び出し側は、`shouldReadPrFixHeadState`が真のPRにだけ使う。
 * 読めなければ例外を投げる。
 */
export async function fetchPrFixHeadBranchState(
  client: GhClient,
  owner: string,
  repo: string,
  headRef: string,
): Promise<PrFixHeadBranchState> {
  const headProtected = await getBranchProtected(client, owner, repo, headRef);
  const ruleCount = await getBranchRuleCount(client, owner, repo, headRef);
  const defaultBranch = await getDefaultBranch(client, owner, repo);
  return {
    headProtected,
    headHasRules: ruleCount > 0,
    headIsDefaultBranch: headRef === defaultBranch,
  };
}

/**
 * 修正を試みる前の安全のための関門を、open、fork、draft、auto-merge、
 * headの状態、デフォルトブランチ、保護ブランチの順に判定する。
 * PRがopenであること、head.repoとbase.repoが同じであること(forkへpushしない)、
 * draftでないこと、auto-mergeが有効でないこと、
 * headブランチがデフォルトブランチでも保護ブランチでもなく、rulesetのruleも効いていないこと。
 * auto-mergeが有効だと、Factoryの修正pushがレビューを経ずにマージされうる。
 * 読めなければ`fetchPrFixHeadBranchState`が例外を投げるので、`null`は通常は届かない。
 * `null`の分岐は、呼び出し側が読み忘れたときに備える多層防御である。
 * worktreeを作る前、Claudeを実行する前に確かめる。
 * 実際にpushする直前には、`workspace.ts`の`commitAndPush`が
 * headのshaが動いていないことを別に確かめ直す。
 */
export function evaluatePrFixSafetyGuards(
  input: PrFixSafetyGuardInput,
): PrFixGuardResult {
  if (!input.open) {
    return { ok: false, reason: "pull request is not open" };
  }
  const sameRepo = evaluateSameRepoHeadGuard(
    input.headRepoFullName,
    input.baseRepoFullName,
  );
  if (!sameRepo.ok) {
    return sameRepo;
  }
  if (input.draft) {
    return { ok: false, reason: "pull request is a draft" };
  }
  if (input.autoMergeEnabled) {
    return { ok: false, reason: "pull request has auto-merge enabled" };
  }
  // 読み忘れても通さない多層防御。通常は`fetchPrFixHeadBranchState`の例外が先に出る。
  if (input.headBranch === null) {
    return { ok: false, reason: "head branch state is unavailable" };
  }
  // デフォルトブランチは保護されていることが多いので、区別できるように先に判定する。
  if (input.headBranch.headIsDefaultBranch) {
    return { ok: false, reason: "head branch is the default branch" };
  }
  if (input.headBranch.headProtected) {
    return { ok: false, reason: "head branch is protected" };
  }
  // ruleの種類は問わずに止める。止めすぎは安全側で、`protected`に反映されないrulesetを見落とさないため。
  if (input.headBranch.headHasRules) {
    return { ok: false, reason: "head branch has rules" };
  }
  return { ok: true };
}

/**
 * 修正ラウンドの上限(`max_fix_rounds`)を確かめる。
 * CIの失敗か、マージの競合を直す回(`skipsLimit`)は確かめない。その回は`fix_round`を前の値のまま写すので、
 * 指摘修正が上限に達したPRでも、その回が止まってしまうため。
 * CIの回の上限は`pr_ci_fix_max_rounds`が、競合の回の上限は`pr_conflict_fix_max_rounds`が決める。
 */
export function evaluateFixRoundGuard(
  fixRound: number,
  maxFixRounds: number,
  skipsLimit = false,
): PrFixGuardResult {
  if (!skipsLimit && fixRound > maxFixRounds) {
    return {
      ok: false,
      reason: `fix_round ${String(fixRound)} exceeds max_fix_rounds ${String(maxFixRounds)}`,
    };
  }
  return { ok: true };
}

/**
 * 多層防御のための、リポジトリの許可リストの再確認。
 * `poll_prs.ts`は作業項目を作る前に`filterByRepoAllowlist`で候補を絞っているが、
 * 作成後に`factory_config`が編集されたり、行が手で追加されたりすると、
 * 許可されなくなったリポジトリを指す作業項目が残りうる。
 * そのため、そのリポジトリに対するGitHubやworkspaceのI/Oの直前に、
 * ここと`pr_review_prepare.ts`で確かめ直す。
 */
export function evaluateRepoAllowedGuard(allowed: boolean): PrFixGuardResult {
  return allowed
    ? { ok: true }
    : {
        ok: false,
        reason:
          "repository is not allowed by factory_config (owners / repo_allowlist)",
      };
}

/**
 * pr_fixとimplementフローはPRのブランチのworktreeを共有する。
 * 親のIssueの作業項目(`parent_work_item_id`)が再び`implementing`にある間は、
 * 修正の実行がworktreeに触れてはならない。
 * `parentStatus`は、親が無いとき(親の行が消えたときを含む)は`null`。
 */
export function evaluateParentImplementingGuard(
  parentStatus: WorkItemStatus | null,
): PrFixGuardResult {
  return parentStatus === "implementing"
    ? { ok: false, reason: "parent issue is being re-implemented" }
    : { ok: true };
}

/**
 * PRのブランチ名(`factory/issue-<N>-wi-<id>`)から引いた実装の作業項目が実装中なら止める。
 * 親の行(parent_work_item_id)から引いた場合と理由を分けるのは、親の行が無いPRでも止まったことを読み手が見分けられるようにするためである。
 */
export function evaluateBranchImplementingGuard(
  branchItemStatus: WorkItemStatus | null,
): PrFixGuardResult {
  return branchItemStatus === "implementing"
    ? {
        ok: false,
        reason: "implementation of the branch's work item is running",
      }
    : { ok: true };
}

// ---------------------------------------------------------------------------
// flow.yamlのstep timeoutと時間設定の整合(純粋関数)
// ---------------------------------------------------------------------------

/** flow.yamlのpr_fix_applyのtimeout(秒)。変えるときはflow.yamlと同じ変更で変える(tests/scripts/pr_flows.test.tsが一致を確かめる)。 */
export const PR_FIX_APPLY_STEP_TIMEOUT_SEC = 7_200;

/** flow.yamlのpr_fix_verifyのtimeout(秒)。変えるときはflow.yamlと同じ変更で変える(tests/scripts/pr_flows.test.tsが一致を確かめる)。 */
export const PR_FIX_VERIFY_STEP_TIMEOUT_SEC = 21_600;

/** flow.yamlのpr_review_generateのtimeout(秒)。変えるときはflow.yamlと同じ変更で変える(tests/scripts/pr_flows.test.tsが一致を確かめる)。 */
export const PR_REVIEW_GENERATE_STEP_TIMEOUT_SEC = 7_200;

/**
 * Claudeを使うステップのうち、Claudeと検査コマンド以外にかかりうる時間(秒)。
 * GitHub API・git・DBの操作の余裕である。
 * これらのステップはrepoのロックを取らないので、その待ちは含めない。
 */
export const PR_STEP_OVERRUN_BASE_SEC = 600;

/** Claude 1回か検査コマンド1件が、timeoutの後に上乗せしうる停止と出力待ちの時間(秒)。ランナーの最大13秒を切り上げた値。worktreeのロックを待つ時間はコマンドのtimeoutの内側で数えるので含めない。 */
export const PR_COMMAND_STOP_OVERHEAD_SEC = 15;

export const PR_FIX_TIMEOUT_MISFIT_REASON =
  "pr_fix time settings do not fit the flow step timeout";

export const PR_REVIEW_TIMEOUT_MISFIT_REASON =
  "pr_review time settings do not fit the flow step timeout";

/** `claude_timeout_sec`で打ち切るClaudeの1回の実行の上限に、ランナーの停止の上乗せを足した秒数を返す。 */
function perRunSec(claudeTimeoutSec: number): number {
  return claudeTimeoutSec + PR_COMMAND_STOP_OVERHEAD_SEC;
}

/**
 * Claudeを1回だけ実行するステップ(pr_fix_apply、pr_review_generate)の時間設定が、そのstep timeoutに収まらなければ理由を返し、収まればnullを返す。
 * runClaudeは不正な出力の後に1回だけ再試行するので、Claudeは`claude_timeout_sec`まで2回走りうる。
 */
function singleClaudeStepMisfit(
  reasonPrefix: string,
  claudeTimeoutSec: number,
  stepTimeoutSec: number,
): string | null {
  const total = 2 * perRunSec(claudeTimeoutSec) + PR_STEP_OVERRUN_BASE_SEC;
  if (total <= stepTimeoutSec) return null;
  return `${reasonPrefix}: 2 claude runs x (claude_timeout_sec ${String(claudeTimeoutSec)} + ${String(PR_COMMAND_STOP_OVERHEAD_SEC)}) + ${String(PR_STEP_OVERRUN_BASE_SEC)} = ${String(total)}s exceeds ${String(stepTimeoutSec)}s`;
}

/**
 * pr_fixの時間設定が、flow.yamlの修正・検証ステップのtimeoutに収まらなければ理由を返し、収まればnullを返す。
 * 収まらない設定で動かすと、アプリ側のtimeoutより先にWindmillがステップを打ち切り、作業項目は理由の分からない`failed`になるため、準備ステップで止める。
 * 修正ステップはClaude 1回(不正な出力への再試行を含めて2回)で見積もる。
 * 検証ステップは、検査コマンドがあるときだけ、全件の検査を2回とClaude 1回(同じく2回)で見積もる。
 * 検査コマンドもClaudeと同じ`claude_timeout_sec`で打ち切る。
 * 検査コマンドが無ければ、検証ステップは検査もClaudeも実行しない。
 * 理由は`describeReason`が"; "で分けないよう、セミコロンを含めない。
 */
export function prFixTimeoutMisfit(
  config: Pick<FactoryConfig, "claude_timeout_sec" | "allowed_check_commands">,
): string | null {
  const applyMisfit = singleClaudeStepMisfit(
    PR_FIX_TIMEOUT_MISFIT_REASON,
    config.claude_timeout_sec,
    PR_FIX_APPLY_STEP_TIMEOUT_SEC,
  );
  if (applyMisfit !== null) return applyMisfit;
  const checkCount = config.allowed_check_commands.length;
  if (checkCount === 0) return null;
  const verifyTotal =
    (2 + 2 * checkCount) * perRunSec(config.claude_timeout_sec) +
    PR_STEP_OVERRUN_BASE_SEC;
  if (verifyTotal <= PR_FIX_VERIFY_STEP_TIMEOUT_SEC) return null;
  return `${PR_FIX_TIMEOUT_MISFIT_REASON}: (2 claude runs + 2 x ${String(checkCount)} check commands) x (claude_timeout_sec ${String(config.claude_timeout_sec)} + ${String(PR_COMMAND_STOP_OVERHEAD_SEC)}) + ${String(PR_STEP_OVERRUN_BASE_SEC)} = ${String(verifyTotal)}s exceeds ${String(PR_FIX_VERIFY_STEP_TIMEOUT_SEC)}s`;
}

/** CI回の時間の見積もりに使う、通常の回と同じ余裕。 */
const CI_ROUND_OVERHEAD = {
  commandStopSec: PR_COMMAND_STOP_OVERHEAD_SEC,
  baseSec: PR_STEP_OVERRUN_BASE_SEC,
} as const;

/**
 * CIの失敗を直す回の時間設定が、flow.yamlの修正・検証ステップのtimeoutに収まらなければ理由を返し、収まればnullを返す。
 * 通常の回の見積もり(`prFixTimeoutMisfit`)に、CI回だけの追加の作業を足して確かめる。
 * 準備のステップが止める条件であり、`watch_pr_ci`が起動の前に同じ条件で保留する。設定だけで決まる。
 */
export function ciRoundTimeoutMisfit(
  config: Pick<FactoryConfig, "claude_timeout_sec" | "allowed_check_commands">,
): string | null {
  return (
    prFixTimeoutMisfit(config) ??
    ciRoundApplyTimeoutMisfit(
      config.claude_timeout_sec,
      PR_FIX_APPLY_STEP_TIMEOUT_SEC,
      CI_ROUND_OVERHEAD,
    ) ??
    ciRoundVerifyTimeoutMisfit(
      config.claude_timeout_sec,
      config.allowed_check_commands.length,
      PR_FIX_VERIFY_STEP_TIMEOUT_SEC,
      CI_ROUND_OVERHEAD,
    )
  );
}

/**
 * 競合回の修正ステップが、gitleaksを走らせる回数。Claudeの出力の要約と理由の検査1回である。
 */
const CONFLICT_ROUND_APPLY_SCANS = 1;

/**
 * 競合を直す回の時間設定が、flow.yamlの修正ステップのtimeoutに収まらなければ理由を返し、収まればnullを返す。
 * 通常の回の見積もり(`prFixTimeoutMisfit`)に、競合回だけの追加の作業を足して確かめる。
 * 準備のステップが止める条件であり、`watch_pr_conflicts`が起動の前に同じ条件で保留する。設定だけで決まる。
 * 修正ステップは、Claudeの実行(不正な出力への再試行を含めて2回)に、gitleaksの検査1回を足す。
 * 検証ステップは、検査コマンドを1回だけ実行し、Claudeを再実行しない。
 * 通常の回の見積もりは検査コマンドを2回とClaude 2回で数えるので、その内側に収まる。
 * gitによる読み取りが検証ステップに足す分は、その差に比べて小さく、別に見積もらない。
 */
export function conflictRoundTimeoutMisfit(
  config: Pick<FactoryConfig, "claude_timeout_sec" | "allowed_check_commands">,
): string | null {
  const base = prFixTimeoutMisfit(config);
  if (base !== null) return base;
  const scanSec =
    CI_FIX_GITLEAKS_TIMEOUT_MS / 1000 + PR_COMMAND_STOP_OVERHEAD_SEC;
  const applyTotal =
    2 * perRunSec(config.claude_timeout_sec) +
    CONFLICT_ROUND_APPLY_SCANS * scanSec +
    PR_STEP_OVERRUN_BASE_SEC;
  if (applyTotal <= PR_FIX_APPLY_STEP_TIMEOUT_SEC) return null;
  return `${conflictRoundReason("time settings do not fit the flow step timeout: ")}2 claude runs and ${String(CONFLICT_ROUND_APPLY_SCANS)} secret scan need ${String(applyTotal)}s but the step allows ${String(PR_FIX_APPLY_STEP_TIMEOUT_SEC)}s`;
}

/**
 * pr_reviewの時間設定が、flow.yamlのレビュー生成ステップのtimeoutに収まらなければ理由を返し、収まればnullを返す。
 * 生成ステップがClaudeを起動する前に確かめ、収まらなければ`needs_human`にする。
 */
export function prReviewTimeoutMisfit(
  config: Pick<FactoryConfig, "claude_timeout_sec">,
): string | null {
  return singleClaudeStepMisfit(
    PR_REVIEW_TIMEOUT_MISFIT_REASON,
    config.claude_timeout_sec,
    PR_REVIEW_GENERATE_STEP_TIMEOUT_SEC,
  );
}

// ---------------------------------------------------------------------------
// pr_fix_collect: 新しいレビューとコメントの選別と、その結果(純粋関数)
// ---------------------------------------------------------------------------

export type RawPrReview = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly body: string;
};

export type RawPrReviewComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

export type RawIssueComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly body: string;
};

export type CollectedReview = {
  readonly id: number;
  readonly body: string;
  readonly author: string;
};

export type CollectedComment = {
  readonly id: number;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
  readonly author: string;
};

/**
 * `selectNew*`の結果。すべての条件を通った項目と、
 * `author_association`が`allowed_labeler_associations`に無いという理由だけで
 * 除外した投稿者のloginを持つ。
 * 呼び出し側はこれをログに出しnoticeとして記録する。信頼できないアカウントからの
 * フィードバックを黙って捨てると、捨てたことが誰にも見えないため。
 */
export type SelectResult<T> = {
  readonly items: T[];
  readonly excludedAuthors: string[];
};

/**
 * 本文が空でなく、`last_review_id`の処理済み位置より新しく、
 * 投稿者の`author_association`が`allowedAssociations`にあるレビューを選ぶ。
 * 本文が空のレビュー(「approve」や「request changes」を押しただけのもの)には、
 * Claudeが対応できる文章のフィードバックが無い。
 * 許可リストに無い`author_association`の人のフィードバックは、
 * 信頼できない人が付けた`factory`ラベルと同じく扱わない。
 */
export function selectNewReviews(
  reviews: readonly RawPrReview[],
  lastReviewId: number,
  allowedAssociations: readonly LabelerAssociation[],
): SelectResult<CollectedReview> {
  const items: CollectedReview[] = [];
  const excludedAuthors: string[] = [];
  for (const review of reviews) {
    if (review.id <= lastReviewId || review.body.trim().length === 0) {
      continue;
    }
    if (!isOneOf(review.authorAssociation, allowedAssociations)) {
      excludedAuthors.push(review.authorLogin);
      continue;
    }
    items.push({
      id: review.id,
      body: review.body,
      author: review.authorLogin,
    });
  }
  return { items, excludedAuthors };
}

/**
 * 処理済み位置(`lastCommentId`)より新しく、許可された`author_association`の
 * 投稿者によるインラインのレビューコメントを選ぶ。
 * 「未解決」かどうかは処理済み位置で近似する。
 * 処理済み位置以下のidのコメントは、前の修正ラウンドですでに扱い、返信済みである。
 */
export function selectNewReviewComments(
  comments: readonly RawPrReviewComment[],
  lastCommentId: number,
  allowedAssociations: readonly LabelerAssociation[],
): SelectResult<CollectedComment> {
  const items: CollectedComment[] = [];
  const excludedAuthors: string[] = [];
  for (const comment of comments) {
    if (comment.id <= lastCommentId) continue;
    if (!isOneOf(comment.authorAssociation, allowedAssociations)) {
      excludedAuthors.push(comment.authorLogin);
      continue;
    }
    items.push({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      body: comment.body,
      author: comment.authorLogin,
    });
  }
  return { items, excludedAuthors };
}

/**
 * 投稿者の`author_association`が`allowedAssociations`にある、
 * Issueレベルの通常のコメントを選ぶ。
 * Factory自身の印付きの投稿と、`last_comment_id`の処理済み位置(`opts.sinceId`)より
 * 古いものは、`github.ts`の`listIssueComments`がすでに除いている。
 * 人は修正の指示を通常のコメントとして書いてから`fix_label`を付ける。
 * pr_fixにはコメントで起動する仕組みが無いので、ここにあるコメントはすべて、
 * 他の人のコメントと同じく集める、Claudeが対応するための通常のフィードバックである。
 */
export function selectNewIssueComments(
  comments: readonly RawIssueComment[],
  allowedAssociations: readonly LabelerAssociation[],
): SelectResult<CollectedComment> {
  const items: CollectedComment[] = [];
  const excludedAuthors: string[] = [];
  for (const comment of comments) {
    if (!isOneOf(comment.authorAssociation, allowedAssociations)) {
      excludedAuthors.push(comment.authorLogin);
      continue;
    }
    items.push({
      id: comment.id,
      path: "",
      line: null,
      body: comment.body,
      author: comment.authorLogin,
    });
  }
  return { items, excludedAuthors };
}

export type CollectOutcome = "proceed" | "no_feedback";

/**
 * 処理済み位置より新しいレビューもコメントも無ければ、
 * このラウンドでClaudeが対応するものは無いので`"no_feedback"`を返す。
 */
export function decideCollectOutcome(
  reviews: readonly CollectedReview[],
  comments: readonly CollectedComment[],
): CollectOutcome {
  return reviews.length === 0 && comments.length === 0
    ? "no_feedback"
    : "proceed";
}

// ---------------------------------------------------------------------------
// pr_fix_apply / pr_fix_verify: コミットメッセージの組み立て(純粋関数)
// ---------------------------------------------------------------------------

/**
 * 修正ラウンドで提案されたコミットの件名と本文(任意)をつなぎ、
 * `pr_fix_finish.ts`が`commitAndPush`に渡すコミットメッセージにする。
 * 件名と本文はClaudeが構造化出力の`commit_subject` / `commit_body`で直接提案する
 * (`FixClaudeOutput`を参照)。そのためここは単純につなぐだけで、切り詰めはしない。
 * 件名の形は`isFixClaudeOutput`の型ガードが検査する。
 * Co-Authored-ByとGenerated-Byのトレーラーは、この後に`commitAndPush`の
 * `withCommitTrailers`が足す。
 */
export function composeCommitMessage(
  subject: string,
  body: string | null,
): string {
  // 投稿するレビューの文章と同じ日本語のスペースの規則を、コミットメッセージにも適用する。
  // インラインコードのスパンは変更しない。
  const normalizedSubject = normalizeJapaneseText(subject);
  return body === null
    ? normalizedSubject
    : `${normalizedSubject}\n\n${normalizeJapaneseText(body)}`;
}

// ---------------------------------------------------------------------------
// pr_fix_apply: Claudeの構造化出力の型ガード(純粋関数)
// ---------------------------------------------------------------------------

const FIX_OUTCOMES: readonly FixOutcome[] = [
  "done",
  "requirements_gap",
  "blocked",
];

const FIX_REPLY_DECISIONS: readonly FixReplyDecision[] = [
  "fixed",
  "skipped",
  "propose_issue",
];

/**
 * コミットの件名の上限(コードポイント数)。
 * gitの件名の慣習である72にしている。
 * プロンプトとスキルはClaudeに約50字を目安とさせており、それより少し余裕を持たせる。
 * 件名が少し長いだけで、Claudeの実行1回分を無駄にしないため。
 */
const COMMIT_SUBJECT_MAX_CODEPOINTS = 72;

export type FixClaudeOutput = {
  readonly outcome: FixOutcome;
  readonly summary: string;
  readonly replies: FixReply[];
  readonly blocked_reason: string | null;
  readonly commit_subject: string;
  readonly commit_body: string | null;
};

function isIssueProposalDraftShape(
  value: unknown,
): value is { title: string; body: string } {
  return isRecord(value) && isString(value.title) && isString(value.body);
}

/**
 * 返信1件の形を判定する。
 * `decision`は必須で、無い返信は既定値を補わずにこの型ガードで不合格にする
 * (parse, don't validateの方針)。
 *
 * `issue_proposal`は、`decision`が`"propose_issue"`のときにだけ
 * `null`以外である必要がある。
 * それ以外の`decision`では、`undefined`も`null`と同じに扱う。
 * このフィールドが無かった頃に記録された返信とも互換を保つため。
 */
function isFixReplyShape(value: unknown): value is FixReply {
  if (
    !isRecord(value) ||
    !isNumber(value.review_comment_id) ||
    !isString(value.body) ||
    !isOneOf(value.decision, FIX_REPLY_DECISIONS)
  ) {
    return false;
  }
  if (value.decision === "propose_issue") {
    return isIssueProposalDraftShape(value.issue_proposal);
  }
  return value.issue_proposal === undefined || value.issue_proposal === null;
}

/**
 * `value`が`commit_subject`として受け付けられる形かを返す。
 * 条件は、`COMMIT_SUBJECT_MAX_CODEPOINTS`以下のUnicodeコードポイントの文字列で、
 * 改行を含まず(件名は常に1行)、末尾が「…」でないこと。
 * 長さは`.length`のUTF-16コードユニットではなく、コードポイントの配列に展開して数える。
 * 説明文にBMP外の文字が入りうるため。
 * 末尾の「…」を拒否するのは、Claudeは件名を自分で全部書くので、「…」で終わるのは
 * 件名を上限内に収めずに、上限を超える内容を書こうとしたことを意味するため。
 * この形の検査だけなら空文字列(`""`)も通る。
 * `outcome`が`"done"`のときに空や空白だけの件名を拒否するのは、下の`isFixClaudeOutput`。
 */
function isValidCommitSubject(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.includes("\n")) return false;
  if (value.endsWith("…")) return false;
  return [...value].length <= COMMIT_SUBJECT_MAX_CODEPOINTS;
}

/**
 * `prompts.ts`の`FIX_SCHEMA`と完全に一致する形かを判定する。
 * `blocked_reason`は`"blocked"`と`"requirements_gap"`の両方の`outcome`で使う。
 *
 * `outcome`が`"done"`のときは、`commit_subject`が空でなく空白だけでもないことも求める。
 * `FIX_SCHEMA`の説明は、コミットするものが無いとき(`"done"`以外)にだけ
 * `commit_subject: ""`を求めている。
 * `"done"`で件名が空や空白だけだと、それが`pr_fix_finish.ts`の
 * `composeCommitMessage`で件名の行になり、続く`Co-Authored-By` / `Generated-By`の
 * トレーラーが件名に繰り上がってしまう(`git commit -m "\n\nCo-Authored-By: ..."`)。
 * それ以外の`outcome`では`""`を受け付ける。
 * `pr_fix_apply.ts`は`"done"`以外の`commit_subject`を実際のコミットに使わない。
 */
export function isFixClaudeOutput(value: unknown): value is FixClaudeOutput {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.outcome, FIX_OUTCOMES)) return false;
  if (!isString(value.summary)) return false;
  if (!Array.isArray(value.replies) || !value.replies.every(isFixReplyShape)) {
    return false;
  }
  if (value.blocked_reason !== null && !isString(value.blocked_reason)) {
    return false;
  }
  if (!isValidCommitSubject(value.commit_subject)) return false;
  if (value.outcome === "done" && value.commit_subject.trim().length === 0) {
    return false;
  }
  if (value.commit_body !== null && !isString(value.commit_body)) {
    return false;
  }
  return true;
}

/**
 * CIの失敗を直す回のClaudeの出力として受け付けるか。
 * 通常の回の形(`isFixClaudeOutput`)に加えて、結果が`done`か`blocked`で、`replies`が空であること。
 * 返信は指摘に答えるもので、CI回には答える指摘が無い。ログに仕込まれた指示で返信が投稿されるのを防ぐ。
 */
export function isCiFixClaudeOutput(value: unknown): value is FixClaudeOutput {
  return isFixClaudeOutput(value) && isCiFixOutputAllowed(value);
}

// ---------------------------------------------------------------------------
// pr_fix_verify: 禁止された変更の検出(純粋関数)。
// 方針は`docs/security.md`の「PR修正の安全策」を参照。
// ---------------------------------------------------------------------------

/**
 * `git status --porcelain -z`の出力をパースする。
 * 各レコードは`XY <path>\0`で、リネームとコピーには元のパスが`\0`区切りで続く
 * (`XY <新しいパス>\0<元のパス>\0`)。
 * 改行区切りの形式は非ASCII文字や制御文字を含むパスをCの形式で引用し、
 * そうしたパスが`matchesForbiddenPath`をすり抜けるので、引用しない`-z`を読む。
 * パスは前後の空白も含めてそのまま使う。
 * リネームは新しいパスに加えて、元のパスを`"deleted"`として返す。
 * 保護されたファイルを保護された場所の外へ移しても、検査から漏れないようにするため。
 * コピーの元のパスは変わっていないので返さない。
 * 未追跡(`"??"`)、ステージ済みの追加(`"A "`)、リネームとコピーの新しいパスは`"added"`とする。
 * 「新しい`*.sh`ファイル」の禁止の検査と新しいファイルの行数の集計はこれらにだけ反応し、
 * 追跡済みの既存ファイルの編集には反応しない。
 * リネームとコピーを含めるのは、implementフローの`parseGitDiffNameStatusZ`と同じく、
 * 名前を変えて`*.sh`を作る変更も新しいファイルとして扱うため。
 * `T`(どちらの側でもtypechange)は独自の状態として扱う。
 * gitのオブジェクトの種類自体が変わった追跡済みのパス(主に通常ファイルとsymlinkの間)で、
 * リネームや普通の`"modified"`より優先する。symlinkから別の種類に変わったパスは
 * `git ls-files -s`にmode 120000として現れないことがあり、
 * symlinkが関わったことを示す手がかりがこれしか残らないため。
 */
export function parseGitStatusPorcelainZ(output: string): ChangedPath[] {
  const fields = output.split("\u0000");
  const entries: ChangedPath[] = [];
  let index = 0;
  while (index < fields.length) {
    const record = fields[index] ?? "";
    index += 1;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    const renamedOrCopied = xy.includes("R") || xy.includes("C");
    let source = "";
    if (renamedOrCopied) {
      source = fields[index] ?? "";
      index += 1;
    }
    if (path.length === 0) continue;

    let status: ChangedPathStatus = "unknown";
    if (xy === "??" || xy.includes("A")) {
      status = "added";
    } else if (xy.includes("T")) {
      status = "typechange";
    } else if (renamedOrCopied) {
      status = "added";
    } else if (xy.includes("D")) {
      status = "deleted";
    } else if (xy.includes("M")) {
      status = "modified";
    }
    entries.push({ path, status });
    if (xy.includes("R") && source.length > 0) {
      entries.push({ path: source, status: "deleted" });
    }
  }
  return entries;
}

/**
 * `git diff --name-only -z`の出力(NUL終端のパスの並び)をパースする。
 * `-z`はパスを引用しないので、非ASCII文字を含むパスもそのまま返る。
 */
export function parseGitDiffNameOnlyZ(output: string): string[] {
  return output.split("\u0000").filter((path) => path.length > 0);
}

function statusFromNameStatus(code: string): ChangedPathStatus {
  switch (code.charAt(0)) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "T":
      return "typechange";
    default:
      return "unknown";
  }
}

/**
 * `git diff -z --name-status`の出力をパースする。
 * 改行区切りの形式は非ASCII文字や制御文字を含むパスをCの形式で引用するため、
 * そうしたパスが`matchesForbiddenPath`をすり抜ける。NUL区切りの`-z`は引用しない。
 * リネーム(`R<score>\0old\0new`)は、古いパスの削除と新しいパスの追加にする。
 * 保護されたファイルを保護された場所の外へ移しても、分類から漏れないようにするため。
 * コピー(`C<score>\0src\0dst`)は`dst`の追加にする。
 */
export function parseGitDiffNameStatusZ(output: string): ChangedPath[] {
  const fields = output.split("\u0000");
  const entries: ChangedPath[] = [];
  let index = 0;
  while (index < fields.length) {
    const code = fields[index] ?? "";
    index += 1;
    if (code.length === 0) continue;
    const kind = code.charAt(0);
    if (kind === "R" || kind === "C") {
      const source = fields[index] ?? "";
      const destination = fields[index + 1] ?? "";
      index += 2;
      if (kind === "R" && source.length > 0) {
        entries.push({ path: source, status: "deleted" });
      }
      if (destination.length > 0) {
        entries.push({ path: destination, status: "added" });
      }
      continue;
    }
    const path = fields[index] ?? "";
    index += 1;
    if (path.length > 0) {
      entries.push({ path, status: statusFromNameStatus(code) });
    }
  }
  return entries;
}

/**
 * `baseSha`(ブランチとデフォルトブランチのmerge-base)とステージ済みのworktreeで
 * 異なるすべてのパスを、`git diff --cached -z --name-status`で求める。
 * implementフローは`worktreeFingerprint`がすべてをステージした後にこれを呼ぶので、
 * ブランチで先に作ったコミットの変更も含まれる。
 * `--ignore-submodules=none`を付け、`.gitmodules`や設定の`ignore`でサブモジュール(gitlink)の変更を隠させない。
 */
export async function listChangedPaths(
  run: CommandRunner,
  worktreeDir: string,
  baseSha: string,
): Promise<ChangedPath[]> {
  assertSha(baseSha);
  const result = await run(
    gitHardeningArgv([
      "diff",
      "--cached",
      "-z",
      "--name-status",
      "--no-ext-diff",
      "--ignore-submodules=none",
      baseSha,
      "--",
    ]),
    {
      cwd: worktreeDir,
      env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
    },
  );
  assertOutputComplete(
    `git diff --cached -z --name-status in ${worktreeDir}`,
    result,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git diff --cached -z --name-status failed in ${worktreeDir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return parseGitDiffNameStatusZ(result.stdout);
}

const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";

/**
 * `git diff --raw -z`の項目のうち、古いか新しいmodeが`120000`(symlink)のパスを返す。
 * 対象は追加、変更、削除、どちら向きのtypechange、リネームとコピー(新しいパスで返す)。
 * 各レコードは`:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0`で、
 * `R`と`C`には2つ目のパスが続く。パスはNUL終端で、Cの形式で引用されない。
 * 重複を除き、gitの出力順で返す。
 */
export function parseRawSymlinkPaths(output: string): string[] {
  return parseRawModePaths(output, SYMLINK_MODE);
}

/**
 * `git diff --raw -z`の項目のうち、古いか新しいmodeが`160000`(gitlink。入れ子のリポジトリ)のパスを返す。
 * 読み方は`parseRawSymlinkPaths`と同じ。
 */
export function parseRawGitlinkPaths(output: string): string[] {
  return parseRawModePaths(output, GITLINK_MODE);
}

/** `git diff --raw -z`の項目のうち、古いか新しいmodeが`mode`のパスを、重複を除いて出力順に返す。 */
function parseRawModePaths(output: string, mode: string): string[] {
  const fields = output.split("\u0000");
  const paths: string[] = [];
  let index = 0;
  while (index < fields.length) {
    const meta = fields[index] ?? "";
    index += 1;
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode, , , status] = meta.slice(1).split(" ");
    const kind = (status ?? "").charAt(0);
    const pathCount = kind === "R" || kind === "C" ? 2 : 1;
    const path = fields[index + pathCount - 1] ?? "";
    index += pathCount;
    if (
      (oldMode === mode || newMode === mode) &&
      path.length > 0 &&
      !paths.includes(path)
    ) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * `baseSha`とステージ済みのworktreeの差分で、symlinkであることが関わるすべてのパスを返す
 * (`git diff --cached --raw -z`に`parseRawSymlinkPaths`を適用する)。
 * implementフローのsymlinkの検出に使う。
 * ファイルシステムではなくgitのmodeから読むので、
 * worktreeにもう無いsymlink(削除されたもの、ファイルに変わったもの)も報告できる。
 */
export async function listSymlinkChanges(
  run: CommandRunner,
  worktreeDir: string,
  baseSha: string,
): Promise<string[]> {
  return parseRawSymlinkPaths(
    await readRawDiff(run, worktreeDir, ["--cached", "--raw"], baseSha),
  );
}

/**
 * worktreeで`git diff <modeArgs> -z --no-ext-diff --ignore-submodules=none <ref> --`を実行し、標準出力を返す。
 * `.gitmodules`や設定の`ignore`でサブモジュール(gitlink)の変更を隠させない。
 * 失敗したときと、出力の読み取りを打ち切ったときは例外を投げる。
 */
async function readRawDiff(
  run: CommandRunner,
  worktreeDir: string,
  modeArgs: readonly string[],
  ref: string,
): Promise<string> {
  if (ref !== "HEAD") assertSha(ref);
  const name = `git diff ${modeArgs.join(" ")} -z`;
  const result = await run(
    gitHardeningArgv([
      "diff",
      ...modeArgs,
      "-z",
      "--no-ext-diff",
      "--ignore-submodules=none",
      ref,
      "--",
    ]),
    {
      cwd: worktreeDir,
      env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
    },
  );
  assertOutputComplete(`${name} in ${worktreeDir}`, result);
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(`${name} failed in ${worktreeDir}: ${result.stderr.trim()}`),
    );
  }
  return result.stdout;
}

/**
 * worktreeのコミットしていない変更のパスを、`git status --porcelain -z`と`git diff --name-only -z`の和集合(`mergeChangedPaths`)で返す。
 * パスを引用させないため、どちらもNUL区切りの`-z`で読む。
 * `git status`には`--untracked-files=all`を付け、未追跡のディレクトリを`dir/`の1件にまとめさせない。
 * まとめられると、まだ無い`.github/`の下に作った`.github/workflows/*.yml`が`.github/`としか現れず、
 * 保護パスや新しい`*.sh`の判定と、新しいファイルの行数の集計から漏れるため。
 * `git status`には`--ignore-submodules=none`も付け、`.gitmodules`や設定の`ignore`でサブモジュールの変更を隠させない。
 * pr_fixの保護パス・symlink・差分の大きさの判定の入力になるので、どちらかが失敗したとき(終了コードが0以外)と、
 * 出力の読み取りを打ち切ったときは例外を投げる。空の一覧として扱うと、変更を見落とすため。
 * gitはhook・fsmonitor・credential helperを無効にして実行する。
 */
export async function listUncommittedChangedPaths(
  run: CommandRunner,
  worktreeDir: string,
): Promise<ChangedPath[]> {
  const options = {
    cwd: worktreeDir,
    env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
  };
  const [statusResult, diffResult] = await Promise.all([
    run(
      gitHardeningArgv([
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
      options,
    ),
    run(gitHardeningArgv(["diff", "--name-only", "-z"]), options),
  ]);
  assertOutputComplete(
    `git status --porcelain -z in ${worktreeDir}`,
    statusResult,
  );
  assertOutputComplete(`git diff --name-only -z in ${worktreeDir}`, diffResult);
  for (const [name, result] of [
    ["git status --porcelain -z", statusResult],
    ["git diff --name-only -z", diffResult],
  ] as const) {
    if (result.exitCode !== 0) {
      throw new Error(
        maskSecrets(
          `${name} failed in ${worktreeDir}: ${result.stderr.trim()}`,
        ),
      );
    }
  }
  return mergeChangedPaths(
    parseGitStatusPorcelainZ(statusResult.stdout),
    parseGitDiffNameOnlyZ(diffResult.stdout),
  );
}

/**
 * `git status --porcelain -z`と`git diff --name-only -z`の結果の和集合を返す。
 * `git status`だけでステージ済み・未ステージ、追跡済み・未追跡の変更を
 * すべて含むが、念のため`git diff --name-only`でも確かめる。
 * 後者にだけあるパスは、定義上gitがすでに知っている追跡済みのファイルなので
 * `"modified"`とする。
 */
export function mergeChangedPaths(
  statusPaths: readonly ChangedPath[],
  diffPaths: readonly string[],
): ChangedPath[] {
  const byPath = new Map<string, ChangedPath>();
  for (const entry of statusPaths) {
    byPath.set(entry.path, entry);
  }
  for (const path of diffPaths) {
    if (!byPath.has(path)) {
      byPath.set(path, { path, status: "modified" });
    }
  }
  return [...byPath.values()];
}

export type ForbiddenChangeResult = {
  readonly blocked: boolean;
  readonly reasons: string[];
};

/**
 * 禁止された変更をまとめて検査する。
 * 対象は、パスのパターンへの違反、新しく追加された`*.sh`ファイル、
 * `package.json`の`scripts`の変更(呼び出し側が求めたフラグで受け取る)、
 * 呼び出し側が渡す`extraReasons`(`detectEscapingSymlinks`が返す、
 * worktreeの外を指すsymlinkの理由など)。
 */
export function detectForbiddenChanges(
  paths: readonly ChangedPath[],
  packageJsonScriptsChangedFlag: boolean,
  extraReasons: readonly string[] = [],
): ForbiddenChangeResult {
  const reasons: string[] = [];
  for (const entry of paths) {
    if (matchesForbiddenPath(entry.path)) {
      reasons.push(`forbidden path changed: ${entry.path}`);
    } else if (isNewShellScript(entry)) {
      reasons.push(`new shell script added: ${entry.path}`);
    }
  }
  if (packageJsonScriptsChangedFlag) {
    reasons.push('package.json "scripts" field changed');
  }
  reasons.push(...extraReasons);
  return { blocked: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// pr_fix_verify: worktreeの外を指すsymlinkの検出(純粋関数とI/O)。
// worktreeの作成時には`workspace.ts`が`core.symlinks=false`を設定し、
// 追跡済みのsymlinkをcheckoutで本物のOSのsymlinkにしないようにしている。
// この検査はそれとは独立した補完の防御で、どう入り込んだかに関係なく、
// 差分に現れたsymlinkをverifyの時点で検出する。
// ClaudeのWriteツールは、対象のパスにある既存のsymlinkを置き換えずにその先へ書き込む
// (`fs.writeFile`のような通常のopenは`O_NOFOLLOW`を使わない)。
// そのため検査が無いと、書き込みが気づかないうちにworktreeの外に及ぶ。
// ---------------------------------------------------------------------------

export type SymlinkTarget = {
  readonly path: string;
  readonly target: string;
};

/**
 * `git ls-files -s -z`の出力(各レコードが`<mode> <sha> <stage>\t<path>\0`)をパースし、
 * modeが`120000`(symlink)の項目のパスだけを返す。
 * `-z`はパスを引用しないので、非ASCII文字を含むパスもそのまま返り、
 * 変更パスの一覧と突き合わせられる。
 */
export function parseSymlinkModePathsZ(output: string): string[] {
  const paths: string[] = [];
  for (const record of output.split("\u0000")) {
    const tabIndex = record.indexOf("\t");
    if (tabIndex === -1) continue;
    const mode = record.slice(0, tabIndex).trim().split(/\s+/)[0];
    const path = record.slice(tabIndex + 1);
    if (mode === "120000" && path.length > 0) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * symlinkの指す先を、worktreeの中のsymlink自身のディレクトリを基準に
 * (gitやOSと同じように)解決し、絶対パスで返す。
 */
export function resolveSymlinkTarget(
  worktreeDir: string,
  symlinkRelPath: string,
  targetText: string,
): string {
  return resolve(dirname(join(worktreeDir, symlinkRelPath)), targetText);
}

/**
 * symlinkの解決後の指す先が`worktreeDir`の外にあるかを返す。
 * `..`による相対パスでの脱出と、絶対パスの指す先の両方を扱う。
 */
export function isEscapingSymlink(
  worktreeDir: string,
  symlinkRelPath: string,
  targetText: string,
): boolean {
  const resolved = resolveSymlinkTarget(
    worktreeDir,
    symlinkRelPath,
    targetText,
  );
  const root = resolve(worktreeDir);
  return resolved !== root && !resolved.startsWith(`${root}${sep}`);
}

/**
 * worktreeの外を指すsymlinkごとに、`detectForbiddenChanges`の形式の理由の文字列を作る。
 */
export function detectEscapingSymlinks(
  worktreeDir: string,
  symlinkTargets: readonly SymlinkTarget[],
): string[] {
  const reasons: string[] = [];
  for (const entry of symlinkTargets) {
    if (isEscapingSymlink(worktreeDir, entry.path, entry.target)) {
      reasons.push(
        `symlink escapes the worktree: ${entry.path} -> ${entry.target}`,
      );
    }
  }
  return reasons;
}

/**
 * symlinkの作成、変更、typechangeを無条件に止める理由を返す。
 * 上の`detectEscapingSymlinks`の「worktreeの外に解決される」という個別の理由を
 * 包含するが、置き換えずに併用する。
 * symlinkから別の種類に変わったパス(通常ファイルに置き換えられたものなど)は
 * `git ls-files -s`にmode 120000として現れないことがあるので、
 * 独立した2つの手がかりを使う。
 *   - 変更されたパスのうち、現在symlinkであるもの(`symlinkTargets`にある、
 *     つまり今mode 120000のもの)。新しいsymlinkと、
 *     指す先が変わった既存のsymlinkを捕まえる。
 *   - 変更されたパスのうち、`parseGitStatusPorcelainZ`が`typechange`に分類したもの。
 *     どちら向きでもsymlinkと通常ファイルの間の変換を捕まえる。
 *     symlinkが消えた後は、`git ls-files -s`の現在の状態だけでは見逃すため。
 */
export function detectSymlinkChanges(
  paths: readonly ChangedPath[],
  symlinkTargets: readonly SymlinkTarget[],
): string[] {
  const symlinkPaths = new Set(symlinkTargets.map((entry) => entry.path));
  const reasons: string[] = [];
  for (const entry of paths) {
    if (symlinkPaths.has(entry.path)) {
      reasons.push(`symlink_change: symlink changed: ${entry.path}`);
    } else if (entry.status === "typechange") {
      reasons.push(
        `symlink_change: file type changed (possible symlink conversion): ${entry.path}`,
      );
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// pr_fix_verify: 差分の大きさの上限(純粋関数とI/O)。
// 際限なく多くのファイルや行に触れる修正は、レビューの負担になり、
// 自動pushで影響の及ぶ範囲も大きくなる。
// `factory_config.max_fix_changed_files` / `max_fix_diff_lines`を超えたら止めることで、
// 無条件の禁止パスの検査とは別に、運用者が調整できる明示的な上限を設ける
// (既定は30ファイル、追加と削除の合計1500行)。
// ---------------------------------------------------------------------------

export type DiffNumstatEntry = {
  readonly path: string;
  // `git diff --numstat`はバイナリファイルの追加・削除の行数に"-"を出す。
  // 0に変換せず`null`で保持し、`sumDiffNumstatLines`の呼び出し側が必要なら
  // 「行単位の差分が無い」と「本当に0行の変更」を区別できるようにする。
  readonly additions: number | null;
  readonly deletions: number | null;
};

/**
 * `git diff --numstat -z`の出力をパースする。
 * 各レコードは`<added>\t<deleted>\t<path>\0`で、リネームとコピーはパスの欄が空になり、
 * 元のパスと新しいパスが`\0`区切りで続く(`<added>\t<deleted>\t\0<元>\0<新>\0`)。
 * リネームとコピーは新しいパスで返す。
 */
export function parseGitDiffNumstatZ(output: string): DiffNumstatEntry[] {
  const fields = output.split("\u0000");
  const entries: DiffNumstatEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const record = fields[index] ?? "";
    index += 1;
    const parts = record.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...pathParts] = parts;
    let path = pathParts.join("\t");
    if (path.length === 0) {
      path = fields[index + 1] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;
    entries.push({
      path,
      additions: addRaw === "-" ? null : safeInt(addRaw),
      deletions: delRaw === "-" ? null : safeInt(delRaw),
    });
  }
  return entries;
}

function safeInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * すべての項目の追加と削除の行数を合計する。
 * `git diff --numstat`はバイナリファイルの行数を出さないので、その`null`は0として数える。
 * バイナリファイルも、上限のうち変更ファイル数の側では数えられる。
 */
export function sumDiffNumstatLines(
  entries: readonly DiffNumstatEntry[],
): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.additions ?? 0;
    total += entry.deletions ?? 0;
  }
  return total;
}

/**
 * `worktreeDir`で`git diff --numstat -z`を読む(インデックスに対する未ステージの変更)。
 * `pr_fix_verify`の他の検査が見るのと同じ作業ツリーの状態に合わせている。
 */
export async function getDiffNumstat(
  run: CommandRunner,
  worktreeDir: string,
): Promise<DiffNumstatEntry[]> {
  const result = await run(gitHardeningArgv(["diff", "--numstat", "-z"]), {
    cwd: worktreeDir,
    env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
  });
  assertOutputComplete(`git diff --numstat -z in ${worktreeDir}`, result);
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git diff --numstat -z failed in ${worktreeDir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return parseGitDiffNumstatZ(result.stdout);
}

/**
 * `wc -l`の1行の出力(`<count> <path>`。countは`wc`自身が空白で桁揃えする)から、
 * 先頭の整数を取り出す。
 */
export function parseWcLineCount(output: string): number {
  const match = output.trim().match(/^(\d+)/);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/**
 * 未追跡の(新しく追加された)ファイルの行数を`wc -l`で数える。
 * `git diff --numstat`は作業ツリーをインデックスと比べるので、
 * インデックスに無い未追跡のファイルを一切出さない。
 * そのままでは、差分の大きさの関門から未追跡ファイルの行数がまったく見えない。
 * `git add -N`(intent-to-add)ならnumstatにも出るが、副作用として
 * worktreeのgitのインデックスを書き換える。`wc -l`にはその副作用が無い。
 * `wc`が読めないファイル(`git status`の後に競合で消えた、環境によってはバイナリなど)は、
 * 例外にせず0として数える。`listSymlinkTargets`と同じく、
 * 残りの安全策で防ぐという考え方による。
 * 出力の読み取りを打ち切ったときは、数が途中で切れているかもしれないので例外を投げる。
 */
export async function countUntrackedFileLines(
  run: CommandRunner,
  worktreeDir: string,
  path: string,
): Promise<number> {
  const result = await run(["wc", "-l", "--", path], { cwd: worktreeDir });
  assertOutputComplete(`wc -l in ${worktreeDir}`, result);
  if (result.exitCode !== 0) return 0;
  return parseWcLineCount(result.stdout);
}

/**
 * 差分の大きさの理由に書く`factory_config`のキー。
 * pr_fixとimplementフローでは上限が別なので、理由の文には
 * 運用者が実際に調整するキーを書く必要がある。
 */
export type DiffSizeLimitNames = {
  readonly changedFiles: keyof FactoryConfig;
  readonly diffLines: keyof FactoryConfig;
};

export const PR_FIX_DIFF_SIZE_LIMIT_NAMES: DiffSizeLimitNames = {
  changedFiles: "max_fix_changed_files",
  diffLines: "max_fix_diff_lines",
};

export const IMPLEMENT_DIFF_SIZE_LIMIT_NAMES: DiffSizeLimitNames = {
  changedFiles: "implement_max_changed_files",
  diffLines: "implement_max_diff_lines",
};

/**
 * 変更ファイル数か、追加と削除の合計行数が`factory_config`の上限を超えたら、
 * 止める理由を返す。
 * `changedFileCount`には、numstatだけから数え直した値ではなく、
 * 呼び出し側が求めた`git status`と`git diff --name-only`の和集合
 * (禁止パスの検査と同じ集合)の件数を渡す。
 * numstatは、`git status --porcelain`が出す
 * 未追跡の(新しく追加された)ファイルを出さないため。
 * `names`で理由の文に書く設定キーを選ぶ(既定はpr_fixのもの)。
 */
export function evaluateDiffSizeGuard(
  changedFileCount: number,
  diffLineTotal: number,
  maxChangedFiles: number,
  maxDiffLines: number,
  names: DiffSizeLimitNames = PR_FIX_DIFF_SIZE_LIMIT_NAMES,
): string[] {
  const reasons: string[] = [];
  if (changedFileCount > maxChangedFiles) {
    reasons.push(
      `changed file count ${String(changedFileCount)} exceeds ${names.changedFiles} ${String(maxChangedFiles)}`,
    );
  }
  if (diffLineTotal > maxDiffLines) {
    reasons.push(
      `diff line total ${String(diffLineTotal)} exceeds ${names.diffLines} ${String(maxDiffLines)}`,
    );
  }
  return reasons;
}

/**
 * pr_fixのコミットしていない変更が、差分の大きさの上限を超えていれば止める理由を返す。
 * ファイル数には`changedPaths`(禁止パスの検査と同じ集合)の件数を使う。
 * 行数は`git diff --numstat -z`の合計に、`"added"`のパスごとの`wc -l`の行数を足す。
 * numstatは未追跡のファイルを出さないため。
 * ファイル数がすでに上限を超えていれば、行数を数えずにファイル数の理由だけを返す。
 * 未追跡のファイルが大量にあると、`wc -l`をその数だけ起動することになるため。
 */
export async function evaluateUncommittedDiffSize(
  run: CommandRunner,
  worktreeDir: string,
  changedPaths: readonly ChangedPath[],
  maxChangedFiles: number,
  maxDiffLines: number,
): Promise<string[]> {
  if (changedPaths.length > maxChangedFiles) {
    return evaluateDiffSizeGuard(
      changedPaths.length,
      0,
      maxChangedFiles,
      maxDiffLines,
    );
  }
  const numstatEntries = await getDiffNumstat(run, worktreeDir);
  const untrackedLineCounts = await Promise.all(
    changedPaths
      .filter((entry) => entry.status === "added")
      .map((entry) => countUntrackedFileLines(run, worktreeDir, entry.path)),
  );
  const untrackedLineTotal = untrackedLineCounts.reduce((a, b) => a + b, 0);
  return evaluateDiffSizeGuard(
    changedPaths.length,
    sumDiffNumstatLines(numstatEntries) + untrackedLineTotal,
    maxChangedFiles,
    maxDiffLines,
  );
}

/**
 * `paths`のうち`git ls-files -s`がsymlink(mode `120000`)と報告するものについて、
 * ディスク上の指す先を読む。
 * gitのblobではなく実際の現在のworktreeの状態を読むのは、Claudeのツールが
 * symlinkの先へ書き込んだ結果が古いblobには反映されないため。
 * WriteやEditは既存のsymlinkの先へ書き込むだけで、新しいOSのsymlinkは作れない。
 * そのため、この関数は差分が触れただけの既存の追跡済みsymlinkも捕まえる。
 * gitが報告してもディスク上で読めないsymlink(競合で消えたものなど)は、
 * 例外にせず飛ばす。禁止パスの検査と`allowed_check_commands`の検査が、残りの安全策になる。
 * `paths`は`--literal-pathspecs`で文字どおりのパスとして渡す。
 * `*`や`[`を含むファイル名がglobとして別のファイルに一致し、
 * 変更していないsymlinkを報告しないようにするため。
 */
export async function listSymlinkTargets(
  run: CommandRunner,
  worktreeDir: string,
  paths: readonly string[],
  readLink: (path: string) => Promise<string> = (path) => readlink(path),
): Promise<SymlinkTarget[]> {
  if (paths.length === 0) return [];
  const result = await run(
    gitHardeningArgv([
      "--literal-pathspecs",
      "ls-files",
      "-s",
      "-z",
      "--",
      ...paths,
    ]),
    {
      cwd: worktreeDir,
      env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
    },
  );
  assertOutputComplete(`git ls-files -s -z in ${worktreeDir}`, result);
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git ls-files -s -z failed in ${worktreeDir}: ${result.stderr.trim()}`,
      ),
    );
  }
  const symlinkPaths = parseSymlinkModePathsZ(result.stdout);
  const targets: SymlinkTarget[] = [];
  for (const path of symlinkPaths) {
    try {
      const target = await readLink(join(worktreeDir, path));
      targets.push({ path, target });
    } catch {}
  }
  return targets;
}

/** `probeChangedPathsOnDisk`が使う2つのファイル操作。テスト用に注入できる。 */
export type PathProbeFs = {
  readonly lstat: (
    path: string,
  ) => Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>;
  readonly readlink: (path: string) => Promise<string>;
};

const defaultPathProbeFs: PathProbeFs = {
  lstat: (path) => lstat(path),
  readlink: (path) => readlink(path),
};

/** パスが無いことを表すfsのエラー(ENOENT / ENOTDIR)かを返す。 */
function isMissingPathError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "ENOENT" || err.code === "ENOTDIR")
  );
}

/** `probeChangedPathsOnDisk`の結果。 */
export type DiskProbe = {
  /** ディスク上で今symlinkであるパスと、その指す先。 */
  readonly symlinks: SymlinkTarget[];
  /** 通常のファイルでもsymlinkでもないパス(ディレクトリ・FIFO・デバイスなど)。 */
  readonly nonRegular: string[];
};

/**
 * `paths`を`lstat`で1つずつ調べ、symlink(指す先も読む)と、通常のファイルでもsymlinkでもないものを返す。
 * `listSymlinkTargets`は索引にあるパスしか見ないので、未追跡の新しいsymlinkを報告しない。
 * そうしたsymlinkも`git add -A`でcommitに入るため、こちらで補う。
 * 検査コマンドはOSのsymlinkを作れるので、`core.symlinks=false`では防げない。
 * 通常のファイルでないものは、中身を読むとFIFOで止まったり、デバイスを読み続けたりするので、読む前に見つける。
 * 無くなったパス(ENOENT / ENOTDIR)は飛ばし、それ以外の失敗は例外を投げる。
 * 読めないパスを通常のファイルとみなすと、判定を素通りさせるため。
 */
export async function probeChangedPathsOnDisk(
  worktreeDir: string,
  paths: readonly string[],
  fs: PathProbeFs = defaultPathProbeFs,
): Promise<DiskProbe> {
  const symlinks: SymlinkTarget[] = [];
  const nonRegular: string[] = [];
  for (const path of paths) {
    const fullPath = join(worktreeDir, path);
    try {
      const stats = await fs.lstat(fullPath);
      if (stats.isSymbolicLink()) {
        symlinks.push({ path, target: await fs.readlink(fullPath) });
      } else if (!stats.isFile()) {
        nonRegular.push(path);
      }
    } catch (err) {
      if (isMissingPathError(err)) continue;
      throw err;
    }
  }
  return { symlinks, nonRegular };
}

/**
 * 入れ子のリポジトリか`.git`に関わる変更パスごとに止める理由を返す。
 * 対象は、末尾が`/`のパス(`git status`が未追跡の入れ子のリポジトリを`dir/`の1件にまとめたもの)と、
 * どこかの要素が`.git`のパス(大文字と小文字を区別しない)。
 * `git add -A`は入れ子のリポジトリをgitlinkとして入れ、中のファイルは保護パスの判定に現れないため。
 */
export function detectNestedRepoPaths(paths: readonly ChangedPath[]): string[] {
  return paths
    .filter(
      (entry) =>
        entry.path.endsWith("/") ||
        entry.path
          .split("/")
          .some((segment) => segment.toLowerCase() === ".git"),
    )
    .map((entry) => `nested repository or .git path changed: ${entry.path}`);
}

/** `inspectUncommittedChanges`が見る差分の大きさの上限。 */
export type UncommittedChangeLimits = {
  readonly maxChangedFiles: number;
  readonly maxDiffLines: number;
};

/**
 * worktreeのコミットしていない変更に、禁止されたファイル・パターン、symlink、入れ子のリポジトリ、
 * 通常のファイルでないもの、`package.json`のscriptsの変更、差分サイズの上限超過が無いかを調べて返す。
 * symlinkは次の3つで探し、worktreeの外を指すもの(`detectEscapingSymlinks`)と、作成・変更・削除・型の変更をすべて止める。
 * - 索引のmode(`listSymlinkTargets`)
 * - ディスク上の種類(`probeChangedPathsOnDisk`)。未追跡のsymlinkを見つける。
 * - HEADと作業ツリーの`git diff --raw`のmode。`core.symlinks=false`のworktreeでは追跡済みのsymlinkが通常のファイルとして置かれ、
 *   中身を書き換えると指す先が変わるが、`readlink`も`lstat`もsymlinkと報告しないため。
 * 同じ`git diff --raw`のmodeで、gitlink(入れ子のリポジトリ)の変更も止める。
 * サブモジュールのディレクトリを消したgitlinkの削除は、ディスクに何も残らず、パスにも`.git`が現れないため。
 * これらのどれかで止めるときは、`package.json`の中身と差分の行数を読まない。
 * どちらもファイルを読むので、symlinkの先(worktreeの外や`/dev/zero`)やFIFOを読みうるため。
 * gitはhook・fsmonitor・credential helperを無効にして実行する。
 */
export async function inspectUncommittedChanges(
  run: CommandRunner,
  worktreeDir: string,
  limits: UncommittedChangeLimits,
  fs: PathProbeFs = defaultPathProbeFs,
): Promise<ForbiddenChangeResult> {
  const changedPaths = await listUncommittedChangedPaths(run, worktreeDir);
  const indexTargets = await listSymlinkTargets(
    run,
    worktreeDir,
    changedPaths.map((entry) => entry.path),
    fs.readlink,
  );
  const raw =
    changedPaths.length === 0
      ? ""
      : await readRawDiff(run, worktreeDir, ["--raw", "--no-renames"], "HEAD");
  const disk = await probeChangedPathsOnDisk(
    worktreeDir,
    changedPaths
      .filter((entry) => entry.status !== "deleted")
      .map((entry) => entry.path),
    fs,
  );
  const indexPaths = new Set(indexTargets.map((entry) => entry.path));
  const symlinkTargets = [
    ...indexTargets,
    ...disk.symlinks.filter((entry) => !indexPaths.has(entry.path)),
  ];
  const stopReasons = [
    ...new Set([
      ...detectNestedRepoPaths(changedPaths),
      ...parseRawGitlinkPaths(raw).map(
        (path) => `nested repository or .git path changed: ${path}`,
      ),
      ...disk.nonRegular.map((path) => `not a regular file: ${path}`),
      ...detectEscapingSymlinks(worktreeDir, symlinkTargets),
      ...detectSymlinkChanges(changedPaths, symlinkTargets),
      ...parseRawSymlinkPaths(raw).map(
        (path) => `symlink_change: symlink changed: ${path}`,
      ),
    ]),
  ];
  if (stopReasons.length > 0) {
    return detectForbiddenChanges(changedPaths, false, stopReasons);
  }

  // basenameがちょうど`package.json`の変更ファイルをすべて調べる。
  // 末尾一致だと`my-package.json`のような別ファイルにも当たるため使わない。
  const packageJsonChanged = await anyPackageJsonScriptsChanged(
    run,
    worktreeDir,
    "HEAD",
    changedPaths,
  );
  const diffSizeReasons = await evaluateUncommittedDiffSize(
    run,
    worktreeDir,
    changedPaths,
    limits.maxChangedFiles,
    limits.maxDiffLines,
  );
  return detectForbiddenChanges(
    changedPaths,
    packageJsonChanged,
    diffSizeReasons,
  );
}

/**
 * worktreeのHEADが、準備ステップで記録したPRのhead(`expectedSha`)で、ブランチ`branch`にあるかを確かめる。
 * 違えば止める理由を返し、合っていればnullを返す。
 * 検査コマンドがローカルでcommitやブランチの切り替えをすると、HEADを基準にした変更の一覧から
 * そのcommitの変更が消え、保護パスの判定を経ずにpushされるため。
 * `git rev-parse --verify HEAD`が失敗したときと、`git symbolic-ref -q HEAD`が0と1以外で終わったときは例外を投げる
 * (1はdetachedのHEADで、止める理由にする)。
 */
export async function localHeadStopReason(
  run: CommandRunner,
  worktreeDir: string,
  expectedSha: string,
  branch: string,
): Promise<string | null> {
  const options = {
    cwd: worktreeDir,
    env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
  };
  const shaResult = await run(
    gitHardeningArgv(["rev-parse", "--verify", "HEAD"]),
    options,
  );
  if (shaResult.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git rev-parse --verify HEAD failed in ${worktreeDir}: ${shaResult.stderr.trim()}`,
      ),
    );
  }
  const sha = shaResult.stdout.trim();
  if (sha !== expectedSha) {
    return `local HEAD ${sha} is not the PR head ${expectedSha}`;
  }
  const refResult = await run(
    gitHardeningArgv(["symbolic-ref", "-q", "HEAD"]),
    options,
  );
  if (refResult.exitCode !== 0 && refResult.exitCode !== 1) {
    throw new Error(
      maskSecrets(
        `git symbolic-ref -q HEAD failed in ${worktreeDir}: ${refResult.stderr.trim()}`,
      ),
    );
  }
  return refResult.exitCode === 0 &&
    refResult.stdout.trim() === `refs/heads/${branch}`
    ? null
    : `local HEAD is not on branch ${branch}`;
}

/**
 * 索引にある`path`の中身(`git show :0:<path>`)を返す。索引に無ければnullを返す。
 * 出力の読み取りを打ち切ったときは例外を投げる。
 */
async function readStagedFile(
  run: CommandRunner,
  worktreeDir: string,
  path: string,
): Promise<string | null> {
  const result = await run(gitHardeningArgv(["show", `:0:${path}`]), {
    cwd: worktreeDir,
    env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
  });
  assertOutputComplete(`git show :0:${path} in ${worktreeDir}`, result);
  return result.exitCode === 0 ? result.stdout : null;
}

/**
 * ステージした内容を`baseSha`と比べ、commitしてはいけない変更ごとに止める理由を返す(無ければ空)。
 * 見るのは、保護パスと新しい`*.sh`(`detectForbiddenChanges`)、symlinkとgitlinkのmode(`git diff --cached --raw -z`)、
 * 入れ子のリポジトリか`.git`のパス、`package.json`のscriptsの変更(ステージした中身を`git show :0:<path>`で読む)。
 * pr_fixの完了ステップが`git add -A`の後、commitの前に呼ぶ。
 * 検証ステップの最後の検査の後にworktreeが変わっても、commitする内容そのもので判定するため。
 * ファイルシステムを読まないので、symlinkの先やFIFOに触れない。
 */
export async function inspectStagedChanges(
  run: CommandRunner,
  worktreeDir: string,
  baseSha: string,
): Promise<string[]> {
  const changes = await listChangedPaths(run, worktreeDir, baseSha);
  const raw = await readRawDiff(
    run,
    worktreeDir,
    ["--cached", "--raw"],
    baseSha,
  );
  const modeReasons = [
    ...detectNestedRepoPaths(changes),
    ...parseRawGitlinkPaths(raw).map(
      (path) => `nested repository or .git path changed: ${path}`,
    ),
    ...parseRawSymlinkPaths(raw).map(
      (path) => `symlink_change: symlink changed: ${path}`,
    ),
  ];
  let scriptsChanged = false;
  for (const entry of changes) {
    if (entry.path.split("/").pop() !== "package.json") continue;
    const before = await readGitShowFile(run, worktreeDir, baseSha, entry.path);
    const after = await readStagedFile(run, worktreeDir, entry.path);
    if (packageJsonScriptsChanged(before, after)) {
      scriptsChanged = true;
      break;
    }
  }
  return detectForbiddenChanges(changes, scriptsChanged, [
    ...new Set(modeReasons),
  ]).reasons;
}

/**
 * Claudeが書いた`blocked_reason`を、状態の理由に使える形にして返す(無ければnull)。
 * 区切りの`"; "`を`", "`に置き換え、知っている理由を後ろに足して次の操作を選ばせないようにする。
 * 理由そのものを既知の理由と同じ文にされることは防げない。
 */
export function claudeBlockedReason(reason: string | null): string | null {
  return reason === null ? null : escapeReasonSeparator(reason);
}

/** `scanPrFixBeforeCommit`が使うI/O。テストでは偽物に差し替える。 */
export type PrFixSecretScanDeps = {
  /** `runGitleaksOnWorktree`をPRのhead(`head_sha`)を基準に実行する。すべてをステージし直してから検査する。 */
  readonly scanForSecrets: () => Promise<GitleaksScan>;
  /** ステージした内容をPRのheadと比べる(`inspectStagedChanges`)。 */
  readonly inspectChanges: () => Promise<readonly string[]>;
  /** 今ステージしてある内容を、検査したツリーと比べる(`scannedTreeStopReasons`)。 */
  readonly inspectTree: (scannedTreeSha: string) => Promise<readonly string[]>;
};

export type PrFixSecretScanResult =
  | { readonly kind: "stop"; readonly reason: string }
  | {
      readonly kind: "commit";
      /** 検査したツリー。`commitAndPush`の`expectedTreeSha`に渡す。 */
      readonly treeSha: string;
      /** `commitAndPush`の`inspectStaged`に渡す。検査し直さない。 */
      readonly inspectStaged: () => Promise<string[]>;
    };

/**
 * pr_fixの完了ステップが、`commitAndPush`の前に実装フローと同じgitleaksの検査(ステージした差分、`--redact`)をする。
 * 検査は`commitAndPush`のリポジトリのロックの外で行う。検査は長くかかりうり、ロックの古さの判定や待ちの上限を超えうるため。
 * 検出があれば`SECRETS_NOT_PUSHED_REASON`で止める。
 * 無ければ、検査したツリーと、ロックの中で呼ぶ確かめ(保護パスなどの変更と、索引が検査したツリーのままか)を返す。
 * 検査自体の失敗はそのまま投げる(何もcommitしない)。
 */
export async function scanPrFixBeforeCommit(
  deps: PrFixSecretScanDeps,
): Promise<PrFixSecretScanResult> {
  const scan = await deps.scanForSecrets();
  if (!scan.ok) return { kind: "stop", reason: SECRETS_NOT_PUSHED_REASON };
  return {
    kind: "commit",
    treeSha: scan.treeSha,
    inspectStaged: async () => [
      ...(await deps.inspectChanges()),
      ...(await deps.inspectTree(scan.treeSha)),
    ],
  };
}

/**
 * 準備ステップの結果に`worktree_git_pointer`が無いときの理由。
 * 照合する基準が無いままworktreeでgitやClaudeを実行しないよう、各ステップは"blocked"にする。
 */
export const WORKTREE_GIT_POINTER_NOT_RECORDED_REASON =
  "worktree git pointer was not recorded";

/**
 * 準備ステップの結果に`head_sha`か`branch`が無いときの理由。
 * HEADを照合する基準が無いままworktreeでgitを実行しないよう、検証ステップは"blocked"にする。
 */
export const PR_HEAD_NOT_RECORDED_REASON = "PR head was not recorded";

/**
 * 準備ステップが記録した`.git`の中身`recorded`でworktreeの`.git`を確かめ、止める理由を返す(問題が無ければnull)。
 * `recorded`がnullか空なら`.git`を読まずに`WORKTREE_GIT_POINTER_NOT_RECORDED_REASON`を返す。
 * `assertGitPointer`が`WorktreeGitPointerModifiedError`を投げれば、その理由を返し、それ以外の例外はそのまま投げる。
 * pr_fixの修正・検証・完了の各ステップが、Claudeの起動とworktreeでのgitの実行の前に呼ぶ。
 */
export async function recordedGitPointerStopReason(
  recorded: string | null,
  assertGitPointer: (expected: string) => Promise<void>,
): Promise<string | null> {
  if (recorded === null || recorded.length === 0) {
    return WORKTREE_GIT_POINTER_NOT_RECORDED_REASON;
  }
  return gitPointerStopReason(() => assertGitPointer(recorded));
}

/**
 * pr_fixの完了ステップがcommitの前に止めたとき(`prFixPushGateReason`か`CommitBlockedError`)の遷移を返す。
 * `statusNote`(`work_items.status_reason`に記録する値)にも止めた理由を入れる。
 * このとき直前のステップの`reason`はdoneでnullなので、それを使うと理由が記録に残らないため。
 * 理由が、workerが検査の前提を満たさないこと(`isCheckEnvironmentReason`)か、
 * リポジトリのオーナーの数値IDの照合に落ちたこと(`isRepoOwnerStopReason`)なら、準備と検証のステップの関門と同じく、
 * `blocked`にして修正のラウンドを記録しない(`recordsRound`がfalse)。Claudeの修正の失敗ではないので、モデルの失敗に数えないためである。
 * それ以外は`needs_human`にして、止めたラウンドを記録する。
 */
export function stopBeforeCommitTerminal(stopReason: string): {
  readonly toStatus: "needs_human" | "blocked";
  readonly recordsRound: boolean;
  readonly discordReason: string;
  readonly statusNote: string;
} {
  const environment =
    isCheckEnvironmentReason(stopReason) || isRepoOwnerStopReason(stopReason);
  return {
    toStatus: environment ? "blocked" : "needs_human",
    recordsRound: !environment,
    discordReason: stopReason,
    statusNote: stopReason,
  };
}

/** `prFixPushGateReason`が使うI/O。テストでは偽物に差し替える。 */
export type PrFixPushGateDeps = {
  /** worktreeのロックを持つプロセスがいれば`WorktreeBusyError`を投げる(何も止めない)。 */
  readonly ensureLockFree: () => Promise<void>;
  /** worktreeの`.git`を`expected`と比べ、違えば`WorktreeGitPointerModifiedError`を投げる。 */
  readonly assertGitPointer: (expected: string) => Promise<void>;
};

/**
 * pr_fixの完了ステップがcommitとpushの前に、worktreeに触れてよいかを確かめ、止める理由を返す(問題が無ければnull)。
 * 先にworktreeのロックを確かめ、前のステップのClaudeや検査コマンドが残っていれば`WorktreeBusyError`のmessageを返す。
 * 検証ステップの最後の検査の後に、残ったプロセスがworktreeを書き換えうるため。
 * 残った所有権を、workerが検査の前提を満たさず取り戻せないとき(`CheckEnvironmentError`)も、そのmessageを返す。
 * `busyReason`を渡すと、`WorktreeBusyError`のときだけ、そのmessageを渡して得た文を返す。
 * 呼び出し側が、保持者を含む文を固定の注記に置き換えるために使う。`CheckEnvironmentError`には使わない。
 * 次に`.git`を準備ステップの記録と比べる(`recordedGitPointerStopReason`)。
 * 最後に、準備ステップの結果にPRのブランチ(`recordedBranch`)があることを確かめ、無ければ`PR_HEAD_NOT_RECORDED_REASON`を返す。
 * `commitAndPush`の`expectedBranch`に渡す値で、無いとpushする先を確かめられないため。
 * それ以外の例外はそのまま投げる。
 */
export async function prFixPushGateReason(
  deps: PrFixPushGateDeps,
  recordedPointer: string | null,
  recordedBranch: string | null,
  busyReason?: (holder: string) => string,
): Promise<string | null> {
  try {
    await deps.ensureLockFree();
  } catch (err) {
    if (err instanceof WorktreeBusyError) {
      return busyReason === undefined ? err.message : busyReason(err.message);
    }
    if (err instanceof CheckEnvironmentError) return err.message;
    throw err;
  }
  const pointerReason = await recordedGitPointerStopReason(
    recordedPointer,
    deps.assertGitPointer,
  );
  if (pointerReason !== null) return pointerReason;
  return recordedBranch === null || recordedBranch.length === 0
    ? PR_HEAD_NOT_RECORDED_REASON
    : null;
}

/**
 * 2つのファイル内容で、`package.json`の`scripts`オブジェクトが異なるかを返す
 * (どちらも`null`になりえて、その時点でファイルが無かったことを表す)。
 * 不正なJSONは例外にせず「scriptsが無い」として扱う。
 * `package.json`の内容は信頼できない対象リポジトリのデータなので`JSON.parse`以外では
 * パースしない。パースの失敗だけでは禁止された変更ではない
 * (壊れた`package.json`は検査コマンドが自分で表に出す)。
 */
export function packageJsonScriptsChanged(
  beforeText: string | null,
  afterText: string | null,
): boolean {
  return (
    JSON.stringify(extractScripts(beforeText)) !==
    JSON.stringify(extractScripts(afterText))
  );
}

function extractScripts(text: string | null): Record<string, string> {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return {};
  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.scripts)) {
    if (typeof value === "string") scripts[key] = value;
  }
  return scripts;
}

// ---------------------------------------------------------------------------
// pr_fix_finish: 結果に応じた振り分け(純粋関数)
// ---------------------------------------------------------------------------

export type PrFixFinishOutcome =
  | "skip"
  | "guard_blocked"
  | "round_exhausted"
  | "no_feedback"
  | "done"
  | "requirements_gap"
  | "blocked"
  | "conflict_up_to_date"
  | "conflict_blocked";

export type PrFixFinalAction =
  | { readonly kind: "noop" }
  | { readonly kind: "push" }
  | { readonly kind: "requirements_gap_reroute" }
  | { readonly kind: "requirements_gap_needs_human" }
  | { readonly kind: "guard_blocked" }
  | { readonly kind: "needs_human" }
  | { readonly kind: "conflict_up_to_date" }
  | { readonly kind: "conflict_blocked" };

/**
 * まとめた結果(prepare、collect、apply、verifyのうち最後に動いたものの結果)を、
 * `pr_fix_finish.ts`が取るべき終端の動作に振り分ける。
 *
 * `guard_blocked`(prepareの、PRがopen・forkでない・draftでない・
 * headブランチが保護ブランチでもデフォルトブランチでもないという関門と、prepareかverifyがworkerのイメージが古く検査を実行できないと分かったとき)は、
 * `docs/internals/pr-workflow.md`の「準備での確認」のとおり`work_items`の`"blocked"`にする。修正のラウンドは記録しない。
 * `blocked`(Claude自身の判断か、`pr_fix_verify`が検出した禁止ファイルや
 * 検査コマンドの失敗)は`"needs_human"`にする。
 * どちらも上流では`"blocked"`の形の結果だが、失敗の種類が違うので、
 * 意図して別の終端状態にしている。
 *
 * `conflict_up_to_date`(baseがすでにPRに取り込まれていて、直す競合が無い)と
 * `conflict_blocked`(競合回で直せない競合)は、競合回の準備のステップだけが返す。
 * どちらも、後続のステップを経ずに終端へ進む。
 */
export function decideFixFinishAction(
  outcome: PrFixFinishOutcome,
  hasParent: boolean,
): PrFixFinalAction {
  switch (outcome) {
    case "skip":
      return { kind: "noop" };
    case "done":
      return { kind: "push" };
    case "requirements_gap":
      return hasParent
        ? { kind: "requirements_gap_reroute" }
        : { kind: "requirements_gap_needs_human" };
    case "guard_blocked":
      return { kind: "guard_blocked" };
    case "round_exhausted":
    case "no_feedback":
    case "blocked":
      return { kind: "needs_human" };
    case "conflict_up_to_date":
      return { kind: "conflict_up_to_date" };
    case "conflict_blocked":
      return { kind: "conflict_blocked" };
  }
}

/** `pr_fix_finish.ts`の`main()`が終えた結果の種別。処理済み位置を進めるかの判断に使う。 */
export type PrFixFinishBumpKind =
  | "guard_blocked"
  | "needs_human"
  | "requirements_gap_needs_human"
  | "requirements_gap_reroute_failed"
  | "requirements_gap_reroute_success"
  | "push_missing_commit_message"
  | "push_head_changed"
  | "push_nothing_to_commit"
  | "push_success";

/**
 * `pr_fix_finish.ts`が処理済み位置
 * (`last_review_id` / `last_comment_id` / `last_review_comment_id`)を進めてよいかを、
 * `main()`の終端の結果の種別から返す。
 * 処理済み位置は、結果が分かる前に進めてはならない。
 * 先に進めると、後のステップが例外を投げたとき(`git commit`の失敗などで)作業項目が
 * `failed`になった時点で、処理済み位置がこのラウンドを起こしたフィードバックを越えている。
 * すると`retry_work_item`が`pr_fix_collect`を再実行しても集めるものが無く、
 * 実際には再試行されずに`needs_human`("no actionable feedback")になる。
 *
 * 処理済み位置を進めるのは、このラウンドのフィードバックを実際に消化したときだけ。
 *   - `push_success`: 修正をコミットしてpushし、それを起こしたコメントに返信した。
 *     ラウンドで`propose_issue`の提案を1件以上記録し、`rereview_requested`ではなく
 *     `needs_human`で終わる場合も`push_success`に数える。
 *     どちらにしても元のコメントには(修正でなく提案で)返信しているので、
 *     他の成功したpushと同じく、このラウンドのフィードバックは消化済みである。
 *   - `requirements_gap_reroute_success`: 親のIssueを`requirements_generating`に
 *     差し戻すことで、フィードバックを消化した。
 * それ以外の終端の種別(試行の開始前に関門が止めた、何らかの原因の`needs_human`、
 * 失敗した差し戻し(親の作業項目が見つからない、親にIssue番号が無い、
 * 親が差し戻せる状態にない、親が試行回数を使い切った、
 * 親が読み取った後に変わって比較交換に負けた)、
 * 実際には反映されなかったpush
 * (コミットメッセージが無い、headが動いた、コミットするものが無い))では、
 * 処理済み位置を変えない。
 * 後の`retry_work_item`が同じフィードバックを集め直せるようにするため。
 * `main()`のどこかで例外が出た場合(`failed`になり、この関数ではなく
 * `on_error_flow.ts`が扱う)も、位置を進める呼び出しには届かない。
 */
export function shouldAdvanceWatermarks(kind: PrFixFinishBumpKind): boolean {
  return kind === "requirements_gap_reroute_success" || kind === "push_success";
}

/**
 * `pr_fix_finish.ts`のrequirements_gapの差し戻しの関門。
 * テストできるよう純粋関数にしている。
 * 差し戻してよければ親のIssue番号を、そうでなければ`needs_human`に倒す理由を返す。
 * 親のIssueのトリガーラベルは着手時に消費済みで付け直さないので、残る前提条件は
 * 親の作業項目が実際にIssueであることだけ。
 */
export function evaluateRerouteGuard(
  issueNumber: number | null,
):
  | { readonly ok: true; readonly issueNumber: number }
  | { readonly ok: false; readonly reason: string } {
  return issueNumber === null
    ? { ok: false, reason: "parent work item has no issue_number" }
    : { ok: true, issueNumber };
}

/**
 * requirements_gapの差し戻しで、親の作業項目がこの状態のときだけ`requirements_generating`へ移す。
 * どちらも親のフローが動いていない状態で、`approved`は実装を起動する前、`pr_open`は実装が終わった後である。
 * 要件定義の生成中や承認待ち、実装中、終端の失敗などで差し戻すと、動いているフローや人の判断を上書きする。
 */
export const ALLOWED_REROUTE_PARENT_STATUSES = ["approved", "pr_open"] as const;

/** requirements_gapの差し戻し先の親の作業項目。Issue番号が無い親は差し戻す前に除いておく。 */
export type RerouteParent = {
  readonly id: number;
  readonly issue_number: number;
  readonly status: WorkItemStatus;
  readonly flow_job_id: string | null;
  readonly attempt: number;
};

function describeRerouteParent(
  parent: Pick<RerouteParent, "id" | "issue_number">,
): string {
  return `parent work item ${String(parent.id)} (issue #${String(parent.issue_number)})`;
}

/**
 * `pr_fix_finish.ts`のrequirements_gapの差し戻しで、親の作業項目の状態を見る関門。
 * 親が`ALLOWED_REROUTE_PARENT_STATUSES`のどれかなら`null`を返し、それ以外は`needs_human`に倒す理由を返す。
 * 親が`implementing`なら実装フローが動いており、差し戻すとそのリースを奪って結果を失わせるので、理由を分けて実装の完了を待つよう案内する。
 * `pr_fix_prepare`の同じ確認は開始時の1回だけなので、差し戻す直前にもう一度確かめる。
 */
export function evaluateRerouteParentStatus(
  parent: Pick<RerouteParent, "id" | "issue_number" | "status">,
): string | null {
  if (isOneOf(parent.status, ALLOWED_REROUTE_PARENT_STATUSES)) return null;
  if (parent.status === "implementing") {
    return `${describeRerouteParent(parent)} is being implemented, requirements_gap not rerouted`;
  }
  return `${describeRerouteParent(parent)} is ${parent.status}, requirements_gap not rerouted`;
}

/**
 * 親の作業項目を読んだ後、差し戻しの比較交換までの間に状態か`flow_job_id`が変わったときの理由。
 * 並行して別のフローが親を進めたので、差し戻さずに`needs_human`へ倒す。
 */
export function rerouteParentChangedReason(
  parent: Pick<RerouteParent, "id" | "issue_number">,
): string {
  return `${describeRerouteParent(parent)} changed before the requirements_gap reroute`;
}

/**
 * 親の要件定義の試行回数が`max_attempts`に達していて差し戻せないときの理由。
 * implementフローの同じ判定の理由(`gapExhaustedReason`)と分けるのは、PRの通知から親のIssueを辿れるようにするため。
 */
export function rerouteAttemptsExhaustedReason(
  parent: Pick<RerouteParent, "id" | "issue_number">,
  maxAttempts: number,
): string {
  return `${describeRerouteParent(parent)} used up max_attempts ${String(maxAttempts)}, requirements_gap not rerouted`;
}

/**
 * 差し戻しを止めた理由の後ろに、Claudeが報告した要件の不足を別の区間としてつなぐ。
 * `describeReason`は区間ごとに訳し、`nextActionFor`は先頭の理由の対応を選ぶ。
 * 報告の中の`"; "`は`", "`に置き換え、報告が区間を足して訳や次の操作を差し替えられないようにする。
 */
export function withGapReport(reason: string, gapReport: string): string {
  return gapReport.length > 0
    ? `${reason}; ${escapeReasonSeparator(gapReport)}`
    : reason;
}

/** 差し戻しで起動したpipelineのジョブIDを親に記録できず、そのジョブを取り消したときの理由。 */
export function pipelineJobIdNotRecordedReason(
  parentWorkItemId: number,
  jobId: string,
): string {
  return `pipeline job ${jobId} was cancelled because work item ${String(parentWorkItemId)} already records another flow job`;
}

export type RerouteGapDeps = {
  /**
   * `updateStatusIfLeaseHolderClearingFlowJobId`で、親を読み取った時点の状態と`flow_job_id`のままのときだけ
   * `requirements_generating`へ移し、`flow_job_id`を空にする。条件に合わなければ`false`を返す。
   */
  readonly casParent: (
    expectedFrom: WorkItemStatus,
    expectedFlowJobId: string | null,
  ) => Promise<boolean>;
  /** このpr_fixの作業項目の処理済み位置を、今回集めたフィードバックの先まで進める。 */
  readonly bumpWatermarks: () => Promise<void>;
  /** このpr_fixの作業項目を`fixing`から`blocked`へ移す。 */
  readonly markBlocked: () => Promise<void>;
  /** `runFlowAsync("f/factory/pipeline", ...)`の戻り値をそのまま返す。ジョブIDの解析は`rerouteRequirementsGap`が行う。 */
  readonly launchPipeline: () => Promise<string>;
  /** `setFlowJobIdIfUnset`で親にジョブIDを記録する。別の実行が先に書いていれば`false`を返す。 */
  readonly recordFlowJobId: (jobId: string) => Promise<boolean>;
  readonly cancelJob: (jobId: string, reason: string) => Promise<void>;
  /** `job_failures`に記録し、Consoleの要対応から見えるようにする。 */
  readonly recordFailure: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export type RerouteGapOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "rerouted";
      readonly jobId: string;
      readonly recorded: boolean;
    };

/**
 * requirements_gapで親の作業項目を要件定義の作り直しへ差し戻す。
 * 親の状態が許されないか試行回数を使い切っていれば、何も書かずに理由を返す。
 * 親を比較交換で移せなければ、親が読み取った後に変わったので、同じく何も書かずに理由を返す。
 * 移せたら、処理済み位置を進め、このpr_fixを`blocked`にしてからpipelineを起動する。
 * 起動は取り消せず外から見える唯一の操作なので、他の書き込みをすべて済ませた後に行う。
 * 起動の応答がジョブIDでなければ例外を投げ、ステップの失敗として`on_error_flow`に任せる。
 * 起動したジョブのIDを記録できなければ(比較交換の後に別の実行が親に書いた)、
 * pipelineが2つ動かないようそのジョブの取り消しを試み、失敗として記録する。取り消しと記録の失敗はログに残すだけで投げない。
 */
export async function rerouteRequirementsGap(
  parent: RerouteParent,
  maxAttempts: number,
  deps: RerouteGapDeps,
): Promise<RerouteGapOutcome> {
  const statusReason = evaluateRerouteParentStatus(parent);
  if (statusReason !== null) return { kind: "refused", reason: statusReason };
  if (decideGapReroute(parent.attempt, maxAttempts) === "needs_human") {
    return {
      kind: "refused",
      reason: rerouteAttemptsExhaustedReason(parent, maxAttempts),
    };
  }
  if (!(await deps.casParent(parent.status, parent.flow_job_id))) {
    return { kind: "refused", reason: rerouteParentChangedReason(parent) };
  }

  // 親Issueの要件定義を作り直すことで今回のフィードバックに対応するため、
  // 差し戻しでフィードバックを消費したとみなし、ここで処理済み位置を進める。
  if (shouldAdvanceWatermarks("requirements_gap_reroute_success")) {
    await deps.bumpWatermarks();
  }
  await deps.markBlocked();
  const jobId = parseFlowJobId(await deps.launchPipeline(), "runFlowAsync");

  const recorded = await deps.recordFlowJobId(jobId);
  if (!recorded) {
    const reason = pipelineJobIdNotRecordedReason(parent.id, jobId);
    deps.log("pipeline flow job id not recorded; cancelling the launched job", {
      parent_work_item_id: parent.id,
      started_job_id: jobId,
    });
    try {
      await deps.cancelJob(jobId, reason);
    } catch (err) {
      deps.log("failed to cancel the launched pipeline job", {
        started_job_id: jobId,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
    try {
      await deps.recordFailure(reason);
    } catch (err) {
      deps.log("failed to record the pipeline job id failure", {
        started_job_id: jobId,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return { kind: "rerouted", jobId, recorded };
}

/**
 * `factory_config.default_reviewers`が空のときに使う代わりのレビュアー。
 * この修正ラウンドを起こしたレビューやコメントの投稿者を使う。
 * `github.ts`の`PullRequest`には、代わりに読める
 * 「依頼済みのレビュアー」のフィールドが無いため。
 * 重複と空のloginを除く。
 */
export function deriveFallbackReviewers(
  reviewAuthors: readonly string[],
  commentAuthors: readonly string[],
): string[] {
  const set = new Set(
    [...reviewAuthors, ...commentAuthors].filter((login) => login.length > 0),
  );
  return [...set];
}

/**
 * GitHubのIssueを閉じるキーワードの構文に一致するパターン。
 * close/closes/closed、fix/fixes/fixed、resolve/resolves/resolved
 * (大文字小文字を区別しない)の後に、
 * 省略できるコロンと、`#N`(GitHubの略記で、常に同じリポジトリを指す)か
 * 明示的な`owner/repo#N`が続く。
 * owner/repoがあれば($1、$2)捕まえ、呼び出し側が別リポジトリへの参照を除けるようにする。
 * 呼び出しごとに新しい`RegExp`を作る(下を参照)。モジュールレベルの`g`フラグ付きの
 * パターンは、呼び出しをまたいで`lastIndex`の状態を持ち越すため。
 */
const LINKED_ISSUE_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*(?:([\w.-]+)\/([\w.-]+))?#(\d+)/gi;

/**
 * PRの本文が、GitHubのIssueを閉じるキーワードの構文で閉じるIssueの番号を取り出す。
 * 人が書いたPRを承認済みの要件に結び付けるために使う(`poll_prs.ts`は最初の結果で
 * そのIssueの承認済みのpipelineの作業項目を探し、新しいpr_review / pr_fixの行の
 * `parent_work_item_id`に設定する)。
 * 明示的な`owner/repo#N`は、`owner` / `repo`がこのPRのリポジトリと一致する
 * (大文字小文字を区別しない)ときだけ残す。別リポジトリへの参照は、
 * このFactoryのインスタンスが探せるものに結び付かないため。
 * 重複を除き、最初に現れた順を保つ。
 */
export function extractLinkedIssueNumbers(
  body: string,
  owner: string,
  repo: string,
): number[] {
  const pattern = new RegExp(
    LINKED_ISSUE_PATTERN.source,
    LINKED_ISSUE_PATTERN.flags,
  );
  const seen = new Set<number>();
  const result: number[] = [];
  let match: RegExpExecArray | null = pattern.exec(body);
  while (match !== null) {
    const [, matchedOwner, matchedRepo, numberText] = match;
    if (matchedOwner !== undefined && matchedRepo !== undefined) {
      const sameRepo =
        matchedOwner.toLowerCase() === owner.toLowerCase() &&
        matchedRepo.toLowerCase() === repo.toLowerCase();
      if (!sameRepo) {
        match = pattern.exec(body);
        continue;
      }
    }
    const issueNumber = Number(numberText);
    if (Number.isFinite(issueNumber) && !seen.has(issueNumber)) {
      seen.add(issueNumber);
      result.push(issueNumber);
    }
    match = pattern.exec(body);
  }
  return result;
}

/**
 * `review_comment_id`が、`pr_fix_collect.ts`が実際に集めたコメントのidに無い返信を除く。
 * Claudeの構造化出力は信頼できない入力の影響を受ける。特定のコメントへの対応を
 * 頼んでいても、幻覚のidや攻撃者が仕込んだidを返すことは防げない。
 * 除かないと、GitHubへの返信の経路(`replyReviewComment` / `postIssueComment`)の
 * どちらも、集めていないidに対して動いてしまう。
 */
export function filterKnownReplies(
  replies: readonly FixReply[],
  knownCommentIds: ReadonlySet<number>,
): FixReply[] {
  return replies.filter((reply) =>
    knownCommentIds.has(reply.review_comment_id),
  );
}

/**
 * factory-fixスキルの返信形式に沿って、pr_fixの返信の本文を描画する。
 * 1行目は役割タグ、次にClaudeの`body`(説明だけ。「対応しました:」「対応しません:」の
 * 接頭辞はClaudeに書かせず、ここで描画する)、空行、最後に`対応: <sha7>`の行を置く。
 * `reply.decision`が`"skipped"`なら`対応: 見送り`にする。
 * Claudeが対応しないと判断した返信には、指すコミットが無いため。
 * `nothing_to_commit`の経路では`newSha`が`null`になる(`pr_fix_finish.ts`は
 * コミットするものが無くても、溜めた返信を投稿する)。そのとき`"fixed"`の返信は、
 * shaが存在しないので`対応: 変更なし`にする。
 * `<!-- factory:pr_fix:<id> -->`の印は、この後に呼び出し側が
 * `github.ts`の`withMarker`で足す。
 * `reply.body`は`normalizeJapaneseText`を通す。
 *
 * `reply.decision`が`"propose_issue"`なら、本文には代わりに、提案するIssueのタイトル
 * (`提案するIssue: <title>`)と、その本文の先頭3行の引用を載せ、
 * `対応: Issue化を提案(承認待ち)`で終える。
 * Issueを実際に作るかは人がConsoleの要対応で承認か却下し(`issue_proposal_apply.ts`)、
 * 決まった後にそちらが続きの返信を投稿する。
 * `issue_proposal`の無い`"propose_issue"`の返信は、例外にせず空のタイトルと本文にする。
 * `isFixReplyShape`の検査を通っていれば起きないが、
 * この関数は任意の`FixReply`を受け付けるため。
 */
export function renderFixReply(reply: FixReply, newSha: string | null): string {
  if (reply.decision === "propose_issue") {
    const proposal = reply.issue_proposal ?? { title: "", body: "" };
    const quotedBody = proposal.body
      .split("\n")
      .slice(0, 3)
      .map((line) => `> ${normalizeJapaneseText(line)}`)
      .join("\n");
    return [
      ROLE_TAGS.pr_fix,
      normalizeJapaneseText(reply.body),
      "",
      `提案するIssue: ${normalizeJapaneseText(proposal.title)}`,
      quotedBody,
      "",
      "対応: Issue化を提案(承認待ち)",
    ].join("\n");
  }

  const disposition =
    reply.decision === "skipped"
      ? "見送り"
      : newSha === null
        ? "変更なし"
        : `\`${newSha.slice(0, 7)}\``;
  return [
    ROLE_TAGS.pr_fix,
    normalizeJapaneseText(reply.body),
    "",
    `対応: ${disposition}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// pr_fix_finish / issue_proposal_apply: `propose_issue`の返信。
// 人が承認か却下するためのIssueの候補を記録する。
// ---------------------------------------------------------------------------

/**
 * Claudeがこのラウンドで`"propose_issue"`とした`FixReply`を返す。
 * `pr_fix_finish.ts`が、`factory.issue_proposals`に記録する行数と、
 * ラウンドを`rereview_requested`ではなく`needs_human`で終えるかを決めるのに使う。
 */
export function selectProposeIssueReplies(
  replies: readonly FixReply[],
): FixReply[] {
  return replies.filter((reply) => reply.decision === "propose_issue");
}

/**
 * `load`でレビュースレッドを取得し、失敗したら`onError`に理由を渡して空の一覧を返す。
 * `pr_fix_finish.ts`はpushの後にスレッドを取得する。ここで例外を投げてstepが失敗すると、
 * pushしたのに返信・記録・状態の遷移が無いまま残り、再実行で同じ修正をやり直しうる。
 * スレッドは`propose_issue`の行に付けるidを求めるためのベストエフォートの情報なので、
 * 取れなければidを付けずに続ける。
 * 形の合わないスレッドが1つあるだけでも一覧全体が例外になり、空になる。
 */
export async function listReviewThreadsBestEffort(
  load: () => Promise<ReviewThread[]>,
  onError: (message: string) => void,
): Promise<ReviewThread[]> {
  try {
    return await load();
  } catch (err) {
    onError(maskSecrets(err instanceof Error ? err.message : String(err)));
    return [];
  }
}

export type ReplyPostFailure = {
  readonly reviewCommentId: number;
  readonly error: string;
};

/**
 * `pr_fix_finish.ts`の返信の投稿で失敗したものをまとめ、Consoleの要対応に出す
 * noticeを1件作る。失敗が無ければnullを返す。
 * 返信の投稿は失敗してもステップを止めない(pushの後なので)。そのままだと失敗は
 * ログにしか残らず、人は返信が無いことに気づけないため、件数・id・最初のエラーを載せ、
 * PRで人が返信するよう案内する。
 */
export function buildReplyPostFailedNotice(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly workItemId: number;
  },
  failures: readonly ReplyPostFailure[],
): NoticeRecord | null {
  const first = failures[0];
  if (first === undefined) return null;
  const ids = failures.map((failure) => String(failure.reviewCommentId));
  return {
    kind: "fix_reply_post_failed",
    message: `${target.owner}/${target.repo}#${String(target.prNumber)} (work item ${String(target.workItemId)}): レビューコメントへの返信${String(failures.length)}件の投稿に失敗しました(review_comment_id: ${ids.join(", ")}、最初のエラー: ${first.error})。PRで人が返信してください`,
  };
}

/**
 * `threads`から、`reviewCommentId`を含むレビュースレッドを探し、そのidを返す。
 * `pr_fix_finish.ts`が、新しく記録する`propose_issue`の行に
 * GraphQLのスレッドidを付けるのに使う。
 * `issue_proposal_apply.ts`が承認時にそのスレッドを解決できるようにするため。
 * コメントのidで照合する。`(path, line)`で照合すると、後のコミットでdiffの行番号が
 * ずれたときに、気づかないうちに別のスレッドと一致してしまう。
 * よくある場合は`thread.firstCommentDatabaseId`で安く見つかる。
 * スレッド内の後のコメントへの返信は`thread.allCommentIds`で見つかる。
 * `allCommentIds`が持つのはスレッドの先頭50件のコメントだけである(`github.ts`の`listReviewThreads`を参照)。
 * idを含むスレッドが無ければ`null`を返す
 * (レビュースレッドを持たない通常のIssueコメントなど)。
 */
export function matchReviewThreadForComment(
  threads: readonly ReviewThread[],
  reviewCommentId: number,
): string | null {
  const match = threads.find(
    (thread) =>
      thread.firstCommentDatabaseId === reviewCommentId ||
      thread.allCommentIds.includes(reviewCommentId),
  );
  return match?.id ?? null;
}

/**
 * 保留中のIssue化の提案を1件以上記録したために`needs_human`で終わるラウンドの、
 * Discordと`status_reason`に使う文。
 * 下の`REASON_RULES`の項目に一致するので、他の`needs_human`の理由と同じく
 * `describeReason`(この文はすでに日本語なので変えない)と
 * `nextActionFor`(Consoleの要対応を案内する)が扱う。
 */
export function buildIssueProposalReason(count: number): string {
  return `Issue化の提案が${String(count)}件あります`;
}

/**
 * 修正で提案されたIssueの本文にある`{{pr_url}}`を、元のPRのURLに置き換え、
 * Issueの出どころを示す固定のフッターを足す。
 * `{{pr_url}}`は`prompts.ts`の`fixPrompt`が定める置き換え文字列。
 * フッターの「Issue」「PR #<N>」と日本語の間には、規約に従い半角スペースを入れない。
 */
export function buildIssueProposalBody(
  bodyTemplate: string,
  prUrl: string,
  prNumber: number,
): string {
  const withUrl = bodyTemplate.split("{{pr_url}}").join(prUrl);
  // GitHubのIssueになる以上、Claudeの提案の文章にも、Factoryが書く他の文章と
  // 同じスペースの規則を適用する。
  return `${normalizeJapaneseText(withUrl)}\n\nこのIssueはPR #${String(prNumber)}のレビュー指摘から起票されました`;
}

/**
 * 監査レポートから出た提案のIssueの本文を作る。
 * 結び付けるPRが無いので、出どころの行には監査した期間を書く。
 */
export function buildAuditProposalBody(
  bodyTemplate: string,
  periodLabel: string,
): string {
  return `${normalizeJapaneseText(bodyTemplate)}\n\nこのIssueは監査レポート(${periodLabel})から起票されました`;
}

/**
 * GitHubに作るIssueのタイトルを返す。
 * Claudeの提案のタイトルに、英字と日本語の間のスペースの規則を適用する。
 */
export function buildIssueProposalTitle(title: string): string {
  return normalizeJapaneseText(title.trim());
}

/**
 * `issue_proposal_apply.ts`が承認時に投稿する、スレッドへの返信を描画する。
 * `<!-- factory:pr_fix:<id> -->`の印は、`renderFixReply`の呼び出し側と同じく、
 * 呼び出し側が`github.ts`の`withMarker`で足す。
 */
export function renderIssueProposalApprovedReply(issueNumber: number): string {
  return [
    ROLE_TAGS.pr_fix,
    `Issue #${String(issueNumber)}を起票しました。`,
    "",
    `対応: Issue #${String(issueNumber)}`,
  ].join("\n");
}

/**
 * `issue_proposal_apply.ts`が却下時に投稿する、スレッドへの返信を描画する。
 * 印の扱いは`renderIssueProposalApprovedReply`と同じ。
 * `reason`は人が書いた自由文で、`normalizeJapaneseText`を通す。
 */
export function renderIssueProposalRejectedReply(reason: string): string {
  return [
    ROLE_TAGS.pr_fix,
    "見送りとします。",
    `理由: ${normalizeJapaneseText(reason)}`,
    "",
    "対応: 見送り",
  ].join("\n");
}

/**
 * `issue_proposal_apply.ts`が作ったIssueの本文に埋める
 * `<!-- factory:issue_proposal:<id> -->`の印の種別。
 * 下の作成と判定の関数を対で使い、承認の決定を再試行したときに、
 * `github.ts`の`findIssueByMarker`で作成済みのIssueを見つけて再利用し、
 * 重複して作らないようにする。
 */
const ISSUE_PROPOSAL_MARKER_KIND = "issue_proposal";

/**
 * 印の中身の語句(`<!-- -->`のコメント構文を除いたもの)を返す。
 */
export function issueProposalMarkerKey(proposalId: number): string {
  return `factory:${ISSUE_PROPOSAL_MARKER_KIND}:${String(proposalId)}`;
}

/**
 * 作ったIssueの本文に埋める、`<!-- factory:issue_proposal:<id> -->`の印の全文を返す。
 * `findIssueByMarker`に渡す。
 */
export function issueProposalMarkerText(proposalId: number): string {
  return `<!-- ${issueProposalMarkerKey(proposalId)} -->`;
}

/**
 * 作ったIssueの本文の末尾に、`issueProposalMarkerText`の印を足す。
 */
export function appendIssueProposalMarker(
  body: string,
  proposalId: number,
): string {
  return `${body}\n\n${issueProposalMarkerText(proposalId)}`;
}

/**
 * `body`の最後の行(末尾の空白を除く)が`proposalId`の印だけであるかを返す。
 * `findIssueByMarker`の結果を信じる前の確認に使う。
 * 本文の途中にある印は、引用や貼り付けで人が書けるため、作成済みの印として扱わない。
 */
export function hasIssueProposalMarker(
  body: string,
  proposalId: number,
): boolean {
  return endsWithMarkerLine(body, issueProposalMarkerText(proposalId));
}

export type IssueProposalReplyTarget = "inline" | "issue_comment";

/**
 * `issue_proposal_apply.ts`が提案の判断を返信するときに使う、GitHubの返信の仕組みを返す。
 * 行に保存した`is_inline`のフラグだけから決まる。
 * `replyReviewComment`を試して失敗したら`postIssueComment`に切り替える推測はしない。
 */
export function chooseIssueProposalReplyTarget(
  isInline: boolean,
): IssueProposalReplyTarget {
  return isInline ? "inline" : "issue_comment";
}

export type IssueProposalDecisionRow = {
  readonly status: IssueProposalStatus;
  readonly created_issue_number: number | null;
};

export type IssueProposalDecisionRequest = {
  readonly decision: "approve" | "reject";
  readonly reason: string;
  /**
   * 下の`classifyIssueProposalDecision`は読まない(`IssueProposalDecisionRow`に
   * 対応するフィールドが無い)。
   * `repost_only`の再試行の`with_factory_label`は、分類を変えない。
   * 実際に適用するラベルの選択も変えない。`issue_proposal_apply.ts`の承認の経路は、
   * 再試行でIssueの作成を再開するとき、再試行のリクエストのこの値ではなく、
   * 行に保存済みの`with_factory_label`(最初の承認の選択)を読み直す。
   * 保存済みの選択が常に優先される。
   */
  readonly with_factory_label: boolean;
};

export type IssueProposalClassification =
  | { readonly action: "proceed" }
  | { readonly action: "repost_only" }
  /**
   * 同じ判断がすでに記録され、かつすべての副作用が完了している(Issueが存在する)。
   * 無害な再送なので、呼び出し側は失敗にせず、何もしないで終える。
   */
  | { readonly action: "already_done"; readonly created_issue_number: number }
  | { readonly action: "refuse"; readonly message: string };

/**
 * `issue_proposal_apply.ts`の`main()`が、読んだばかりの提案の行に対して何をすべきかを、
 * DBやGitHubに触れる前に分類する。承認の経路を冪等にするための判断で、
 * テストできるよう純粋関数にしている
 * (`approval_decide.ts`の`classifyExistingApproval`と同じ形)。
 *
 *   - `"proceed"`: 行がまだ`pending`で、新しい判断である。
 *   - `"repost_only"`: 行がすでに`requested`と同じ判断を持つが、副作用が完了していない
 *     かもしれない(Issueの作成が`created_issue_number`を書き戻す前に落ちた承認など)。
 *     `main()`は判断を再び記録しようとしてはならない(`decideIssueProposal`の
 *     `WHERE status = 'pending'`の条件で、どのみち何も起きない)。
 *     ただし残りの処理(Issueの作成か再利用、返信、解決)は冪等に最後まで行う。
 *   - `"already_done"`: 行が同じ承認を持ち、Issueもすでに作られている。
 *     もうすることは無く、もう一度行うとIssueや返信が重複する。
 *   - `"refuse"`: 行がすでに`requested`と異なる判断を持つ(本当の衝突)。
 *     `message`はそのまま例外に使える日本語の文。
 */
export function classifyIssueProposalDecision(
  row: IssueProposalDecisionRow,
  requested: IssueProposalDecisionRequest,
): IssueProposalClassification {
  if (row.status === "pending") {
    return { action: "proceed" };
  }
  const requestedStatus =
    requested.decision === "approve" ? "approved" : "rejected";
  if (row.status !== requestedStatus) {
    const currentLabel = row.status === "approved" ? "承認" : "却下";
    const requestedLabel = requested.decision === "approve" ? "承認" : "却下";
    return {
      action: "refuse",
      message: `この提案は既に${currentLabel}として判断済みです(今回のリクエストは${requestedLabel})`,
    };
  }
  if (row.status === "approved" && row.created_issue_number !== null) {
    return {
      action: "already_done",
      created_issue_number: row.created_issue_number,
    };
  }
  return { action: "repost_only" };
}

export type IssueProposalStatusDecision =
  | { readonly action: "keep" }
  | {
      readonly action: "swap";
      readonly toStatus: "rereview_requested" | "reviewed";
    };

/**
 * `issue_proposal_apply.ts`が判断を1件記録した後に、作業項目の状態をどうするかを決める。
 * この作業項目の提案がまだ1件でも保留中なら、現在の`needs_human`のままにする。
 * そうでなければ、`rereview_requested`(このラウンドでコミットをpushした。
 * `factory.fix_rounds.commit_shas`が空でない)か、`reviewed`(何もpushしていない。
 * 提案を出したラウンド自体が`nothing_to_commit`のラウンドだった)に移す。
 * PRには状態ラベルを付けないので、作業項目の状態だけを決める。
 */
export function decidePostProposalStatus(
  remainingPendingCount: number,
  committedThisRound: boolean,
): IssueProposalStatusDecision {
  if (remainingPendingCount > 0) {
    return { action: "keep" };
  }
  return {
    action: "swap",
    toStatus: committedThisRound ? "rereview_requested" : "reviewed",
  };
}

export type PostProposalTransition =
  | { readonly action: "keep" }
  | {
      readonly action: "swap";
      readonly expectedFrom: WorkItemStatus;
      readonly toStatus: WorkItemStatus;
    };

/**
 * `decidePostProposalStatus`と同じ判断に、作業項目の種類ごとの待ち状態と終わりの状態を加える。
 * auditは`awaiting_approval`で待って`audited`で終わる。
 * pr_fixは`needs_human`で待って`rereview_requested`か`reviewed`で終わる。
 */
export function decidePostProposalTransition(
  kind: WorkItemKind,
  remainingPendingCount: number,
  committedThisRound: boolean,
): PostProposalTransition {
  if (remainingPendingCount > 0) {
    return { action: "keep" };
  }
  if (kind === "audit") {
    return {
      action: "swap",
      expectedFrom: "awaiting_approval",
      toStatus: "audited",
    };
  }
  return {
    action: "swap",
    expectedFrom: "needs_human",
    toStatus: committedThisRound ? "rereview_requested" : "reviewed",
  };
}

// ---------------------------------------------------------------------------
// describeReason: `reason` / `status_reason`の文字列を、表示のためだけに日本語に訳す。
// `updateStatusIfCurrent` / `addNoticeUnlessUnresolved`で記録する`reason`は、
// 元の英語の形のまま保つ必要がある。
// 他のツールがその値を手がかりにしており、`factory.notices`と`status_reason`は
// 機械的に比べられる状態を保つためのものだから。
// 一方で、同じ文をGitHubのコメントやDiscordの通知に出すときは、Factoryが投稿する
// 人向けの他の文字列と同じく日本語で読めるようにする。
// `describeReason`は、`pr_workflow_support.ts`と、pr_fix_*、pipeline_*、
// `pr_review_generate.ts`の各ステップが出す既知の関門と結果の理由の文字列を、
// その表示のためだけに日本語の文へ対応させる。呼び出し側は、訳していない値を
// 引き続き`updateStatusIfCurrent` / `addNoticeUnlessUnresolved`に渡す。
// この関数が知らない理由(Claude自身の自由文の`summary`や`blocked_reason`を含む)は、
// 黙って捨てたり崩したりせず、そのまま返す。
// ---------------------------------------------------------------------------

export type ReasonRule = {
  readonly pattern: RegExp;
  readonly describe: (match: RegExpMatchArray) => string;
  /**
   * `needs_human`の通知が伝える理由には、読み手が何をすればよいかも必ず添える。
   * `describeReason`が`describe`を選ぶのと同じく、
   * 下の`nextActionFor`が規則ごとにこれを選ぶ。
   * 具体的な日本語の1文の指示にする。
   * 固有の対応が無い理由(安全のための関門の失敗だけのものなど)と、
   * この表が知らない理由には、汎用の`GENERIC_NEXT_ACTION`を使う。
   * `flow`は理由を出したフロー(`nextActionFor`の引数)。フローによって取れる操作が違う理由だけが使う。
   */
  readonly nextAction: (
    match: RegExpMatchArray,
    flow: NextActionFlow | undefined,
  ) => string;
  /**
   * CI回(`pr_fix`のうち、CIの失敗を直す回)での次の操作。
   * 人が取る手順と、その後の再実行が組みになった理由で、手順を残して再実行だけを、自動の評価し直しを待つ案内か、PRへのpushの案内に差し替える。
   * CI回は再実行も`factory:fix`の付け直しも効かないので、`nextAction`をそのまま使えないためである。
   * 無い規則は、`nextActionForPrFix`が`nextAction`から決める。
   */
  readonly ciNextAction?: (
    match: RegExpMatchArray,
    flow: NextActionFlow | undefined,
  ) => string;
};

/** 次の操作がフローによって違う理由のための、理由を出したフローの種類。 */
export type NextActionFlow = LockOwner["kind"] | "dependabot";

/**
 * 作業項目を同じ作業項目のまま再実行する操作。どの種別の作業項目にも使える。
 * Consoleの要対応の失敗には`failed`、`needs_human`、`expired`の作業項目が出るが、`blocked`は出ない。
 * 通知の文は状態によらず同じにするので、Windmillでの直接実行を案内する。
 */
const RETRY_WORK_ITEM_ACTION =
  "Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください";

/**
 * CI回で止めた理由のうち、一時的な理由(ドラフト、auto-merge)の案内。
 * 人は再実行も付け直しもしない。保留が解けるのを待つか、PRにpushする。
 * 待った後にFactoryが何かを始めるとは約束しない。pushして新しいheadになれば、新しい失敗として判定される。
 */
const CI_WAIT_ACTION =
  "保留が解けるまで待つか、PRにpushしてください。headが変わると、Factoryが新しい失敗として判定し直します";

/**
 * CI回で止めた理由のうち、同じheadでは評価し直さない理由の案内。
 * 作業項目を再実行しても、`factory:fix`を付け直しても、失敗の行は動かない。
 * PRにpushしてheadが変わると、`watch_pr_ci`が新しい失敗として判定し直す。
 */
const CI_PUSH_ACTION =
  "PRにpushしてください。headが変わると、Factoryが新しい失敗として判定し直します";

/**
 * 人が取る手順`procedure`の後に、通常回は再実行を、CI回は`ciFollowUp`(既定はPRへのpush)を続ける規則の次の操作。
 * `procedure`は「…てから、」のように、続きを受ける形で終える。
 * `suffix`は、再実行かCI回の続きの後ろに添える補足である。
 */
function procedureThenRerun(
  procedure: string,
  suffix = "",
  ciFollowUp = CI_PUSH_ACTION,
): Pick<ReasonRule, "nextAction" | "ciNextAction"> {
  return {
    nextAction: () => `${procedure}${RETRY_WORK_ITEM_ACTION}${suffix}`,
    ciNextAction: () => `${procedure}${ciFollowUp}${suffix}`,
  };
}

/**
 * 汎用の次の対応。より具体的な対応が無いときの既定にする。
 * 原因は通知の理由と、Consoleのシステム画面のnoticeに残る。
 * 取り除いた後の再実行は、どの種別の作業項目にも使える`retry_work_item`を案内する。
 */
const GENERIC_PROCEDURE =
  "通知の理由とConsoleのシステム画面で原因を確かめ、取り除いてから、";
const GENERIC_NEXT_ACTION = `${GENERIC_PROCEDURE}${RETRY_WORK_ITEM_ACTION}`;

const FACTORY_FIX_RELABEL_ACTION =
  "対応してほしい指摘をコメントしてから`factory:fix`を付け直してください";
const CHECK_COMMAND_NEXT_ACTION =
  "失敗しているチェックを確認し、人が修正してください";
const FORBIDDEN_CHANGE_NEXT_ACTION =
  "差分を確認し、問題なければ人が直接修正してください";
const DIFF_SIZE_PROCEDURE = "変更を分割するか、上限を見直してから";
const DIFF_SIZE_NEXT_ACTION = `${DIFF_SIZE_PROCEDURE}\`factory:fix\`を付け直してください`;
const DIFF_SIZE_CI_NEXT_ACTION = `${DIFF_SIZE_PROCEDURE}、${CI_PUSH_ACTION}`;
const AUTO_MERGE_PROCEDURE = "PRのauto-mergeを無効にしてから、";
const GITHUB_RATE_LIMIT_PROCEDURE = "GitHubのrate limitの解除を待ってから、";
const GITHUB_RATE_LIMIT_NEXT_ACTION = `${GITHUB_RATE_LIMIT_PROCEDURE}${RETRY_WORK_ITEM_ACTION}`;
/** `lib/github.ts`の`GitHubRateLimitError`のメッセージ。1はエンドポイント、2は待ちの説明。 */
const GITHUB_RATE_LIMIT_REASON_PATTERN = /^GitHub rate limit on (\S+): (.+)$/;
const DAILY_BUDGET_NEXT_ACTION =
  "翌日まで待つか、daily_budget_usdを引き上げてください";
const NOTHING_TO_COMMIT_NEXT_ACTION =
  "返信内容を確認し、必要なら指示をコメントして`factory:fix`を付け直してください";
const ISSUE_PROPOSAL_NEXT_ACTION =
  "Consoleの要対応で提案を承認または却下してください";

/**
 * 確かめる内容`check`の後に、フローごとの再実行を続けた次の操作を返す。
 * 実装フローは`retry_work_item`で同じ作業項目を再実行する。
 * pr_fixでこれを使う理由はどれも修正のClaudeを実行した後に止めるので、そのラウンドは使い終わっており、
 * 新しいラウンドとして`factory:fix`を付け直してもらう。
 * フローが分からなければ両方を並べる。
 */
function afterFixWorkRerun(
  check: string,
  flow: NextActionFlow | undefined,
): string {
  if (flow === "implement") return `${check}、${RETRY_WORK_ITEM_ACTION}`;
  if (flow === "pr_fix") return `${check}、\`factory:fix\`を付け直してください`;
  return `${check}、PRの修正なら\`factory:fix\`を付け直し、実装なら${RETRY_WORK_ITEM_ACTION}`;
}

const LOCAL_HEAD_CHECK =
  "検査コマンドがコミットやブランチの切り替えをしていないか確かめて人が直してから";

/** ローカルのHEADが動いたとき(実装フローとpr_fixの両方で起きる)の次の操作。 */
function localHeadNextAction(flow: NextActionFlow | undefined): string {
  return afterFixWorkRerun(LOCAL_HEAD_CHECK, flow);
}

const LEFTOVER_PROCESS_CHECK =
  "検査コマンドなどが残したプロセスがworktreeを書き換えていないか確かめ";

/** 検査やcommitの後にworktreeが変わったとき(実装フローとpr_fixの両方で起きる)の次の操作。 */
function leftoverProcessNextAction(flow: NextActionFlow | undefined): string {
  return afterFixWorkRerun(LEFTOVER_PROCESS_CHECK, flow);
}

/**
 * `afterFixWorkRerun`のCI回版。確かめる内容の後に、`factory:fix`の付け直しの代わりにPRへのpushを続ける。
 * `check`は「…てから」「…確かめ」のどちらの形でも、読点を挟んで続けられる。
 */
function ciAfterFixWorkRerun(check: string): string {
  return `${check}、${CI_PUSH_ACTION}`;
}

/**
 * 前の実行のプロセスがまだworktreeを使っているときの次の操作。
 * 実装フローの準備は同じ作業項目の前の実装のプロセスを止めてから続けるので、この理由で止まるのは、
 * pr_fixのプロセスや持ち主の分からないプロセスが残っているときである。pr_fixの準備は何も止めない。
 * どちらも、理由に載ったプロセスが終わるか止まるまで、再実行しても同じ理由で止まる。
 * workerの再起動は同じworkerのすべてのジョブを止めるので勧めず、載ったプロセスだけを止めてもらう。
 * 再実行はどちらのフローも`retry_work_item`にする。pr_fixで`factory:fix`を付け直すと、
 * 何も修正していないのに新しい作業項目で修正のラウンドを1つ使ってしまうため。
 */
const WORKTREE_BUSY_PROCEDURE =
  "理由に載ったプロセスが終わるのを待つか、workerのコンテナでそのプロセスを止めてから、";

const STALE_IMAGE_PROCEDURE =
  "ホストのcheckoutでgit pullし、mise installとmise run upでworkerのイメージを作り直してください";

/**
 * 検査用のユーザーからworktreeを取り戻せなかったときの次の操作。
 * 止まらないプロセス、残ったACL、読めない枠の記録のように、再実行しても同じ理由で止まる原因なので、
 * 人が枠の記録を確かめて所有権を戻してから再実行する。フローによらず同じ手順である。
 */
const OWNERSHIP_RESTORE_FAILED_PROCEDURE =
  "運用の文書(docs/operations.md)の「検査の枠の記録を片付ける」の手順で、枠の記録が指すworktreeをrootに戻して記録を消してから、";

/** pr_fixで、この実行が残したプロセスがworktreeのロックを持ち続けていたときに、人が取る手順。 */
const LOCK_HELD_PR_FIX_PROCEDURE =
  "検査コマンドが常駐プロセスを残していないか確かめ、残っていればworkerのコンテナで止めてから、";

/**
 * 実行中に、この実行の検査コマンドなどが残したプロセスがworktreeのロックを持ち続けていたときの次の操作。
 * 残ったプロセスは、この実行のジョブIDの持ち主タグを持つ。
 * 実装フローは再実行の準備がそれを止めてから続けるので、再実行するだけでよい。
 * pr_fixの準備は何も止めないので、先に人が止める必要がある。
 * 再実行は、修正のラウンドを使わない`retry_work_item`にする。
 */
function worktreeLockHeldInRunNextAction(
  flow: NextActionFlow | undefined,
): string {
  if (flow === "design")
    return `設計のClaudeが残したプロセスがないか確かめ、残っていればworkerのコンテナで止めてから、${RETRY_WORK_ITEM_ACTION}(設計の準備は何も止めません)`;
  if (flow === "implement")
    return `検査コマンドが常駐プロセスを残していないか確かめてから、${RETRY_WORK_ITEM_ACTION}(残ったプロセスは再実行の準備ステップが止めます)`;
  if (flow === "pr_fix")
    return `${LOCK_HELD_PR_FIX_PROCEDURE}${RETRY_WORK_ITEM_ACTION}`;
  return `検査コマンドが常駐プロセスを残していないか確かめ、PRの修正なら残ったプロセスをworkerのコンテナで止めてから、${RETRY_WORK_ITEM_ACTION}(実装なら残ったプロセスは再実行の準備ステップが止めます)`;
}

/** 理由の接頭辞(正規表現の特殊文字を含みうる)で始まる理由に一致する正規表現を返す。末尾に`tail`を続ける。 */
function reasonPattern(prefix: string, tail: string): RegExp {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${tail}`);
}

/** マージの保留を読めなかった理由ごとの、原因の説明と次の操作。 */
const HOLD_UNREADABLE_TEXT: ReadonlyMap<
  string,
  { readonly cause: string; readonly next: string }
> = new Map([
  [
    "missing_table",
    {
      cause: "保留の表がないため",
      next: "保留の表を作るmigrationが反映済みか、デプロイの記録で確認してください。その後PRを確認して手でマージしてください。この作業項目は再実行できません",
    },
  ],
  [
    "read_failed",
    {
      cause: "保留の表を読めなかったため",
      next: "DBが動いているか確認し、`mise run hold:list`で保留を読めるか確かめてください。その後PRを確認して手でマージしてください。この作業項目は再実行できません",
    },
  ],
  [
    "corrupt",
    {
      cause: "保留の表に壊れた行があるため",
      next: "`mise run hold:list`で壊れた行を確認し、psqlでその行を解除か削除してください。回復の手順は保留の内部仕様にあります。その後PRを確認して手でマージしてください。この作業項目は再実行できません",
    },
  ],
  [
    "error",
    {
      cause: "保留の読み取りで予期しない失敗があったため",
      next: "workerのログで原因を確認し、`mise run hold:list`で保留を読めるか確かめてください。その後PRを確認して手でマージしてください。この作業項目は再実行できません",
    },
  ],
]);

function holdUnreadableText(failure: string | undefined): {
  readonly cause: string;
  readonly next: string;
} {
  return (
    HOLD_UNREADABLE_TEXT.get(failure ?? "") ?? {
      cause: "保留を確認できなかったため",
      next: DEPENDABOT_MANUAL_NEXT_ACTION,
    }
  );
}

/**
 * dependabotの作業項目を、自動で処理できず人に回すときの次の操作。
 * dependabotの作業項目は`retry_work_item`が拒否するので、再実行は案内しない。
 * 新しいコミットが積まれると、取得が新しいheadの別の作業項目として拾う。
 */
const DEPENDABOT_MANUAL_NEXT_ACTION =
  "PRの内容を人が確認し、問題なければ手でマージするか閉じてください。この作業項目は再実行できません。新しいコミットが積まれると、自動で再び対象になります";
const DEPENDABOT_IMPACT_NEXT_ACTION =
  "PRのコメントの所見を確認し、問題なければ手でマージするか閉じてください。この作業項目は再実行できません。新しいコミットが積まれると、自動で再び対象になります";

/**
 * リポジトリのオーナーの数値IDの照合に落ちた理由(`isRepoOwnerStopReason`)で人に回すときの次の操作。
 * 名前が別の人に渡った疑いで止めたPRなので、手でマージする案内にしない。
 * dependabotの作業項目は`retry_work_item`が拒否するので、再実行は案内しない。
 */
const DEPENDABOT_OWNER_STOP_NEXT_ACTION =
  "GitHubでそのオーナーとリポジトリが意図した持ち主のものか確かめ、factory_configのownersとfactory_repo_idを見直してください。確かめるまで、このPRをマージしないでください。持ち主が変わっていたら、現在のIDを書き写さずに、そのオーナーをownersから外してください。この作業項目は再実行できません。見直した後に新しいコミットが積まれると、自動で再び対象になります";

/** 詳細が関門の理由なら日本語に訳し、そうでなければそのまま返す。 */
function dependabotDetailText(detail: string | undefined): string {
  if (detail === undefined) return "";
  return isRepoOwnerStopReason(detail) ? describeReason(detail) : detail;
}

/** 詳細が関門の理由なら、オーナーの見直しの案内を、そうでなければ手でマージする案内を返す。 */
function dependabotNextActionForDetail(detail: string | undefined): string {
  return detail !== undefined && isRepoOwnerStopReason(detail)
    ? DEPENDABOT_OWNER_STOP_NEXT_ACTION
    : DEPENDABOT_MANUAL_NEXT_ACTION;
}

/**
 * dependabotの理由の規則(`lib/dependabot_flow_support.ts`の`dependabotReason`と固定の理由)。
 * 詳細にほかの規則の文字列が入りうるので、`REASON_RULES`の先頭に置き、ほかの規則より先に当てる。
 * どの規則も再実行を案内しない。dependabotの作業項目は`retry_work_item`が拒否するため。
 */
const DEPENDABOT_REASON_RULES: readonly ReasonRule[] = [
  {
    pattern: reasonPattern(DEPENDABOT_REASON_PREFIX.gate, "([\\s\\S]+)$"),
    describe: (m) =>
      `dependabotの更新が、自動でマージする条件を満たしていません(${m[1]})`,
    nextAction: () => DEPENDABOT_MANUAL_NEXT_ACTION,
  },
  {
    pattern: reasonPattern(DEPENDABOT_REASON_PREFIX.collect, "([\\s\\S]+)$"),
    describe: (m) =>
      `dependabotの更新の検査に必要な情報を集められませんでした(${m[1]})`,
    nextAction: () => DEPENDABOT_MANUAL_NEXT_ACTION,
  },
  {
    pattern: reasonPattern(
      DEPENDABOT_REASON_PREFIX.installFailed,
      "([\\s\\S]+)$",
    ),
    describe: (m) =>
      `dependabotの更新の依存を、隔離した環境でインストールできませんでした(${m[1]})`,
    nextAction: () => DEPENDABOT_MANUAL_NEXT_ACTION,
  },
  {
    pattern: reasonPattern(DEPENDABOT_REASON_PREFIX.localCheck, "([\\s\\S]+)$"),
    describe: (m) =>
      `dependabotの更新を、インストールした後の確認で止めました(${m[1]})`,
    nextAction: () => DEPENDABOT_MANUAL_NEXT_ACTION,
  },
  // `decideImpactOutcome`が返す2つの理由は、件数を訳に含める。
  {
    pattern: reasonPattern(
      DEPENDABOT_REASON_PREFIX.impact,
      "(\\d+) supply chain concern",
    ),
    describe: (m) =>
      `dependabotの更新の影響調査で、サプライチェーンの懸念が${m[1]}件報告されました`,
    nextAction: () => DEPENDABOT_IMPACT_NEXT_ACTION,
  },
  {
    pattern: reasonPattern(
      DEPENDABOT_REASON_PREFIX.impact,
      "(\\d+) unverified item",
    ),
    describe: (m) =>
      `dependabotの更新の影響調査で、未確認の項目が${m[1]}件残っています`,
    nextAction: () => DEPENDABOT_IMPACT_NEXT_ACTION,
  },
  {
    pattern: reasonPattern(DEPENDABOT_REASON_PREFIX.impact, "([\\s\\S]+)$"),
    describe: (m) =>
      `dependabotの更新の影響調査で、人の確認が必要と判断しました(${m[1]})`,
    nextAction: () => DEPENDABOT_IMPACT_NEXT_ACTION,
  },
  {
    pattern: reasonPattern(DEPENDABOT_REASON_PREFIX.assess, "([\\s\\S]+)$"),
    describe: (m) =>
      `dependabotの更新の影響調査を、最後まで行えませんでした(${m[1]})`,
    nextAction: () => DEPENDABOT_MANUAL_NEXT_ACTION,
  },
  {
    pattern: reasonPattern(DEPENDABOT_REASON_PREFIX.prepare, "([\\s\\S]+)$"),
    describe: (m) =>
      `dependabotの更新を、準備の処理(リポジトリの取得と作業ツリーの作成)で止めました(${dependabotDetailText(m[1])})`,
    nextAction: (m) => dependabotNextActionForDetail(m[1]),
  },
  {
    pattern: reasonPattern(DEPENDABOT_REASON_PREFIX.finish, "([\\s\\S]+)$"),
    describe: (m) =>
      `dependabotの更新を、終了の処理(マージや所見の投稿)で止めました(${dependabotDetailText(m[1])})`,
    nextAction: (m) => dependabotNextActionForDetail(m[1]),
  },
  {
    pattern: reasonPattern(DEPENDABOT_REASON_PREFIX.poll, "([\\s\\S]+)$"),
    describe: (m) =>
      `dependabotの更新を、PRを取得する処理で人に回しました(${dependabotDetailText(m[1])})`,
    nextAction: (m) => dependabotNextActionForDetail(m[1]),
  },
  {
    pattern: reasonPattern(DEPENDABOT_DRY_RUN_REASON, ""),
    describe: () =>
      "dry run: dependabotの更新をマージ可と判定しました。試運転のため、マージしていません",
    nextAction: () =>
      "このPRは、確認して手でマージしてください。dependabot_merge_enabledを有効にしても、このPRは再評価されません。この作業項目は再実行できません",
  },
  {
    pattern: reasonPattern(DEPENDABOT_MERGE_FORBIDDEN_REASON, ""),
    describe: () => "dependabotの更新をマージする権限がありませんでした(403)",
    nextAction: () =>
      "PATのマージ権限とrulesetのbypassを確認し、手でマージしてください",
  },
  {
    pattern: reasonPattern(DEPENDABOT_MERGE_HELD_REASON, ""),
    describe: () =>
      "dependabotの更新を、マージの保留があるため自動ではマージしませんでした",
    nextAction: () =>
      "`mise run hold:list`で保留の理由と期限を確認してください。解除してよければ`mise run hold:release -- <id>`を実行し、その後PRを確認して手でマージしてください。保留を解いても、この作業項目は再開せず、再実行もできません。dependabotがrebaseして新しいコミットが積まれると、自動で再び対象になります",
  },
  {
    pattern: reasonPattern(
      DEPENDABOT_HOLD_UNREADABLE_PREFIX,
      "(missing_table|read_failed|corrupt|error)$",
    ),
    describe: (m) =>
      `dependabotの更新を、${holdUnreadableText(m[1]).cause}自動ではマージしませんでした(${m[1] ?? ""})`,
    nextAction: (m) => holdUnreadableText(m[1]).next,
  },
  {
    pattern: reasonPattern(DEPENDABOT_MERGE_REFUSED_REASON, ""),
    describe: () => "GitHubがdependabotの更新のマージを拒否しました(405)",
    nextAction: () => "マージできない理由(競合や保護)を確認してください",
  },
  {
    pattern: reasonPattern(DEPENDABOT_RESULT_UNKNOWN_REASON, ""),
    describe: () => "dependabotの更新のマージ結果を確認できませんでした",
    nextAction: () =>
      "PRがマージ済みかを確認してください。未マージなら内容を確認し、手でマージするか閉じてください。この作業項目は再実行できません",
  },
  {
    pattern: reasonPattern(
      `${DEPENDABOT_TIMEOUT_MISFIT_REASON}: `,
      "([\\s\\S]+)$",
    ),
    describe: (m) =>
      `dependabotの時間設定が、flow.yamlの影響調査ステップのtimeoutに収まりません(${m[1]})`,
    nextAction: () =>
      "claude_timeout_secを減らしてください。この作業項目は再実行できないので、PRは人が確認して手でマージするか閉じてください",
  },
];

/**
 * CIの失敗を直す回(CI回)を止めた理由の次の操作のうち、保留の理由に写せない理由の既定。
 * CI回は手動でも自動でも再開しない。`watch_pr_ci`は、止めた作業項目の行を同じheadでは評価し直さない。
 */
const CI_ROUND_NEXT_ACTION = `原因を確かめて人が直してから、${CI_PUSH_ACTION}`;

/**
 * 時間設定が修正・検証ステップのtimeoutに収まらない回の、CI回での次の操作。
 * 起動の前に`watch_pr_ci`が同じ設定を確かめ、収まらない間は起動しない。
 * 設定を直せば、止まった行は保留なしで戻り、pushなしで次の巡回で起動し直すので、pushは案内しない。
 */
const TIME_SETTINGS_CI_NEXT_ACTION =
  "claude_timeout_secか検査コマンド(allowed_check_commands)の数を減らしてください。直すと、Factoryが次の巡回で自動で起動し直します";

/**
 * リポジトリが許可リストに無くて止まったCI回の次の操作。
 * 失敗の行は保留なしで戻り、設定が直れば、監視が次の巡回で起動し直すのでpushは要らない。
 * ただし、設定から外れたリポジトリの行は、最初に失敗を見てから24時間たつと閉じるので、その後はpushが要る。
 */
const REPO_NOT_ALLOWED_CI_NEXT_ACTION =
  "factory_configのowners / repo_allowlistを見直してください。直すと、Factoryが次の巡回で自動で起動し直します。最初に失敗を見てから24時間たった行は閉じるので、そのときはPRにpushしてください";

/**
 * テストの行を減らす変更で、PRが足した行かを調べられなかったCI回の、次の操作。
 * 一時的な失敗は例外になって回復が戻すので、ここへ来るのは、待っても変わらない原因である。
 * 原因は、PRが既定のブランチを向いていない、テストの差分が大きすぎるか読めない、のどれかである。
 */
const TEST_BASE_UNKNOWN_CI_NEXT_ACTION = `PRが既定のブランチを向いているかと、テストの差分が大きすぎないかを確かめ、人が直してから、${CI_PUSH_ACTION}`;

/**
 * 修正の前に止めた理由の次の操作。保留の理由(`fix_hold_reason`)に写せる理由は、その理由の敬体の固定文(`stopAction`)を使う。
 * 写せない理由は、`CI_ROUND_NEXT_ACTION`にする。
 * `match.input`は、規則が一致した理由の1項目である。
 */
function ciRoundStopAction(match: RegExpMatchArray): string {
  if (match.input?.startsWith(CI_TEST_BASE_UNKNOWN_REASON_PREFIX)) {
    return TEST_BASE_UNKNOWN_CI_NEXT_ACTION;
  }
  if (match.input?.startsWith(ciRoundReason(CI_ROUND_DETAILS.timeMisfit))) {
    return TIME_SETTINGS_CI_NEXT_ACTION;
  }
  const hold = holdReasonForStoppedItem(match.input ?? null);
  return hold === null
    ? CI_ROUND_NEXT_ACTION
    : prCiFixHoldInfo(hold).stopAction;
}

/**
 * 承認済みの要件定義のディレクトリが、承認時の内容と違う、または無いときの次の操作。
 * 基準値が残るので、同じ作業項目を再実行しても同じ検出で止まる。新しいサイクルで要件定義を作り直す。
 */
const REQUIREMENTS_UNTRUSTED_NEXT_ACTION =
  "承認済みの要件定義のディレクトリを確かめ、`factory`ラベルを付け直して要件定義を作り直してください(この作業項目を再実行しても同じ理由で止まります)";

/**
 * 設計工程が`needs_human`にする理由の規則。理由の文字列は`lib/doc_tree_hash.ts`、`lib/design_template.ts`、
 * `lib/design_launch_support.ts`の定数と関数が作る文字列と同じにする。
 * この表は設計の定数をimportしない。importするとpr_workflow_support.tsの依存が増えるため、文字列をここに直接書く。
 * `tests/scripts/pr_workflow_support_design.test.ts`が、定数と関数の出力を表と突き合わせて食い違いを検出する。
 */
const DESIGN_REASON_RULES: readonly ReasonRule[] = [
  {
    pattern: /^design flow could not be started(?:: ([\s\S]+))?$/,
    describe: (m) =>
      m[1] === undefined
        ? "設計フローを起動できませんでした"
        : `設計フローを起動できませんでした(${m[1]})`,
    nextAction: () => GENERIC_NEXT_ACTION,
  },
  {
    pattern: /^design requires approved requirements for attempt (\d+)$/,
    describe: (m) =>
      `要件定義の試行${m[1]}回目に承認済みの要件定義が無いため、設計を始められませんでした`,
    nextAction: () =>
      "Consoleで要件定義の承認の状態を確かめ、承認が無ければ`factory`ラベルを付け直して要件定義を作り直してください",
  },
  {
    pattern: /^design requirements_gap after max_attempts (\d+)$/,
    describe: (m) =>
      `設計が要件の不足を報告しましたが、要件定義の試行回数が上限(${m[1]})に達しました`,
    nextAction: () =>
      "要件を人が整理し、Issueに追記してから`factory`ラベルを付け直してください",
  },
  {
    pattern: /^approved requirements were modified before design$/,
    describe: () =>
      "承認済みの要件定義のディレクトリが、設計を始める前に承認時の内容と異なっていました",
    nextAction: () => REQUIREMENTS_UNTRUSTED_NEXT_ACTION,
  },
  {
    pattern: /^approved requirements were modified during design$/,
    describe: () =>
      "承認済みの要件定義のディレクトリが、設計の実行中に書き換わりました",
    nextAction: () => REQUIREMENTS_UNTRUSTED_NEXT_ACTION,
  },
  {
    pattern: /^approved requirements were modified before implementation$/,
    describe: () =>
      "承認済みの要件定義のディレクトリが、実装の準備かClaudeの実行の前後で承認時の内容と異なっていました",
    nextAction: () => REQUIREMENTS_UNTRUSTED_NEXT_ACTION,
  },
  {
    pattern: /^approved requirements directory is missing$/,
    describe: () =>
      "承認済みの要件定義のディレクトリがありません(workerやボリュームを作り直した可能性があります)",
    nextAction: () => REQUIREMENTS_UNTRUSTED_NEXT_ACTION,
  },
  {
    pattern: /^design document directory already holds a saved draft$/,
    describe: () =>
      "同じ試行の設計書の下書きが保存済みのため、図を消さないように設計書の生成を止めました",
    nextAction: () =>
      `Consoleで保存済みの設計書の下書きを確かめてから、${RETRY_WORK_ITEM_ACTION}`,
  },
];

export const REASON_RULES: readonly ReasonRule[] = [
  // CI回の理由は`ci round`で始まる(`lib/ci_fix_round.ts`)。接頭辞の後ろに、`: 固定の文`か
  // ` change not allowed (種類): パス`が続く。ほかの規則に先に当たらないよう、先頭に置く。
  {
    pattern: reasonPattern(CI_ROUND_REASON_PREFIX, "(?:: | )([\\s\\S]+)$"),
    describe: (m) => `CIの失敗を直す回を止めました(${m[1]})`,
    nextAction: (m) => ciRoundStopAction(m),
  },
  ...DEPENDABOT_REASON_RULES,
  // 稼働中のIssueの部分一意インデックス(`work_items_active_issue_key`)への違反。
  // `approved`から`implementing`への移行が阻まれたときに、`cas_failed`の理由として現れる。
  // 同じIssueの別の作業項目が現在のサイクルなので、この作業項目は再開できない。
  {
    pattern: /work_items_active_issue_key/,
    describe: () => "同じIssueで、別のサイクルが稼働中です",
    nextAction: () =>
      "操作は要りません。この作業項目は再開できないので、このIssueの現在のサイクルの作業項目に従ってください",
  },
  // pr_fix_prepare.tsの`evaluatePrFixSafetyGuards` / `evaluateRepoAllowedGuard`。
  // 準備の関門は修正の前に`blocked`で止めるので、再実行は修正のラウンドを使わない`retry_work_item`にする。
  {
    pattern: /^pull request is not open$/,
    describe: () => "PRがオープンではありません",
    nextAction: () => "PRを再オープンするか、この作業を取り下げてください",
  },
  {
    pattern: /^head repository differs from base repository \(fork PR\)$/,
    describe: () => "headリポジトリとbaseリポジトリが異なります(fork PR)",
    nextAction: () =>
      "forkではなく同一リポジトリのブランチからPRを作り直してください",
  },
  {
    pattern: /^pull request is a draft$/,
    describe: () => "PRがドラフトです",
    ...procedureThenRerun("ドラフトを解除してから、", "", CI_WAIT_ACTION),
  },
  {
    pattern: /^head branch is the default branch$/,
    describe: () => "headブランチがデフォルトブランチです",
    nextAction: () =>
      "Factoryは修正をpushしません。人が直すか、作業用のブランチからPRを作り直してください",
  },
  {
    pattern: /^head branch is protected$/,
    describe: () => "headブランチが保護されています",
    nextAction: () =>
      "Factoryは修正をpushしません。人が直すか、作業用のブランチからPRを作り直してください",
  },
  {
    pattern: /^head branch has rules$/,
    describe: () => "headブランチに適用されるrulesetのruleがあります",
    nextAction: () =>
      "Factoryは修正をpushしません。人が直すか、作業用のブランチからPRを作り直してください",
  },
  {
    pattern: /^pull request has auto-merge enabled$/,
    describe: () => "PRのauto-mergeが有効です",
    nextAction: () =>
      `${AUTO_MERGE_PROCEDURE}あらためて\`factory:fix\`ラベルを付けてください`,
    ciNextAction: () => `${AUTO_MERGE_PROCEDURE}${CI_WAIT_ACTION}`,
  },
  {
    pattern: /^head branch state is unavailable$/,
    describe: () => "headブランチの状態を読めませんでした",
    nextAction: () => RETRY_WORK_ITEM_ACTION,
  },
  // 現在の関門は返さないが、DBに残る過去の理由を表示するために残す。
  {
    pattern: /^base branch is protected$/,
    describe: () => "baseブランチが保護されています",
    nextAction: () => RETRY_WORK_ITEM_ACTION,
  },
  {
    pattern:
      /^repository is not allowed by factory_config \(owners \/ repo_allowlist\)$/,
    describe: () =>
      "factory_config(owners / repo_allowlist)で許可されていないリポジトリです",
    nextAction: () =>
      "factory_configのowners / repo_allowlistを見直してください",
    ciNextAction: () => REPO_NOT_ALLOWED_CI_NEXT_ACTION,
  },
  // `lib/repo_owner_gate.ts`の`verifyRepoOwnerId`。各準備のステップが、リポジトリを取得する前に止める。
  {
    pattern:
      /^repository owner id differs from factory_config owners: (\S+) \(expected (\d+), actual (\d+)\)$/,
    describe: (m) =>
      `リポジトリ${m[1]}のオーナーのIDが、factory_configのownersのID ${m[2]}と食い違います(現在のID ${m[3]})`,
    ...procedureThenRerun(
      "GitHubでそのオーナーが意図した持ち主か確かめ、factory_configのownersの名前かidを見直してから、",
    ),
  },
  {
    pattern: /^repository owner is not in factory_config owners: (\S+)$/,
    describe: (m) =>
      `リポジトリ${m[1]}のオーナーが、factory_configのownersにありません`,
    ...procedureThenRerun("factory_configのownersを見直してから、"),
  },
  {
    pattern: /^factory repository id check failed: (\S+)$/,
    describe: (m) =>
      `Factory自身のリポジトリ${m[1]}のIDを、factory_configのfactory_repo_idと照合できません`,
    ...procedureThenRerun(
      "factory_configのfactory_repoとfactory_repo_idを見直してから、",
    ),
  },
  {
    pattern:
      /^repository not found while checking the owner id in factory_config owners: (\S+) \(expected (\d+)\)$/,
    describe: (m) =>
      `リポジトリ${m[1]}がGitHubで見つかりません(factory_configのownersのID ${m[2]})`,
    ...procedureThenRerun(
      "リポジトリの削除、オーナーの改名、PATの権限を確かめ、factory_configのownersの名前とidを見直してから、",
    ),
  },
  // pr_fix_prepare.tsの`evaluateFixRoundGuard`(round_exhausted)
  {
    pattern: /^fix_round (\d+) exceeds max_fix_rounds (\d+)$/,
    describe: (m) => `fix_round ${m[1]}がmax_fix_rounds ${m[2]}を超えました`,
    nextAction: () => "残りの指摘は人が対応するか、上限を見直してください",
  },
  // pr_fix_collect.ts(no_feedback)
  {
    pattern:
      /^no actionable feedback since the last processed review\/comment$/,
    describe: () =>
      "前回処理したレビュー・コメント以降、対応可能なフィードバックがありません",
    nextAction: () => FACTORY_FIX_RELABEL_ACTION,
  },
  // pr_fix_verify.tsの`detectForbiddenChanges` / `detectEscapingSymlinks` /
  // `detectSymlinkChanges` / `evaluateDiffSizeGuard`
  // (禁止パス、symlink_change、差分の大きさ)
  {
    pattern: /^forbidden path changed: (.+)$/,
    describe: (m) => `変更が禁止されたパスです: ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^new shell script added: (.+)$/,
    describe: (m) => `新しいシェルスクリプトが追加されました: ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^package\.json "scripts" field changed$/,
    describe: () => "package.jsonの`scripts`が変更されました",
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^symlink escapes the worktree: (.+) -> (.+)$/,
    describe: (m) =>
      `シンボリックリンクがworktreeの外を指しています: ${m[1]} -> ${m[2]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^symlink_change: symlink changed: (.+)$/,
    describe: (m) =>
      `symlink_change: シンボリックリンクが変更されました: ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern:
      /^symlink_change: file type changed \(possible symlink conversion\): (.+)$/,
    describe: (m) =>
      `symlink_change: ファイル種別が変更されました(シンボリックリンクへの変換の可能性): ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^changed file count (\d+) exceeds (\S+) (\d+)$/,
    describe: (m) => `変更ファイル数${m[1]}が${m[2]} ${m[3]}を超えました`,
    nextAction: () => DIFF_SIZE_NEXT_ACTION,
    ciNextAction: () => DIFF_SIZE_CI_NEXT_ACTION,
  },
  {
    pattern: /^diff line total (\d+) exceeds (\S+) (\d+)$/,
    describe: (m) => `diffの総行数${m[1]}が${m[2]} ${m[3]}を超えました`,
    nextAction: () => DIFF_SIZE_NEXT_ACTION,
    ciNextAction: () => DIFF_SIZE_CI_NEXT_ACTION,
  },
  // pr_fix_apply.ts、pr_fix_verify.ts、pipeline_generate.ts、
  // pr_review_generate.tsの日次予算の検査(予算超過)
  {
    pattern: /^daily budget exceeded \(\$([\d.]+) >= \$([\d.]+)\)$/,
    describe: (m) =>
      `1日あたりのClaude利用予算の上限に達しました($${m[1]} >= $${m[2]})`,
    nextAction: () => DAILY_BUDGET_NEXT_ACTION,
  },
  {
    pattern: /^daily budget exceeded$/,
    describe: () => "1日あたりのClaude利用予算の上限に達しました",
    nextAction: () => DAILY_BUDGET_NEXT_ACTION,
  },
  // pr_fix_finish.tsのpushと再試行の結果(head_changedなど)
  {
    pattern: /^PR head moved to (\S+) while the fix was in progress$/,
    describe: (m) => `修正の実行中にPRのheadが${m[1]}に変わりました`,
    nextAction: () =>
      "最新のheadを確認し、必要なら`factory:fix`を付け直してください",
  },
  // implementフローのpush。`workflow`スコープの無いfine-grained PATでは、
  // `.github/workflows/**`に触れるコミットをpushできない。
  // GitHubの拒否の文はgitのstderrの中にあり、理由にはpushのエラー全体が入るので、
  // このパターンは意図して先頭と末尾に固定しない。
  {
    pattern:
      /refusing to allow a Personal Access Token to create or update workflow/,
    describe: () =>
      "PATに`workflow`スコープが無いため、`.github/workflows/**`を含むpushが拒否されました",
    nextAction: () =>
      "PATにWorkflows(Read and write)権限を追加するか、ワークフローファイルの変更を人がpushしてください",
  },
  {
    pattern: /^check-fix retry pass failed \((.+)\): (.+)$/,
    describe: (m) =>
      `チェック失敗後の自動修正リトライに失敗しました(${m[1]}): ${m[2]}`,
    nextAction: () => CHECK_COMMAND_NEXT_ACTION,
  },
  {
    pattern: /^repository checks still failing after one automated fix retry$/,
    describe: () => "自動修正の再試行後もリポジトリのチェックに失敗しています",
    nextAction: () => CHECK_COMMAND_NEXT_ACTION,
  },
  {
    pattern: /^done outcome missing a commit message$/,
    describe: () =>
      "完了と報告されましたが、コミットメッセージがありませんでした",
    nextAction: () => "もう一度`factory:fix`を付け直してください",
  },
  // pr_fix_finish.tsの`nothing_to_commit`の分岐は溜めた返信も投稿するので、
  // Discordの理由には両方を記録する。`describeReason`は`"; "`でつないだ一覧を
  // 項目ごとに再帰的に訳すので、ここでは各項目に別々に一致させる。
  // その理由では"no changes to commit"が常に"replies posted"より前にあり、
  // 両者の次の対応も同じなので、`nextActionFor`は最初の項目の対応だけを使えばよい。
  {
    pattern: /^no changes to commit$/,
    describe: () => "コミットする変更がありませんでした",
    nextAction: () => NOTHING_TO_COMMIT_NEXT_ACTION,
  },
  {
    pattern: /^replies posted$/,
    describe: () => "返信は投稿済みです",
    nextAction: () => NOTHING_TO_COMMIT_NEXT_ACTION,
  },
  // pr_fix_finish.tsの`buildIssueProposalReason`。すでに日本語なので、
  // `describe()`はそのまま返す。この規則は、`nextActionFor`が汎用の既定ではなく
  // Consoleの要対応を案内するためにある。
  {
    pattern: /^Issue化の提案が(\d+)件あります$/,
    describe: (m) => `Issue化の提案が${m[1]}件あります`,
    nextAction: () => ISSUE_PROPOSAL_NEXT_ACTION,
  },
  {
    pattern: /^needs human attention$/,
    describe: () => "人による対応が必要です",
    ...procedureThenRerun(GENERIC_PROCEDURE),
  },
  {
    pattern: /^safety guard failed$/,
    describe: () => "安全性ガードに失敗しました",
    ...procedureThenRerun(GENERIC_PROCEDURE),
  },
  // pr_fix_finish.tsの`evaluateRerouteGuard`(親に`issue_number`が無い)
  {
    pattern: /^parent work item has no issue_number$/,
    describe: () => "親のwork itemにissue_numberがありません",
    nextAction: () => "work itemの状態をConsoleで確認してください",
  },
  // pr_fix_finish.tsが使う`evaluateRerouteParentStatus`と`rerouteParentChangedReason`。
  // どれも修正のClaudeがrequirements_gapを返した後に止めるので、そのラウンドは使い終わっている。
  // 準備で止めた理由と違い、新しいラウンドとして`factory:fix`を付け直してもらう。
  // 実装中の規則を、状態名を取る規則より先に置く。
  {
    pattern:
      /^parent work item (\d+) \(issue #(\d+)\) is being implemented, requirements_gap not rerouted$/,
    describe: (m) =>
      `親Issue #${m[2]}(作業項目${m[1]})が実装中のため、要件定義への差し戻しを止めました`,
    nextAction: () =>
      "実装フローの完了を待ってから再度`factory:fix`を付けてください",
  },
  {
    pattern:
      /^parent work item (\d+) \(issue #(\d+)\) is ([a-z_]+), requirements_gap not rerouted$/,
    describe: (m) =>
      `親Issue #${m[2]}(作業項目${m[1]})の状態が${m[3]}のため、要件定義への差し戻しを止めました`,
    nextAction: () =>
      "Consoleで親Issueの作業項目の状態を確認し、要件定義が承認された後に`factory:fix`を付け直してください",
  },
  // 下のimplementフローの`requirements_gap after max_attempts`と同じ対応を、修正するPRではなく親Issueに対して行うよう案内する。
  {
    pattern:
      /^parent work item (\d+) \(issue #(\d+)\) used up max_attempts (\d+), requirements_gap not rerouted$/,
    describe: (m) =>
      `親Issue #${m[2]}(作業項目${m[1]})は要件定義の試行回数が上限(${m[3]})に達しているため、要件定義への差し戻しを止めました`,
    nextAction: () =>
      "不足している要件を人が整理して親Issueに追記し、親Issueに`factory`ラベルを付け直してください",
  },
  // 比較交換に負けるのは、読み取った後に親が要件定義の作り直しか実装へ進んだときである。
  // 次の`poll_prs`は承認以降の親だけを結び付け、`pr_fix_prepare`は親が実装中なら止まるので、両方を待つよう案内する。
  {
    pattern:
      /^parent work item (\d+) \(issue #(\d+)\) changed before the requirements_gap reroute$/,
    describe: (m) =>
      `差し戻す前に親Issue #${m[2]}(作業項目${m[1]})の状態が変わったため、要件定義への差し戻しを止めました`,
    nextAction: () =>
      "親Issueの要件定義が承認され、実装フローが終わった後に`factory:fix`を付け直してください",
  },
  // requirements_apply.tsの差し戻し・needs_humanの結果と、
  // poll_issues.tsの期限切れの掃除
  {
    pattern: /^rejected (\d+) times$/,
    describe: (m) => `${m[1]}回連続で差し戻されました`,
    nextAction: () =>
      "要件を人が整理し、Issueに追記してから`factory`ラベルを付け直してください",
  },
  // poll_issues.tsの`registerClaimedIssue`。取得でトリガーラベルは外れ、作業項目は無い。
  // 作業項目が無いので、再実行の`retry_work_item`ではなくラベルの付け直しで拾い直す。
  {
    pattern: /^claimed issue could not be registered$/,
    describe: () => "Issueを取得しましたが、作業項目を登録できませんでした",
    nextAction: () =>
      "原因をConsoleの要対応かジョブのログで確かめて取り除き、Issueに`factory`ラベルを付け直してください",
  },
  // poll_issues.tsの`claimIssueWithNotice`。ラベルの削除が応答の無い失敗かサーバーエラーで終わり、
  // 読み直しでも自分が外したか判断できなかった。ラベルは無く、作業項目が始まっているかも分からない。
  // この表は設定を受け取れないので、ラベル名は既定の`factory`で書く(ほかの行も同じ)。
  {
    pattern: /^claim ownership could not be determined$/,
    describe: () =>
      "ラベルの削除の結果を確かめられず、Issueを取得できたか分かりません",
    nextAction: () =>
      "Consoleの作業項目で、このIssueの作業が始まっているか確かめてください。始まっていなければ、Issueに`factory`ラベルを付け直してください",
  },
  // poll_prs.tsの`claimPr`。トリガーラベルを外した後に取得を確認できず、
  // ラベルを付け直せなかったか、レート制限で付け直さなかった。ラベルは外れたままで、作業項目も無い。
  // 作業項目が無いので、再実行ではなくラベルの付け直しで拾い直す。
  // ラベル名は`factory:review`と`factory:fix`の既定で書く(ほかの行と同じ)。
  {
    pattern: /^claimed pr trigger label was left removed$/,
    describe: () =>
      "PRのトリガーラベルを外した後に取得を確認できず、ラベルが外れたままです",
    nextAction: () =>
      "PRにラベルが既に付いていないか、Consoleで同じPRのpr_reviewかpr_fixが始まっていないかを確かめてください。始まっていなければ、GitHubのレート制限などが解けるのを待ってから、外れたほうの`factory:review`か`factory:fix`ラベルを付け直してください",
  },
  {
    pattern: /^approval timed out$/,
    describe: () => "承認がタイムアウトしました",
    nextAction: () => "Consoleの要対応で承認または却下してください",
  },
  // pr_fix_finish.tsのpush後のレビュアー依頼の結果(`reportReviewerRequest`の`note`で、
  // 作業項目の`status_reason`に残す文)。
  // この3つはどれも`needs_human`の通知にはもう届かない。
  // skipped_emptyと候補なしは通知を出さず、失敗は`pr_fixed`のイベントの`note`の
  // フィールドに含める(`pr_fix_finish.ts`を参照)。
  // そのためこれらの`nextAction`は、実際のDiscordの通知ではなく、
  // `describeReason` / `nextActionFor`を直接呼ぶ経路(テストなど)でだけ使われる。
  {
    pattern:
      /^no reviewers to request \(default_reviewers empty and no fallback reviewer authors\)$/,
    describe: () =>
      "リクエストするレビュアーがいません(default_reviewersが空で、フォールバックの候補者もいません)",
    nextAction: () =>
      "default_reviewersを設定するか、レビュー履歴を確認してください",
  },
  {
    pattern: /^failed to request reviewers: (.+)$/,
    describe: (m) => `レビュアーのリクエストに失敗しました: ${m[1]}`,
    nextAction: () =>
      "GitHubのレビュアー設定を確認し、必要なら再度`factory:fix`を付け直してください",
  },
  {
    pattern:
      /^requested reviewers were all excluded \(PR author \/ factory viewer\)$/,
    describe: () =>
      "リクエスト対象のレビュアーが全員除外されました(PR作成者 / factory自身)",
    nextAction: () =>
      "default_reviewersにPR作成者以外のレビュアーを設定してください",
  },
  {
    pattern: /^could not request re-review: (.+)$/,
    describe: (m) =>
      `再レビューをリクエストできませんでした: ${describeReason(m[1] ?? "")}`,
    nextAction: (m, flow) => nextActionFor(m[1] ?? "", flow),
  },
  // implementフロー(`lib/implement_loop.ts`のループの終了、
  // `lib/implement_finish_support.ts`、`lib/implement_launch_support.ts`、
  // `steps/implement_*.ts`)。既存の規則のすべての後に置く。
  // "implement finish failed: ..."に包まれたpushの失敗でも、上の先頭と末尾を固定しない
  // `workflow`スコープの規則が先に一致するようにするため。
  {
    pattern: /^implement checks still failing after (\d+) rounds$/,
    describe: (m) => `${m[1]}ラウンド修正しても検査に通りませんでした`,
    nextAction: () => CHECK_COMMAND_NEXT_ACTION,
  },
  // `lib/check_runner.ts`の`checkUnrunnableReason`(実装フローとPR修正のフロー)。検査コマンドの実行ファイルを起動できなかった環境の問題で、
  // Claudeに直させても変わらないので、停滞とは別に案内する。
  {
    pattern: /^check command could not run: ([\s\S]+)$/,
    // コマンドと検査の出力はコードが決めるので、Discordのリンクや強調にならないよう、インラインコードで囲む。
    describe: (m) =>
      `検査コマンドを実行できませんでした(workerの環境の問題で、コードの失敗ではありません): \`${(m[1] ?? "").replaceAll("`", "'")}\``,
    ...procedureThenRerun(
      "workerのイメージに検査コマンドの実行ファイルがあるか確認し、無ければイメージを直してから、",
    ),
  },
  {
    pattern: /^implement stalled after round (\d+)$/,
    describe: (m) =>
      `ラウンド${m[1]}で修正が停滞しました(差分か検査結果が前のラウンドと同じです)`,
    nextAction: () => CHECK_COMMAND_NEXT_ACTION,
  },
  {
    pattern: /^claude run failed \(([^)]+)\): ([\s\S]+)$/,
    describe: (m) => `Claudeの実行に失敗しました(${m[1]}): ${m[2]}`,
    nextAction: () => GENERIC_NEXT_ACTION,
  },
  {
    pattern: /^no approved requirements for attempt (\d+)$/,
    describe: (m) => `attempt ${m[1]}の承認済み要件定義が見つかりません`,
    nextAction: () =>
      "要件定義を承認し直すか、Issueに`factory`ラベルを付け直してください",
  },
  {
    pattern: /^branch head moved to (\S+) while implementing$/,
    describe: (m) => `実装中にブランチのheadが${m[1]}に変わりました`,
    nextAction: () =>
      `ブランチの最新の状態を確認し、必要なら${RETRY_WORK_ITEM_ACTION}`,
  },
  // `lib/github.ts`の`GitHubRateLimitError`。単独の理由としても、
  // "implement finish failed: ..."の中身としても現れる。
  {
    pattern: GITHUB_RATE_LIMIT_REASON_PATTERN,
    describe: (m) => `GitHub APIのrate limitに当たりました(${m[1]}): ${m[2]}`,
    ...procedureThenRerun(GITHUB_RATE_LIMIT_PROCEDURE),
  },
  // 中身がrate limitのときだけ、その規則に訳と次の操作を任せる。
  // それ以外の中身(HTTPのエラーやgitの失敗など)は、これまでどおり汎用の案内にする。
  {
    pattern: /^implement finish failed: ([\s\S]+)$/,
    describe: (m) => {
      const inner = m[1] ?? "";
      const detail = GITHUB_RATE_LIMIT_REASON_PATTERN.test(inner)
        ? describeReason(inner)
        : inner;
      return `コミット・push・PRの作成に失敗しました: ${detail}`;
    },
    nextAction: (m) =>
      GITHUB_RATE_LIMIT_REASON_PATTERN.test(m[1] ?? "")
        ? GITHUB_RATE_LIMIT_NEXT_ACTION
        : GENERIC_NEXT_ACTION,
    ciNextAction: (m) =>
      GITHUB_RATE_LIMIT_REASON_PATTERN.test(m[1] ?? "")
        ? `${GITHUB_RATE_LIMIT_PROCEDURE}${CI_PUSH_ACTION}`
        : `${GENERIC_PROCEDURE}${CI_PUSH_ACTION}`,
  },
  {
    pattern: /^implement finished without a final output$/,
    describe: () =>
      "実装は完了と判定されましたが、最終ラウンドの出力がありませんでした",
    nextAction: () => GENERIC_NEXT_ACTION,
  },
  {
    pattern: /^implement produced no changes$/,
    describe: () => "実装が変更を生みませんでした",
    nextAction: () => "要件定義を見直すか、Issueを閉じてください",
  },
  {
    pattern: /^requirements_gap after max_attempts (\d+)$/,
    describe: (m) =>
      `要件の不足が報告されましたが、要件定義の試行回数が上限(${m[1]})に達しました`,
    nextAction: () =>
      "要件を人が整理し、Issueに追記してから`factory`ラベルを付け直してください",
  },
  ...DESIGN_REASON_RULES,
  {
    pattern: /^implement flow could not be started: ([\s\S]+)$/,
    describe: (m) => `実装フローを起動できませんでした: ${m[1]}`,
    nextAction: () => RETRY_WORK_ITEM_ACTION,
  },
  {
    pattern:
      /^implement work item could not be moved to implementing: ([\s\S]+)$/,
    describe: (m) =>
      `作業項目を実装中へ移せなかったため、実装フローを起動していません: ${m[1]}`,
    nextAction: () => RETRY_WORK_ITEM_ACTION,
  },
  {
    pattern: /^implement flow job id could not be recorded: ([\s\S]+)$/,
    describe: (m) => `実装フローのジョブIDを記録できませんでした: ${m[1]}`,
    // 起動したフローは動いており、作業項目は`implementing`のままなので、retry_work_itemは再実行を拒否する。
    nextAction: () =>
      "実装フローは動いているので、終わるのを待ち、Consoleの作業項目で状態を確認してください",
  },
  {
    pattern: /^secrets detected, changes not pushed$/,
    describe: () =>
      "秘密情報らしき文字列を検出したため、変更をpushしていません",
    nextAction: () =>
      "worktreeの差分を確認し、秘密情報を取り除いてから人が対応してください",
  },
  {
    pattern: /^partial work kept local because a pull request is open$/,
    describe: () => "PRがあるため途中の変更はpushせずworktreeに残しました",
    nextAction: () =>
      "worktreeの変更を人が確認し、必要ならPRに反映してください",
  },
  {
    pattern: /^worktree changed after verification$/,
    describe: () => "検証の後にworktreeが変更されました",
    ...procedureThenRerun(
      "検査コマンドが追跡対象のファイルを書き換えていないか確認し、",
    ),
  },
  // `lib/workspace.ts`の`commitAndPush`の`expectedTreeSha`(実装フローとpr_fixのpush)
  {
    pattern: /^committed tree differs from the inspected tree$/,
    describe: () => "commitしたツリーが、検査したツリーと異なります",
    nextAction: (_m, flow) => leftoverProcessNextAction(flow),
    ciNextAction: () => ciAfterFixWorkRerun(LEFTOVER_PROCESS_CHECK),
  },
  // `lib/implement_loop.ts`の`scannedTreeChangedReason`(実装フローの検証ループ)
  {
    pattern: /^worktree changed before the secret scan in round (\d+)$/,
    describe: (m) =>
      `ラウンド${m[1]}で、変更の判定と秘密情報の検査の間にworktreeが変更されました`,
    nextAction: () => leftoverProcessNextAction("implement"),
  },
  // `lib/workspace.ts`の`scannedTreeStopReasons`(実装フローの途中経過のpushと、pr_fixの完了ステップ)
  {
    pattern: /^worktree changed after the secret scan$/,
    describe: () => "秘密情報の検査の後にworktreeが変更されました",
    nextAction: (_m, flow) => leftoverProcessNextAction(flow),
    ciNextAction: () => ciAfterFixWorkRerun(LEFTOVER_PROCESS_CHECK),
  },
  {
    pattern: /^requirements regeneration could not be started$/,
    describe: () => "要件定義の作り直しを起動できませんでした",
    // 実装フローの差し戻しでは承認済みの要件定義のattemptが変わっていないので、再実行は実装フローからやり直す。
    // 理由を出すのは実装フローの差し戻しと、却下による作り直し(requirements_apply。要件定義から再開する)なので、実装フローのときだけ添える。
    nextAction: (_m, flow) =>
      flow === "implement"
        ? `${RETRY_WORK_ITEM_ACTION}(実装からやり直します。差し戻し理由は通知に残っています)`
        : RETRY_WORK_ITEM_ACTION,
  },
  {
    pattern: /^pull request has an active fix run$/,
    describe: () => "このPRで自動修正が実行中のため実装を止めました",
    nextAction: () => `自動修正の完了を待ってから、${RETRY_WORK_ITEM_ACTION}`,
  },
  {
    pattern: /^parent issue is being re-implemented$/,
    describe: () => "親Issueの実装をやり直している最中のため修正を止めました",
    nextAction: () => `実装フローの完了を待ってから、${RETRY_WORK_ITEM_ACTION}`,
  },
  {
    pattern: /^worktree git pointer was modified$/,
    describe: () => "worktreeのgitの参照先(.gitファイル)が書き換えられました",
    nextAction: () =>
      "ブランチとworktreeを人が確認し、不審な変更があればブランチを削除してください",
  },
  // pr_fixの各ステップ(準備ステップの結果に`worktree_git_pointer`・`head_sha`・`branch`が無い)
  {
    pattern: /^worktree git pointer was not recorded$/,
    describe: () => "worktreeのgitの参照先(.gitファイル)が記録されていません",
    nextAction: () => "`factory:fix`を付け直して修正をやり直してください",
  },
  {
    pattern: /^PR head was not recorded$/,
    describe: () => "PRのheadが記録されていません",
    nextAction: () => "`factory:fix`を付け直して修正をやり直してください",
  },
  // pr_fix_verify.tsの`localHeadStopReason`と、`commitAndPush`(pr_fix_finish.tsと、implement_finish.tsの`implementCommitGuards`)。
  // 理由の文はpr_fixに合わせて"PR head"のままだが、実装フローでは記録したブランチの先頭を指すので、訳はどちらにも合う言い方にする。
  {
    pattern: /^local HEAD (\S+) is not the PR head (\S+)$/,
    describe: (m) =>
      `worktreeのHEAD(${m[1]})が記録したブランチの先頭(${m[2]})と異なります`,
    nextAction: (_m, flow) => localHeadNextAction(flow),
    ciNextAction: () => ciAfterFixWorkRerun(LOCAL_HEAD_CHECK),
  },
  {
    pattern: /^local HEAD is not on branch (.+)$/,
    describe: (m) => `worktreeのHEADがブランチ${m[1]}にありません`,
    nextAction: (_m, flow) => localHeadNextAction(flow),
    ciNextAction: () => ciAfterFixWorkRerun(LOCAL_HEAD_CHECK),
  },
  // pr_fix_verify.tsの`inspectUncommittedChanges`と、pr_fix_finish.tsの`inspectStagedChanges`
  {
    pattern: /^not a regular file: (.+)$/,
    describe: (m) => `通常のファイルではないものが変更されました: ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^nested repository or \.git path changed: (.+)$/,
    describe: (m) => `入れ子のリポジトリか.gitのパスが変更されました: ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  // `lib/process_lock.ts`の`restoreOwnershipStep`が、取り戻せなかった所有権を`WorktreeBusyError`にしたもの。
  // 一般のプロセスの規則より先に置く。
  {
    pattern:
      /^worktree is still used by processes from an earlier run: check sandbox: ([\s\S]+)$/,
    describe: (m) =>
      `検査用のユーザーに渡したworktreeを、rootに戻せませんでした(${m[1]})`,
    ...procedureThenRerun(OWNERSHIP_RESTORE_FAILED_PROCEDURE),
  },
  {
    pattern:
      /^worktree is still used by processes from an earlier run(?:: ([\s\S]+))?$/,
    describe: (m) =>
      m[1] === undefined
        ? "前の実行のプロセスがまだworktreeを使っています"
        : `前の実行のプロセスがまだworktreeを使っています(${m[1]})`,
    ...procedureThenRerun(WORKTREE_BUSY_PROCEDURE),
  },
  // `lib/check_sandbox.ts`の`CheckImageStaleError`(実装フローとpr_fixの準備・検証・完了のステップ)
  {
    pattern: /^worker image is stale: run mise run up: ([\s\S]+)$/,
    describe: (m) =>
      `workerのイメージが古く、検査コマンドを非特権のユーザーで実行できません(${m[1]})`,
    nextAction: () =>
      `${STALE_IMAGE_PROCEDURE}。作り直した後は、止まった作業項目が自動で再開します。自動の再開が3回の上限に達したときと、通知に版が載らないときだけ、${RETRY_WORK_ITEM_ACTION}`,
    // CI回は止まった作業項目を自動では再開しないので、再開の文は出さない。
    // 失敗の行は、止まってから`STALE_IMAGE_WAIT_MS`の後に保留なしで戻る。その後の扱いは約束しない。
    ciNextAction: () =>
      `${STALE_IMAGE_PROCEDURE}。作り直した後、失敗の行は止まってから24時間後に保留なしで戻ります。待てないときは、${CI_PUSH_ACTION}`,
  },
  // `lib/check_sandbox.ts`の`CheckRuntimeUnsafeError`(同じステップ)。イメージは作り直さず、パスを閉じるかworkerを作り直す。
  // ボリュームのマウントポイントの権限はボリュームにあり、workerを作り直しても変わらない。
  {
    pattern:
      /^worker runtime is unsafe for checks: chmod o-w the paths or recreate windmill_worker: ([\s\S]+)$/,
    describe: (m) =>
      `workerの稼働中に、検査コマンドを非特権のユーザーで安全に実行できない状態になりました(${m[1]})`,
    ...procedureThenRerun(
      "理由に載ったパスをmise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker chmod o-w <パス>で閉じるか、mise exec -- docker compose -f infra/docker-compose.yml up -d --force-recreate windmill_workerでworkerを作り直してから、",
      "(/workspacesと/var/lib/factoryは、ボリュームのマウントポイントで、作り直しでは閉じないので、chmodで閉じてください)",
    ),
  },
  {
    pattern: /^implementation of the branch's work item is running$/,
    describe: () =>
      "このPRのブランチで実装フローが実行中のため修正を止めました",
    nextAction: () => `実装フローの完了を待ってから、${RETRY_WORK_ITEM_ACTION}`,
  },
  {
    pattern: /^worktree lock is held by a process this run left behind$/,
    describe: () =>
      "この実行の検査コマンドなどが残したプロセスが、worktreeのロックを持ち続けています",
    nextAction: (_m, flow) => worktreeLockHeldInRunNextAction(flow),
    ciNextAction: () => `${LOCK_HELD_PR_FIX_PROCEDURE}${CI_PUSH_ACTION}`,
  },
  {
    pattern: /^implement flow deadline reached after round (\d+)$/,
    describe: (m) =>
      `実装フローの期限(implement_flow_timeout_sec)までに次の修正を終える時間が残っていないため、ラウンド${m[1]}で修正をやめました`,
    nextAction: () => CHECK_COMMAND_NEXT_ACTION,
  },
  {
    pattern: /^implement flow deadline passed during round (\d+)$/,
    describe: (m) =>
      `実装フローの期限(implement_flow_timeout_sec)を過ぎたため、ラウンド${m[1]}のClaudeの実行を打ち切りました`,
    // この理由は必ずClaudeの実行失敗の後ろに付くため、表示される次の操作は
    // 先頭の区切りの規則のものになる。ここでは汎用の案内を置く。
    nextAction: () => GENERIC_NEXT_ACTION,
  },
  {
    pattern:
      /^implement time settings do not fit the flow step timeout: ([\s\S]+)$/,
    describe: (m) =>
      `実装フローの時間設定が、flow.yamlの実装・検証ステップのtimeoutに収まりません(${m[1]})`,
    nextAction: () =>
      `implement_flow_timeout_sec・implement_timeout_sec・implement_check_timeout_sec・検査コマンド数のいずれかを減らしてから、${RETRY_WORK_ITEM_ACTION}`,
  },
  {
    pattern:
      /^pr_fix time settings do not fit the flow step timeout: ([\s\S]+)$/,
    describe: (m) =>
      `PR修正の時間設定が、flow.yamlの修正・検証ステップのtimeoutに収まりません(${m[1]})`,
    nextAction: () =>
      `claude_timeout_secか検査コマンド(allowed_check_commands)の数を減らしてから、${RETRY_WORK_ITEM_ACTION}`,
    ciNextAction: () => TIME_SETTINGS_CI_NEXT_ACTION,
  },
  {
    pattern:
      /^pr_review time settings do not fit the flow step timeout: ([\s\S]+)$/,
    describe: (m) =>
      `PRレビューの時間設定が、flow.yamlのレビュー生成ステップのtimeoutに収まりません(${m[1]})`,
    nextAction: () =>
      "claude_timeout_secを減らしてから、`factory:review`を付け直してください",
  },
];

/**
 * 再実行か`factory:fix`の付け直しを案内する次の操作か。
 * CI回では、どちらも案内してはならない。
 * `ciNextAction`を持たない規則の案内にだけ使う。
 */
function pointsToRetryOrRelabel(action: string): boolean {
  return (
    action.includes(RETRY_WORK_ITEM_ACTION) ||
    action.includes("factory:fix") ||
    action.includes("付け直")
  );
}

/**
 * PR修正の理由に対する次の操作を選ぶ。
 * CI回は再実行も付け直しも案内しない。
 * CI回は手動でも自動でも再開しない。回が終わると`watch_pr_ci`が失敗の行を戻すためである。
 * 規則が`ciNextAction`を持てば、人が取る手順を残し、再実行の部分だけを、待つかpushする案内か、PRへのpushの案内に差し替えたその文を使う。
 * 持たない規則は、通常回の案内が再実行か付け直しを含むときだけ、PRへのpushの案内(`CI_ROUND_NEXT_ACTION`)に置き換える。
 * 再実行も付け直しも含まない案内(PRを開き直す、人が直すなど)は、そのままにする。
 */
export function nextActionForPrFix(reason: string, ciRound: boolean): string {
  if (!ciRound) return nextActionFor(reason, "pr_fix");
  const found = findNextActionRule(reason, REASON_RULES);
  if (found === null) return CI_ROUND_NEXT_ACTION;
  return ciRoundActionOfRule(found.rule, found.match);
}

/**
 * 規則がCI回で案内する次の操作。`nextActionForPrFix`が使い、規則の表の検査も使う。
 * `ciNextAction`を持てばそれを使い、持たなければ`nextAction`が再実行か付け直しを含むときだけ置き換える。
 */
export function ciRoundActionOfRule(
  rule: ReasonRule,
  match: RegExpMatchArray,
): string {
  if (rule.ciNextAction !== undefined) {
    return rule.ciNextAction(match, "pr_fix");
  }
  const action = rule.nextAction(match, "pr_fix");
  return pointsToRetryOrRelabel(action) ? CI_ROUND_NEXT_ACTION : action;
}

/**
 * 早期終了(skip、guard_blocked、round_exhausted)のときの結果のフィールドを返す。
 * PRの位置(owner、repo、pr_number)は常に作業項目から取る。
 * `pr_fix_finish.ts`は、worktreeを用意しなかったときでも、Discordの通知の宛先に
 * owner、repo、pr_numberを使うため。これらが空だったせいで、実際の実行で
 * 「リポジトリ」の欄が空の通知が出たことがある。
 */
export function earlyExitBase(
  workItem: Pick<
    WorkItem,
    | "owner"
    | "repo"
    | "pr_number"
    | "head_sha"
    | "parent_work_item_id"
    | "attempt"
    | "fix_round"
    | "ci_check_id"
    | "conflict_check_id"
  >,
): {
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly worktree_dir: string;
  readonly repo_dir: string;
  readonly factory_clone_dir: string;
  readonly worktree_git_pointer: string | null;
  readonly branch: string;
  readonly parent_work_item_id: number | null;
  readonly attempt: number;
  readonly fix_round: number;
  readonly ci_check_id: number | null;
  readonly conflict_check_id: number | null;
  readonly baseline_sha: string | null;
  readonly base_sha: string | null;
  readonly auto_tree_sha: string | null;
  readonly conflicted_paths: string[] | null;
  readonly conflict_blobs: ConflictBlobs[] | null;
} {
  return {
    owner: workItem.owner,
    repo: workItem.repo,
    pr_number: workItem.pr_number ?? 0,
    head_sha: workItem.head_sha ?? "",
    worktree_dir: "",
    repo_dir: "",
    factory_clone_dir: "",
    worktree_git_pointer: null,
    branch: "",
    parent_work_item_id: workItem.parent_work_item_id,
    attempt: workItem.attempt,
    fix_round: workItem.fix_round,
    ci_check_id: workItem.ci_check_id,
    conflict_check_id: workItem.conflict_check_id,
    baseline_sha: null,
    base_sha: null,
    auto_tree_sha: null,
    conflicted_paths: null,
    conflict_blobs: null,
  };
}

/**
 * Factoryが書いた`reason` / `status_reason`の文字列を1つ、GitHubのコメントや
 * Discordの通知に表示するために日本語に対応させる。テストできるよう純粋関数にしている。
 * 記録する`reason`は英語のまま保ち、表示するときだけ訳す。訳した値を記録に渡してはならない。
 * `"; "`でつないだ一覧(`pr_fix_verify.ts`の`ForbiddenChangeResult.reasons.join("; ")`)は
 * 項目ごとに再帰的に訳す。知らない項目(または文字列全体)はそのまま返す。
 */
export function describeReason(reason: string): string {
  if (reason.includes("; ")) {
    return reason.split("; ").map(describeReason).join("; ");
  }
  for (const rule of REASON_RULES) {
    const match = reason.match(rule.pattern);
    if (match !== null) {
      // 訳文は利用者に見せる文章なので、投稿するコメントと同じ
      // 英字と日本語の間のスペースの規則を適用する。
      return normalizeJapaneseText(rule.describe(match));
    }
  }
  return reason;
}

/**
 * `"; "`でつないだ各項目を前から順に`rules`に当て、最初に一致した規則と一致の結果を返す。
 * どれにも一致しなければ`null`を返す。
 */
function findNextActionRule(
  reason: string,
  rules: readonly ReasonRule[],
): { readonly rule: ReasonRule; readonly match: RegExpMatchArray } | null {
  const segments = reason.includes("; ") ? reason.split("; ") : [reason];
  for (const segment of segments) {
    for (const rule of rules) {
      const match = segment.match(rule.pattern);
      if (match !== null) return { rule, match };
    }
  }
  return null;
}

/**
 * `reason` / `status_reason`の文字列に対する、具体的な「次の操作」の指示を選ぶ。
 * `needs_human`の`NotifyEvent`を出すすべての箇所(`pr_fix_finish.ts`、
 * `pr_review_generate.ts`、`requirements_apply.ts`、`pipeline_generate.ts`、
 * `poll_issues.ts`の期限切れの掃除)が、`describeReason`と併せて使う。
 * `describeReason`と違い、`"; "`でつないだ各項目を訳してつなぐことはせず、
 * 規則に一致する最初の項目の対応を返す。ここで理由を作る箇所はどれも、
 * 主で対応が必要な理由を先頭に置いている(上の`"no changes to commit; replies posted"`の
 * 対についてのコメントを参照)。
 * どの項目もどの規則にも一致しなければ`GENERIC_NEXT_ACTION`を返す。
 * `flow`には理由を出したフローを渡す。worktreeのプロセスの排他の理由のように、
 * フローによって取れる操作が違う理由では、そのフローの操作だけを返す。
 * 省略すると、それらの理由では両方のフローの操作を並べた文を返す。
 * `flow`が`dependabot`のときは、dependabotの規則だけを調べ、どれにも一致しなければ
 * `DEPENDABOT_MANUAL_NEXT_ACTION`を返す。dependabotの作業項目は`retry_work_item`が拒否するので、
 * 接頭辞の無い理由(検査環境、Claudeの失敗、例外の文)に、既存の規則や`GENERIC_NEXT_ACTION`が
 * 再実行を案内しないようにするため。
 */
export function nextActionFor(reason: string, flow?: NextActionFlow): string {
  const rules = flow === "dependabot" ? DEPENDABOT_REASON_RULES : REASON_RULES;
  const found = findNextActionRule(reason, rules);
  if (found !== null) return found.rule.nextAction(found.match, flow);
  return flow === "dependabot"
    ? DEPENDABOT_MANUAL_NEXT_ACTION
    : GENERIC_NEXT_ACTION;
}

/**
 * 設計工程の`needs_human`の通知に載せる、理由の訳と次の操作。
 * 設計のフローが残したプロセスの案内など、フローで操作が変わる理由に、設計向けの案内を使う。
 */
export function designNeedsHumanFields(reason: string): {
  readonly reason: string;
  readonly next_action: string;
} {
  return {
    reason: describeReason(reason),
    next_action: nextActionFor(reason, "design"),
  };
}

// ---------------------------------------------------------------------------
// I/O: `workspace.ts`が公開していないgitの補助
// ---------------------------------------------------------------------------

/** `lib/workspace.ts`の`buildGitArgv`と同じ、設定を固定したgitのargvを返す。 */
function gitHardeningArgv(extra: readonly string[]): string[] {
  return buildGitArgv(extra);
}

/**
 * `lib/workspace.ts`の`localGitEnv`(システムとグローバルの設定を読まない環境変数)に、
 * `base`を重ねて返す。
 */
function resolvedEnv(
  base: Record<string, string>,
  home: string | undefined,
  path: string | undefined,
): Record<string, string> {
  return { ...base, ...localGitEnv(home, path) };
}

export type ReadFileFn = (path: string) => Promise<string>;

const defaultReadTextFile: ReadFileFn = (path) => Bun.file(path).text();

/**
 * worktreeのファイルを(gitを通さず)直接読む。
 * ファイルが無ければ(Claudeが削除したなど)、例外にせず`null`を返す。
 */
export async function readWorktreeFileIfExists(
  path: string,
  readFile: ReadFileFn = defaultReadTextFile,
): Promise<string | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * 変更されたファイルのうち、名前がちょうど`package.json`のもの(深さは問わない)で、
 * worktreeと`baseRef`の`scripts`が異なるものがあるかを返す。
 * pr_fix_verify(`"HEAD"`)とimplement_verify(`base_sha`)が共有する。
 * 最初に見つかった時点で止める。
 */
export async function anyPackageJsonScriptsChanged(
  run: CommandRunner,
  worktreeDir: string,
  baseRef: string,
  changes: readonly ChangedPath[],
  readFile?: ReadFileFn,
): Promise<boolean> {
  for (const entry of changes) {
    if (entry.path.split("/").pop() !== "package.json") continue;
    const before = await readGitShowFile(run, worktreeDir, baseRef, entry.path);
    const after = await readWorktreeFileIfExists(
      join(worktreeDir, entry.path),
      readFile,
    );
    if (packageJsonScriptsChanged(before, after)) return true;
  }
  return false;
}

/**
 * 差分の`Binary files ... differ`の行から集めたパスのうち、APIの変更ファイル(`changedFiles`)に
 * 載っているものだけを残し、載っていないものは件数だけを返す。
 * 差分の行はPRの作者が書けるので、パスの区切りの細工(ディレクトリ名に` and b/`を含めるなど)で
 * 変更に無いパスが取り出されうる。その信頼できないパスを、Claudeが読む対象としてプロンプトに出さず、
 * 総評にも並べない。落とした分は、件数として総評に残す(`renderReviewSummary`)。
 */
export function selectListedBinaryFiles(
  binaryFiles: readonly string[],
  changedFiles: readonly string[],
): { readonly listed: string[]; readonly unlistedCount: number } {
  const changed = new Set(changedFiles);
  const listed = binaryFiles.filter((path) => changed.has(path));
  return { listed, unlistedCount: binaryFiles.length - listed.length };
}
