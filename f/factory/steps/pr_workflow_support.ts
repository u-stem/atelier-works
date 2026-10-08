// pr_reviewとpr_fixのステップスクリプトが使う判断ロジックと、
// 小さなI/O補助をまとめる。
// 判断ロジックはI/Oを持たない純粋関数で、偽物の入力だけでテストできる。
// 各ステップの`main`はこれらを呼び、その結果に従ってI/Oだけを行う。
// I/O補助(gitの実行やworktreeのファイル読み取りなど)は、
// `lib/`にまだ同等の関数が無い操作に限って置く。

import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  isOwnPost,
  type PrReview,
  type ReviewThread,
  withMarker,
} from "../lib/github.ts";
import { decideGapReroute } from "../lib/implement_finish_support.ts";
import { parseFlowJobId } from "../lib/implement_launch_support.ts";
import { gitPointerStopReason } from "../lib/implement_loop.ts";
import { maskSecrets } from "../lib/log.ts";
import { WorktreeBusyError } from "../lib/process_lock.ts";
import {
  type ChangedPath,
  type ChangedPathStatus,
  isNewShellScript,
  matchesForbiddenPath,
} from "../lib/protected_paths.ts";
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
  type ReviewSeverity,
  type ReviewVerdict,
  type WorkItem,
  type WorkItemKind,
  type WorkItemStatus,
} from "../lib/types.ts";
import {
  assertOutputComplete,
  type CommandRunner,
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

/**
 * この規則で「日本語の文字」とみなす範囲。
 * ひらがな、カタカナ、CJK統合漢字(拡張Aを含む)、
 * CJKの記号と句読点(、。「」など)、半角・全角形の各ブロック。
 */
const JAPANESE_CHAR_CLASS =
  "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef";
/**
 * この規則で「英字の並びの終わり(または始まり)」とみなす文字。
 * 英数字と、閉じ文字の`)`、`]`、`` ` ``。
 */
const ASCII_BOUNDARY_CLASS = "0-9A-Za-z)\\]`";

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
 * それ以外(指摘が無く、未解決の`must`も無い場合を含む)は`"reviewed"`を返す。
 * これは止める理由が無く、人の承認を待つ状態である。
 */
export function reviewResultFor(
  findings: readonly ReviewFinding[],
  openMustCount: number,
): "changes_requested" | "reviewed" {
  const hasMustFinding = findings.some((finding) => finding.kind === "must");
  return hasMustFinding || openMustCount > 0 ? "changes_requested" : "reviewed";
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
 */
export function buildReviewDiffText(prDiff: PrDiffLike): string {
  if (!prDiff.truncated) {
    return prDiff.diff;
  }
  return `${prDiff.diff}\n\n[diff truncated: showing a prefix of ${prDiff.totalLines} total diff lines. See the changed files list below and use Read to inspect the rest.]`;
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
 * `renderReviewSummary`が描画する、レビュー本体のコメントの4つの固定形式。
 * レビューの本文には、Claudeが自由に書いた`summary`を使わず、
 * 必ずこの4つのどれかにする。
 * `hasPriorReview`(`db.ts`の`hasPriorReview`)で、
 * このPRの再レビューか最初のレビューかを区別する。
 * `"rereview_open"`は`"rereview_clean"`の対になる形式で、このラウンドでは
 * 新しい指摘が無いが、このラウンドでスレッドを解決した後も前のラウンドの
 * `[MUST]`の指摘が1件以上残っているときに使う。
 * そのときにLGTMだけの本文にすると、必須の指摘が残っているのに
 * 「もう対応は要らない」と読めてしまうため。
 */
export type ReviewBodyMode =
  | "findings"
  | "rereview_clean"
  | "first_clean"
  | "rereview_open";

/**
 * 本文の形式を、次の情報だけから選ぶ。このラウンドでインラインに投稿した指摘か
 * 除いた指摘があるか、このPRにFactoryのレビューがすでにあるか、
 * このラウンドの解決処理の後もFactory自身の`[MUST]`のスレッドがいくつ残るか
 * (`openMustCount`。呼び出し側が、解決前のスレッド一覧から解決予定のidを除いて
 * `countOpenMustThreads`で数える)。
 * 除いた指摘(`path`がdiffに無いなどでインラインに投稿できなかったもの)があれば、
 * `postedCommentCount`が0でも`"findings"`にする。
 * `renderReviewSummary`は固定の2行目の下に除いた指摘を必ず並べるので、
 * その一覧の直上にLGTMの行を出さないため。
 * それ以外で未解決の`must`が残っていれば(`openMustCount > 0`)、指摘の無い形式
 * (`"rereview_clean"`、理屈の上では`"first_clean"`も)の代わりに`"rereview_open"`にする。
 * ただし、PRの最初のレビューに前の未解決スレッドがあることはない。
 */
export function decideReviewBodyMode(
  postedCommentCount: number,
  droppedCount: number,
  hasPriorReview: boolean,
  openMustCount: number,
): ReviewBodyMode {
  if (postedCommentCount + droppedCount > 0) return "findings";
  if (openMustCount > 0) return "rereview_open";
  return hasPriorReview ? "rereview_clean" : "first_clean";
}

/**
 * factory-reviewスキルの投稿形式に沿って、レビュー本体のコメントの本文を組み立てる。
 * 1行目は`pr_review`の投稿と分かる役割タグと`@author`へのメンション、
 * 2行目は`mode`で選ぶ4つの固定の文、インラインに投稿できなかった指摘があれば
 * その箇条書きを続ける。
 * 箇条書きの`path`は改行を空白にまとめて1行にし、`path`と`message`の`<!--`は
 * `neutralizeHtmlComment`で無害にする。どちらもClaudeの出力で、
 * 本文の末尾の目印を偽ったり隠したりさせないため。
 * Claudeの`summary`はここに載せない(`factory.reviews`への記録とDiscordだけに使う)。
 * `verdict`も同じく載せない(DBとDiscordだけで、PRの本文には出さない)。
 * `<!-- factory:pr_review:<id> -->`とレビューしたshaの印は、呼び出し側が`withReviewMarkers`で足す。
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
  openMustCount: number,
): string {
  const lines = [`${ROLE_TAGS.pr_review} @${authorLogin}`];
  switch (mode) {
    case "findings":
      lines.push(
        `${String(postedCommentCount)}件コメントしました。確認お願いします。`,
      );
      break;
    case "rereview_clean":
      lines.push("修正を確認しました。LGTMです。");
      lines.push("最終的なApprove判断は人が行ってください。");
      break;
    case "first_clean":
      lines.push("指摘はありません。LGTMです。");
      lines.push("最終的なApprove判断は人が行ってください。");
      break;
    case "rereview_open":
      lines.push(
        `新しい指摘はありません。未対応の指摘が${String(openMustCount)}件残っています。確認お願いします。`,
      );
      break;
  }
  if (droppedFindings.length > 0) {
    lines.push("", "(行に紐づけられなかった指摘)");
    for (const finding of droppedFindings) {
      const prefix = REVIEW_FINDING_KIND_PREFIXES[finding.kind];
      const path = neutralizeHtmlComment(
        finding.path.replace(/\s*[\r\n]+\s*/g, " "),
      );
      const message = neutralizeHtmlComment(
        normalizeJapaneseText(finding.message),
      );
      lines.push(`- ${prefix} ${path}: ${message}`);
    }
  }
  return lines.join("\n");
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
 * 残りの3つは終端で、`pr_fix_finish.ts`に直接進む。
 * この3つは`PrFixFinishOutcome`の値でもある(下の`decideFixFinishAction`を参照)。
 */
export type PrFixGateOutcome =
  | "proceed"
  | "skip"
  | "guard_blocked"
  | "round_exhausted";

// ---------------------------------------------------------------------------
// pr_fix_prepare: 安全のための関門(純粋関数)。
// 方針は`docs/security.md`の「pr_fixの安全策」を参照。
// ---------------------------------------------------------------------------

export type PrFixGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type PrFixSafetyGuardInput = {
  readonly open: boolean;
  readonly headRepoFullName: string | null;
  readonly baseRepoFullName: string;
  readonly draft: boolean;
  readonly baseProtected: boolean;
};

/**
 * 修正を試みる前の4つの安全のための関門を判定する。
 * PRがopenであること、head.repoとbase.repoが同じであること(forkへpushしない)、
 * draftでないこと、baseブランチが保護されていないこと。
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
  if (
    input.headRepoFullName === null ||
    input.headRepoFullName !== input.baseRepoFullName
  ) {
    return {
      ok: false,
      reason: "head repository differs from base repository (fork PR)",
    };
  }
  if (input.draft) {
    return { ok: false, reason: "pull request is a draft" };
  }
  if (input.baseProtected) {
    return { ok: false, reason: "base branch is protected" };
  }
  return { ok: true };
}

export function evaluateFixRoundGuard(
  fixRound: number,
  maxFixRounds: number,
): PrFixGuardResult {
  if (fixRound > maxFixRounds) {
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

// ---------------------------------------------------------------------------
// pr_fix_verify: 禁止された変更の検出(純粋関数)。
// 方針は`docs/security.md`の「pr_fixの安全策」を参照。
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
 * worktreeで`git diff <modeArgs> -z --no-ext-diff <ref> --`を実行し、標準出力を返す。
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
    gitHardeningArgv(["diff", ...modeArgs, "-z", "--no-ext-diff", ref, "--"]),
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
  const rawSymlinkPaths =
    changedPaths.length === 0
      ? []
      : parseRawSymlinkPaths(
          await readRawDiff(
            run,
            worktreeDir,
            ["--raw", "--no-renames"],
            "HEAD",
          ),
        );
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
      ...disk.nonRegular.map((path) => `not a regular file: ${path}`),
      ...detectEscapingSymlinks(worktreeDir, symlinkTargets),
      ...detectSymlinkChanges(changedPaths, symlinkTargets),
      ...rawSymlinkPaths.map(
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
 */
export function stopBeforeCommitTerminal(stopReason: string): {
  readonly toStatus: "needs_human";
  readonly discordReason: string;
  readonly statusNote: string;
} {
  return {
    toStatus: "needs_human",
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
 * 次に`.git`を準備ステップの記録と比べる(`recordedGitPointerStopReason`)。
 * それ以外の例外はそのまま投げる。
 */
export async function prFixPushGateReason(
  deps: PrFixPushGateDeps,
  recordedPointer: string | null,
): Promise<string | null> {
  try {
    await deps.ensureLockFree();
  } catch (err) {
    if (err instanceof WorktreeBusyError) return err.message;
    throw err;
  }
  return recordedGitPointerStopReason(recordedPointer, deps.assertGitPointer);
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
// pr_fix_verify: `factory_config.allowed_check_commands`の実行(I/O)
// ---------------------------------------------------------------------------

export type CheckCommandResult = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly outputTail: string;
  /**
   * stdoutとstderrを合わせた出力のうち、`CHECK_COMMAND_MAX_OUTPUT_BYTES`の範囲で
   * 残った全体を、秘密をマスクして持つ。implementフローはその先頭16KBを
   * `implement_rounds.check_output`に保存する(`truncateCheckOutput`)。
   * プロンプトに載せる抜粋は引き続き`outputTail`を使う。
   */
  readonly output: string;
};

const CHECK_OUTPUT_TAIL_CHARS = 2000;

export const CHECK_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

export type CheckHomeDir = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

export type CreateCheckHomeDir = () => Promise<CheckHomeDir>;

/**
 * `runAllowedCheckCommands`の1回の呼び出し用に、新しい非公開の一時ディレクトリを作る。
 * 検査コマンドは信頼できない対象リポジトリのコードを、他に隔離の無いままrootで実行する。
 * 全実行で共有する固定の`/tmp/factory-home`だと、ある実行の検査ツールが残した
 * キャッシュファイルや仕込まれた設定が残り、別のPRやリポジトリに対する
 * 後の実行に読まれうる。
 * `claude.ts`の`buildSystemPrompt` / `WriteTempFile`と同じく、
 * mkdtempと後始末の形にしている。
 */
const defaultCreateCheckHomeDir: CreateCheckHomeDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-check-home-"));
  return {
    path: dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/**
 * `allowed_check_commands`の各項目を、`cwd`で順に実行する。
 * 環境変数は最小限を明示的に渡し(PATHと新しい非公開のHOMEだけで、秘密は引き継がない。
 * `docs/security.md`の"env -i PATH=... HOME=...")、終わったらHOMEのディレクトリを消す。
 * miseの設定の信頼(trust)は決して与えない(`MISE_TRUSTED_CONFIG_PATHS`も
 * `mise --yes trust`も使わない)。信頼が無いと動かない検査コマンド
 * (信頼されていない対象リポジトリの`mise.toml`に対する`mise run check`など)は、
 * 他の0以外の終了と同じく失敗し、呼び出し側は通常の検査の失敗として扱う
 * (Claudeの再試行を1回してから`blocked`)。
 * これで、コマンドを解析して「`mise.toml`に依存するか」を推測する事前確認をしなくても、
 * 「信頼が要るものは実行しない」という同じ結果になる。
 * コマンドはシェルを使わず、空白で区切ってargvにする。
 * `allowed_check_commands`は対象リポジトリの内容ではなく、
 * 運用者が書く設定(`factory_config`)だから。
 * 出力の読み取りを打ち切ったコマンド(`outputAbandoned`)は、終了コードに関わらず失敗にする。
 * 別セッションへ抜けたプロセスがworkerに残ったことを検査結果に出すためである。
 */
export async function runAllowedCheckCommands(
  run: CommandRunner,
  cwd: string,
  commands: readonly string[],
  timeoutMs: number,
  createHomeDir: CreateCheckHomeDir = defaultCreateCheckHomeDir,
  path: string | undefined = process.env.PATH,
): Promise<CheckCommandResult[]> {
  const homeDir = await createHomeDir();
  try {
    const env: Record<string, string> = { HOME: homeDir.path };
    if (path !== undefined) env.PATH = path;

    const results: CheckCommandResult[] = [];
    for (const command of commands) {
      const argv = command
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
      if (argv.length === 0) continue;
      const result = await run(argv, {
        cwd,
        env,
        timeoutMs,
        maxOutputBytes: CHECK_COMMAND_MAX_OUTPUT_BYTES,
      });
      const masked = maskSecrets(`${result.stdout}\n${result.stderr}`.trim());
      results.push({
        command,
        ok:
          !result.timedOut &&
          result.exitCode === 0 &&
          result.outputAbandoned !== true,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputTail: masked.slice(-CHECK_OUTPUT_TAIL_CHARS),
        output: masked,
      });
    }
    return results;
  } finally {
    await homeDir.cleanup();
  }
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
  | "blocked";

export type PrFixFinalAction =
  | { readonly kind: "noop" }
  | { readonly kind: "push" }
  | { readonly kind: "requirements_gap_reroute" }
  | { readonly kind: "requirements_gap_needs_human" }
  | { readonly kind: "guard_blocked" }
  | { readonly kind: "needs_human" };

/**
 * まとめた結果(prepare、collect、apply、verifyのうち最後に動いたものの結果)を、
 * `pr_fix_finish.ts`が取るべき終端の動作に振り分ける。
 *
 * `guard_blocked`(prepareの、PRがopen・forkでない・draftでない・
 * 保護ブランチでないという関門)は、`docs/security.md`の
 * 「違反はblockedとして中断する」に従い`work_items`の`"blocked"`にする。
 * `blocked`(Claude自身の判断か、`pr_fix_verify`が検出した禁止ファイルや
 * 検査コマンドの失敗)は`"needs_human"`にする。
 * どちらも上流では`"blocked"`の形の結果だが、失敗の種類が違うので、
 * 意図して別の終端状態にしている。
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
    ? `${reason}; ${gapReport.replaceAll("; ", ", ")}`
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
  /** `job_failures`に記録し、ConsoleのFailuresタブから見えるようにする。 */
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
 * Issueを実際に作るかは人がConsoleのInboxで承認か却下し(`issue_proposal_apply.ts`)、
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
 * `pr_fix_finish.ts`の返信の投稿で失敗したものをまとめ、ConsoleのNoticesタブに出す
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
 * `nextActionFor`(ConsoleのInboxを案内する)が扱う。
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
 * `findIssueByMarker`の引用符付きのGitHub検索に渡す。
 * コメント構文の`<`、`-`、`>`は、GitHubの検索の字句解析では雑音になるため。
 */
export function issueProposalMarkerSearchTerm(proposalId: number): string {
  return `factory:${ISSUE_PROPOSAL_MARKER_KIND}:${String(proposalId)}`;
}

/**
 * 作ったIssueの本文に埋める、`<!-- factory:issue_proposal:<id> -->`の印の全文を返す。
 */
export function issueProposalMarkerText(proposalId: number): string {
  return `<!-- ${issueProposalMarkerSearchTerm(proposalId)} -->`;
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
 * `body`が`proposalId`の印をそのまま含むかを返す。
 * `findIssueByMarker`の検索結果を信じる前の確認に使う。
 * 引用符付きのGitHub検索の語句は、完全一致ではなく単語や部分文字列での一致なので、
 * 理屈の上では、このidを先頭に含むもっと長いidにも一致しうるため。
 */
export function hasIssueProposalMarker(
  body: string,
  proposalId: number,
): boolean {
  return body.includes(issueProposalMarkerText(proposalId));
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
// `updateStatusIfCurrent` / `addNotice`で記録する`reason`は、
// 元の英語の形のまま保つ必要がある。
// 他のツールがその値を手がかりにしており、`factory.notices`と`status_reason`は
// 機械的に比べられる状態を保つためのものだから。
// 一方で、同じ文をGitHubのコメントやDiscordの通知に出すときは、Factoryが投稿する
// 人向けの他の文字列と同じく日本語で読めるようにする。
// `describeReason`は、`pr_workflow_support.ts`と、pr_fix_*、pipeline_*、
// `pr_review_generate.ts`の各ステップが出す既知の関門と結果の理由の文字列を、
// その表示のためだけに日本語の文へ対応させる。呼び出し側は、訳していない値を
// 引き続き`updateStatusIfCurrent` / `addNotice`に渡す。
// この関数が知らない理由(Claude自身の自由文の`summary`や`blocked_reason`を含む)は、
// 黙って捨てたり崩したりせず、そのまま返す。
// ---------------------------------------------------------------------------

type ReasonRule = {
  readonly pattern: RegExp;
  readonly describe: (match: RegExpMatchArray) => string;
  /**
   * `needs_human`の通知が伝える理由には、読み手が何をすればよいかも必ず添える。
   * `describeReason`が`describe`を選ぶのと同じく、
   * 下の`nextActionFor`が規則ごとにこれを選ぶ。
   * 具体的な日本語の1文の指示にする。
   * 固有の対応が無い理由(安全のための関門の失敗だけのものなど)と、
   * この表が知らない理由には、汎用の`GENERIC_NEXT_ACTION`を使う。
   */
  readonly nextAction: (match: RegExpMatchArray) => string;
};

/**
 * 汎用の次の対応。ConsoleのFailuresとNoticesのタブ(`factory_console__raw_app`)を案内する。
 * 原因に関係なく、`needs_human`の作業項目とnoticeがすべて並ぶ唯一の場所なので、
 * より具体的な対応が無いときの既定として安全である。
 */
const GENERIC_NEXT_ACTION =
  "ConsoleのFailures / Noticesタブで詳細を確認してください";

const FACTORY_FIX_RELABEL_ACTION =
  "対応してほしい指摘をコメントしてから`factory:fix`を付け直してください";
const CHECK_COMMAND_NEXT_ACTION =
  "失敗しているチェックを確認し、人が修正してください";
const FORBIDDEN_CHANGE_NEXT_ACTION =
  "差分を確認し、問題なければ人が直接修正してください";
const DIFF_SIZE_NEXT_ACTION =
  "変更を分割するか、上限を見直してから`factory:fix`を付け直してください";
const GITHUB_RATE_LIMIT_NEXT_ACTION =
  "GitHubのrate limitの解除を待ってから、ConsoleのFailuresタブで再実行してください";
/** `lib/github.ts`の`GitHubRateLimitError`のメッセージ。1はエンドポイント、2は待ちの説明。 */
const GITHUB_RATE_LIMIT_REASON_PATTERN = /^GitHub rate limit on (\S+): (.+)$/;
const DAILY_BUDGET_NEXT_ACTION =
  "翌日まで待つか、daily_budget_usdを引き上げてください";
const NOTHING_TO_COMMIT_NEXT_ACTION =
  "返信内容を確認し、必要なら指示をコメントして`factory:fix`を付け直してください";
const LOCAL_HEAD_NEXT_ACTION =
  "検査コマンドがコミットやブランチの切り替えをしていないか確かめ、人が修正してください";
const ISSUE_PROPOSAL_NEXT_ACTION =
  "ConsoleのInboxで提案を承認または却下してください";

const REASON_RULES: readonly ReasonRule[] = [
  // pr_fix_prepare.tsの`evaluatePrFixSafetyGuards` / `evaluateRepoAllowedGuard`
  {
    pattern: /^pull request is not open$/,
    describe: () => "PR がオープンではありません",
    nextAction: () => "PRを再オープンするか、この作業を取り下げてください",
  },
  {
    pattern: /^head repository differs from base repository \(fork PR\)$/,
    describe: () => "head リポジトリと base リポジトリが異なります(fork PR)",
    nextAction: () =>
      "forkではなく同一リポジトリのブランチからPRを作り直してください",
  },
  {
    pattern: /^pull request is a draft$/,
    describe: () => "PR がドラフトです",
    nextAction: () => "ドラフトを解除してから`factory:fix`を付け直してください",
  },
  {
    pattern: /^base branch is protected$/,
    describe: () => "base ブランチが保護されています",
    nextAction: () => "baseブランチの保護設定を確認してください",
  },
  {
    pattern:
      /^repository is not allowed by factory_config \(owners \/ repo_allowlist\)$/,
    describe: () =>
      "factory_config(owners / repo_allowlist)で許可されていないリポジトリです",
    nextAction: () =>
      "factory_configのowners / repo_allowlistを見直してください",
  },
  // pr_fix_prepare.tsの`evaluateFixRoundGuard`(round_exhausted)
  {
    pattern: /^fix_round (\d+) exceeds max_fix_rounds (\d+)$/,
    describe: (m) => `fix_round ${m[1]} が max_fix_rounds ${m[2]} を超えました`,
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
      `シンボリックリンクが worktree の外を指しています: ${m[1]} -> ${m[2]}`,
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
    describe: (m) => `変更ファイル数 ${m[1]} が ${m[2]} ${m[3]} を超えました`,
    nextAction: () => DIFF_SIZE_NEXT_ACTION,
  },
  {
    pattern: /^diff line total (\d+) exceeds (\S+) (\d+)$/,
    describe: (m) => `diff の総行数 ${m[1]} が ${m[2]} ${m[3]} を超えました`,
    nextAction: () => DIFF_SIZE_NEXT_ACTION,
  },
  // pr_fix_apply.ts、pr_fix_verify.ts、pipeline_generate.ts、
  // pr_review_generate.tsの日次予算の検査(予算超過)
  {
    pattern: /^daily budget exceeded \(\$([\d.]+) >= \$([\d.]+)\)$/,
    describe: (m) =>
      `1 日あたりの Claude 利用予算の上限に達しました($${m[1]} >= $${m[2]})`,
    nextAction: () => DAILY_BUDGET_NEXT_ACTION,
  },
  {
    pattern: /^daily budget exceeded$/,
    describe: () => "1 日あたりの Claude 利用予算の上限に達しました",
    nextAction: () => DAILY_BUDGET_NEXT_ACTION,
  },
  // pr_fix_finish.tsのpushと再試行の結果(head_changedなど)
  {
    pattern: /^PR head moved to (\S+) while the fix was in progress$/,
    describe: (m) => `修正の実行中に PR の head が ${m[1]} に変わりました`,
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
  // ConsoleのInboxを案内するためにある。
  {
    pattern: /^Issue化の提案が(\d+)件あります$/,
    describe: (m) => `Issue化の提案が${m[1]}件あります`,
    nextAction: () => ISSUE_PROPOSAL_NEXT_ACTION,
  },
  {
    pattern: /^needs human attention$/,
    describe: () => "人による対応が必要です",
    nextAction: () => GENERIC_NEXT_ACTION,
  },
  {
    pattern: /^safety guard failed$/,
    describe: () => "安全性ガードに失敗しました",
    nextAction: () => GENERIC_NEXT_ACTION,
  },
  // pr_fix_finish.tsの`evaluateRerouteGuard`(親に`issue_number`が無い)
  {
    pattern: /^parent work item has no issue_number$/,
    describe: () => "親の work item に issue_number がありません",
    nextAction: () => "work itemの状態をConsoleで確認してください",
  },
  // pr_fix_finish.tsが使う`evaluateRerouteParentStatus`と`rerouteParentChangedReason`。
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
    describe: (m) => `${m[1]} 回連続で差し戻されました`,
    nextAction: () =>
      "要件を人が整理し、Issueに追記してから`factory`ラベルを付け直してください",
  },
  {
    pattern: /^approval timed out$/,
    describe: () => "承認がタイムアウトしました",
    nextAction: () => "Inboxで承認または却下してください",
  },
  // pr_fix_finish.tsのpush後のレビュアー依頼の結果(`reviewerNote`)。
  // この3つはどれも`needs_human`の通知にはもう届かない。
  // skipped_emptyと候補なしは通知を出さず、失敗は`pr_fixed`のイベントの`note`の
  // フィールドに含める(`pr_fix_finish.ts`を参照)。
  // そのためこれらの`nextAction`は、実際のDiscordの通知ではなく、
  // `describeReason` / `nextActionFor`を直接呼ぶ経路(テストなど)でだけ使われる。
  {
    pattern:
      /^no reviewers to request \(default_reviewers empty and no fallback reviewer authors\)$/,
    describe: () =>
      "リクエストするレビュアーがいません(default_reviewers が空で、フォールバックの候補者もいません)",
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
      "リクエスト対象のレビュアーが全員除外されました(PR 作成者 / factory 自身)",
    nextAction: () =>
      "default_reviewersにPR作成者以外のレビュアーを設定してください",
  },
  {
    pattern: /^could not request re-review: (.+)$/,
    describe: (m) =>
      `再レビューをリクエストできませんでした: ${describeReason(m[1] ?? "")}`,
    nextAction: (m) => nextActionFor(m[1] ?? ""),
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
      "ブランチの最新の状態を確認し、必要ならConsoleのFailuresタブから再実行してください",
  },
  // `lib/github.ts`の`GitHubRateLimitError`。単独の理由としても、
  // "implement finish failed: ..."の中身としても現れる。
  {
    pattern: GITHUB_RATE_LIMIT_REASON_PATTERN,
    describe: (m) => `GitHub APIのrate limitに当たりました(${m[1]}): ${m[2]}`,
    nextAction: () => GITHUB_RATE_LIMIT_NEXT_ACTION,
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
  {
    pattern: /^implement flow could not be started: ([\s\S]+)$/,
    describe: (m) => `実装フローを起動できませんでした: ${m[1]}`,
    nextAction: () => "ConsoleのFailuresタブから再実行してください",
  },
  {
    pattern: /^implement flow job id could not be recorded: ([\s\S]+)$/,
    describe: (m) => `実装フローのジョブIDを記録できませんでした: ${m[1]}`,
    nextAction: () => GENERIC_NEXT_ACTION,
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
    nextAction: () =>
      "検査コマンドが追跡対象のファイルを書き換えていないか確認し、再実行してください",
  },
  {
    pattern: /^requirements regeneration could not be started$/,
    describe: () => "要件定義の作り直しを起動できませんでした",
    nextAction: () =>
      "ConsoleのFailuresタブから再実行してください(差し戻し理由は通知に残っています)",
  },
  {
    pattern: /^pull request has an active fix run$/,
    describe: () => "このPRで自動修正が実行中のため実装を止めました",
    nextAction: () =>
      "自動修正の完了を待ってからConsoleのFailuresタブで再実行してください",
  },
  {
    pattern: /^parent issue is being re-implemented$/,
    describe: () => "親Issueの実装をやり直している最中のため修正を止めました",
    nextAction: () =>
      "実装フローの完了を待ってから再度factory:fixを付けてください",
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
  // pr_fix_verify.tsの`localHeadStopReason`と、pr_fix_finish.tsの`commitAndPush`
  {
    pattern: /^local HEAD (\S+) is not the PR head (\S+)$/,
    describe: (m) => `worktreeのHEAD(${m[1]})がPRのhead(${m[2]})と異なります`,
    nextAction: () => LOCAL_HEAD_NEXT_ACTION,
  },
  {
    pattern: /^local HEAD is not on branch (.+)$/,
    describe: (m) => `worktreeのHEADがブランチ${m[1]}にありません`,
    nextAction: () => LOCAL_HEAD_NEXT_ACTION,
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
  {
    pattern:
      /^worktree is still used by processes from an earlier run(?:: ([\s\S]+))?$/,
    describe: (m) =>
      m[1] === undefined
        ? "前の実行のプロセスがまだworktreeを使っています"
        : `前の実行のプロセスがまだworktreeを使っています(${m[1]})`,
    nextAction: () =>
      "載っているプロセスが何かを確かめて止めるか、workerを再起動してから(同じworkerの他のジョブも止まります)、ConsoleのFailuresタブから再実行してください",
  },
  {
    pattern: /^implementation of the branch's work item is running$/,
    describe: () =>
      "このPRのブランチで実装フローが実行中のため修正を止めました",
    nextAction: () =>
      "実装フローの完了を待ってから再度factory:fixを付けてください",
  },
  {
    pattern: /^worktree lock is held by a process this run left behind$/,
    describe: () =>
      "この実行の検査コマンドなどが残したプロセスが、worktreeのロックを持ち続けています",
    nextAction: () =>
      "検査コマンドが常駐プロセスを残していないかを確かめ、workerを再起動してから(同じworkerの他のジョブも止まります)、ConsoleのFailuresタブから再実行してください",
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
      "implement_flow_timeout_sec・implement_timeout_sec・implement_check_timeout_sec・検査コマンド数のいずれかを減らしてから、ConsoleのFailuresタブから再実行してください",
  },
  {
    pattern:
      /^pr_fix time settings do not fit the flow step timeout: ([\s\S]+)$/,
    describe: (m) =>
      `PR修正の時間設定が、flow.yamlの修正・検証ステップのtimeoutに収まりません(${m[1]})`,
    nextAction: () =>
      "claude_timeout_secか検査コマンド(allowed_check_commands)の数を減らしてから、ConsoleのFailuresタブから再実行してください",
  },
  {
    pattern:
      /^pr_review time settings do not fit the flow step timeout: ([\s\S]+)$/,
    describe: (m) =>
      `PRレビューの時間設定が、flow.yamlのレビュー生成ステップのtimeoutに収まりません(${m[1]})`,
    nextAction: () =>
      "claude_timeout_secを減らしてから、ConsoleのFailuresタブから再実行してください",
  },
];

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
 * `reason` / `status_reason`の文字列に対する、具体的な「次の操作」の指示を選ぶ。
 * `needs_human`の`NotifyEvent`を出すすべての箇所(`pr_fix_finish.ts`、
 * `pr_review_generate.ts`、`requirements_apply.ts`、`pipeline_generate.ts`、
 * `poll_issues.ts`の期限切れの掃除)が、`describeReason`と併せて使う。
 * `describeReason`と違い、`"; "`でつないだ各項目を訳してつなぐことはせず、
 * 規則に一致する最初の項目の対応を返す。ここで理由を作る箇所はどれも、
 * 主で対応が必要な理由を先頭に置いている(上の`"no changes to commit; replies posted"`の
 * 対についてのコメントを参照)。
 * どの項目もどの規則にも一致しなければ`GENERIC_NEXT_ACTION`を返す。
 */
export function nextActionFor(reason: string): string {
  const segments = reason.includes("; ") ? reason.split("; ") : [reason];
  for (const segment of segments) {
    for (const rule of REASON_RULES) {
      const match = segment.match(rule.pattern);
      if (match !== null) {
        return rule.nextAction(match);
      }
    }
  }
  return GENERIC_NEXT_ACTION;
}

// ---------------------------------------------------------------------------
// I/O: `workspace.ts`が公開していないgitの補助
// ---------------------------------------------------------------------------

function gitHardeningArgv(extra: readonly string[]): string[] {
  return [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    ...extra,
  ];
}

function resolvedEnv(
  base: Record<string, string>,
  home: string | undefined,
  path: string | undefined,
): Record<string, string> {
  const env = { ...base };
  const resolvedHome = home ?? process.env.HOME;
  if (resolvedHome !== undefined) env.HOME = resolvedHome;
  const resolvedPath = path ?? process.env.PATH;
  if (resolvedPath !== undefined) env.PATH = resolvedPath;
  return env;
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
