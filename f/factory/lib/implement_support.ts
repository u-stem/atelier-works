// implementフローでClaudeの出力を扱う関数をまとめる。
// 構造化出力の形の検査、commit前の意味の検査、
// commitメッセージやPR本文の組み立てを担う。
// 入出力は行わない。stepsからは独立させ、lib→stepsのimportを作らない。
//
// 形と意味の検査は意図して分けている。`isImplementClaudeOutput`は
// `prompts.ts`の`IMPLEMENT_SCHEMA`(`claude -p --json-schema`が強制する形)を
// 項目ごとに写したもので、`validateImplementOutput`はスキーマで表せない規則を持つ。

import { createHash } from "node:crypto";
import {
  type ChangedPath,
  isNewShellScript,
  matchesImplementProtectedPath,
} from "./protected_paths.ts";
import { extractSectionBody } from "./requirements_doc.ts";
import { classifyChangedPaths } from "./self_update_support.ts";
import {
  assertBranchName,
  type FactoryConfig,
  type ImplementRoundOutcome,
  isOneOf,
  isRecord,
  isString,
  isStringArray,
} from "./types.ts";
import { withCommitTrailers } from "./workspace.ts";

/**
 * Claude自身が返す2つの結果(`IMPLEMENT_SCHEMA`)。
 * `implement_rounds.outcome`のそれ以外の値(`check_failed` / `checks_skipped` /
 * `stalled` / `error`)は、Claudeではなくフローが付ける。
 */
export type ImplementClaudeOutcome = "done" | "requirements_gap";
export const IMPLEMENT_CLAUDE_OUTCOMES: readonly ImplementClaudeOutcome[] = [
  "done",
  "requirements_gap",
];

export type ImplementClaudeOutput = {
  readonly outcome: ImplementClaudeOutcome;
  readonly summary: string;
  /**
   * `outcome`が`requirements_gap`のときは必須(`null`でも空白だけでもない)。
   * 要件定義をやり直すときのフィードバックになる。
   */
  readonly gap_report: string | null;
  /** `outcome`が`done`なら空でない1行、それ以外なら`""`。 */
  readonly commit_subject: string;
  /**
   * 省略できる本文。`""`は本文なしを表す。
   * `FIX_SCHEMA`の`commit_body`と違い、`IMPLEMENT_SCHEMA`ではnullにできない。
   */
  readonly commit_body: string;
  /**
   * 判断に迷った点、保護パスの変更、書き込めなかったパスなど。
   * PR本文の「確認して欲しい点」に載せる。
   */
  readonly notes_for_reviewer: string[];
};

/**
 * 値が`prompts.ts`の`IMPLEMENT_SCHEMA`(`claude -p --json-schema`に渡すスキーマ)の
 * 形に一致するかを返す。形だけを見る。
 * 結果ごとの規則は`validateImplementOutput`が検査する。
 */
export function isImplementClaudeOutput(
  value: unknown,
): value is ImplementClaudeOutput {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.outcome, IMPLEMENT_CLAUDE_OUTCOMES)) return false;
  if (!isString(value.summary)) return false;
  if (value.gap_report !== null && !isString(value.gap_report)) return false;
  if (!isString(value.commit_subject)) return false;
  if (!isString(value.commit_body)) return false;
  return isStringArray(value.notes_for_reviewer);
}

// ---------------------------------------------------------------------------
// validateImplementOutput: IMPLEMENT_SCHEMAでは表せない、結果ごとの規則
// ---------------------------------------------------------------------------

/**
 * commitの件名の最大コードポイント数。gitの件名の慣習に合わせた値で、
 * `pr_workflow_support.ts`がpr_fixの`commit_subject`に課す上限と同じ。
 * プロンプトでは50字程度を目指すよう求めており、
 * 件名が少し長いだけで実行全体を無駄にしないよう、上限には余裕を持たせている。
 */
export const COMMIT_SUBJECT_MAX_CODEPOINTS = 72;

export type ImplementOutputValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Claudeの出力が、スキーマで表せない結果ごとの規則を満たすかを検査する。
 *
 * `requirements_gap`のとき:
 * - `gap_report`が空白でないこと。要件定義へのフィードバックになるため、
 *   空のままだと手がかりの無いまま要件定義をやり直すことになる。
 * - `commit_subject`と`commit_body`が空であること。説明するcommitが無いため。
 *   スキルとプロンプトでClaudeに約束させている内容と揃えている。
 *
 * `done`のとき(`commit_subject`は前後の空白を除いて判定する):
 * - `gap_report`が`null`であること(上と同じ約束の逆向き)。
 * - `commit_subject`が空白でない1行であること。
 * - `COMMIT_SUBJECT_MAX_CODEPOINTS`コードポイント以下であること。
 *   `.length`ではなく、展開して数える。
 * - 「…」で終わらないこと。上限に収めずに書き切ろうとした兆候だからで、
 *   `pr_workflow_support.ts`の`isValidCommitSubject`と同じ考え方である。
 * - 改行(先に拒否済み)以外の制御文字を含まないこと。
 *
 * `commit_body`の内容そのものでは拒否しない。
 * `reason`は運用者向けの英語で、`implement_rounds`の行とジョブのログに記録する。
 * Claudeには見せない。
 */
export function validateImplementOutput(
  output: ImplementClaudeOutput,
): ImplementOutputValidation {
  if (output.outcome === "requirements_gap") {
    if (output.gap_report === null || output.gap_report.trim().length === 0) {
      return {
        ok: false,
        reason: "requirements_gap outcome without a gap_report",
      };
    }
    if (output.commit_subject !== "" || output.commit_body !== "") {
      return {
        ok: false,
        reason:
          "commit_subject and commit_body must be empty when outcome is not done",
      };
    }
    return { ok: true };
  }
  if (output.gap_report !== null) {
    return {
      ok: false,
      reason: "gap_report must be null when outcome is done",
    };
  }
  const subject = output.commit_subject.trim();
  if (subject.length === 0) {
    return { ok: false, reason: "done outcome with an empty commit_subject" };
  }
  if (subject.includes("\n")) {
    return { ok: false, reason: "commit_subject contains a newline" };
  }
  if ([...subject].length > COMMIT_SUBJECT_MAX_CODEPOINTS) {
    return {
      ok: false,
      reason: `commit_subject exceeds ${String(COMMIT_SUBJECT_MAX_CODEPOINTS)} code points`,
    };
  }
  if (subject.endsWith("…")) {
    return { ok: false, reason: 'commit_subject ends with "…"' };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字(先に拒否した\nを除く)を拒否するため、意図して一致させる
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(subject)) {
    return {
      ok: false,
      reason: "commit_subject must not contain control characters",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// buildImplementCommitMessage: 件名、本文、トレーラーを組み立てる
// ---------------------------------------------------------------------------

/**
 * `implement_finish`が`commitAndPush`(`workspace.ts`)に渡す
 * commitメッセージを組み立てる。
 * 前後の空白を除いた`commit_subject`を置き、`commit_body`が空白でなければ
 * 空行と前後の空白を除いた本文を続ける。最後に`withCommitTrailers`で
 * `Co-Authored-By`と`Generated-By`のトレーラーを付ける。
 * `withCommitTrailers`は冪等なので、`commitAndPush`の中で再び呼ばれても何も増えない。
 *
 * 件名は検査し直さないので、呼び出し側が先に`validateImplementOutput`を実行する。
 * 日本語の空白の正規化(`steps/pr_workflow_support.ts`の`normalizeJapaneseText`)も
 * 呼び出し側が先に行う。libはstepsからimportしないためである。
 */
export function buildImplementCommitMessage(
  output: Pick<ImplementClaudeOutput, "commit_subject" | "commit_body">,
  instanceName: string,
): string {
  const subject = output.commit_subject.trim();
  const body = output.commit_body.trim();
  const message = body.length === 0 ? subject : `${subject}\n\n${body}`;
  return withCommitTrailers(message, instanceName);
}

// ---------------------------------------------------------------------------
// neutralizeIssueRefs: Claudeが書いたcommitの文面からIssueへの参照を外す
// ---------------------------------------------------------------------------

/**
 * Claudeが書いたcommitの文面にあるGitHubのIssue参照を書き換え、
 * commitがデフォルトブランチに入ってもリンクせず、何も閉じないようにする
 * (`fixes #12`のままだとIssue 12が閉じる)。
 * - `owner/repo#12`は`owner/repo No.12`にする。
 * - 単独の`#12`(直前が英数字・`_`・`/`でないもの)は`No.12`にする。
 * - IssueやPRのURL(`https://github.com/<o>/<r>/issues/<n>`、`.../pull/<n>`)は、
 *   ホストを`github[.]com`と書き換え、残りはそのまま残す。
 * - `GH-12`は`GH No.12`にする。
 * `C#`と`#tag`は変えない。ASCIIだけを使い、不可視の文字は入れない。
 * Factory自身が書く`Closes #N`はPR本文にあり、トレーラーはこの処理の後に付ける。
 */
export function neutralizeIssueRefs(text: string): string {
  return text
    .replace(
      /(https?:\/\/(?:www\.)?)github\.com(\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)/gi,
      "$1github[.]com$2",
    )
    .replace(/\b(GH)-(\d+)/gi, "$1 No.$2")
    .replace(/([\w.-]+\/[\w.-]+)#(\d+)/g, "$1 No.$2")
    .replace(/(?<![\w/])#(\d+)/g, "No.$1");
}

// ---------------------------------------------------------------------------
// buildImplementBranchName: `factory/issue-<N>-wi-<id>`
// ---------------------------------------------------------------------------

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `buildImplementBranchName: ${label} must be a positive integer, got ${String(value)}`,
    );
  }
}

/**
 * 作業項目1件のimplementブランチの名前を返す。
 * 数値が正の整数でないときと、ブランチ名として不正なときは例外を投げる。
 * 2つの数値はDB由来で利用者の文字列ではないが、それでも`assertBranchName`を通す。
 * 将来の呼び出し側が、gitがオプションと解釈する文字列を渡せないようにするためである。
 */
export function buildImplementBranchName(
  issueNumber: number,
  workItemId: number,
): string {
  assertPositiveInteger(issueNumber, "issueNumber");
  assertPositiveInteger(workItemId, "workItemId");
  const branch = `factory/issue-${String(issueNumber)}-wi-${String(workItemId)}`;
  assertBranchName(branch);
  return branch;
}

/** 実装ブランチ名(`factory/issue-<N>-wi-<id>`)から作業項目のIDを返す。形が違えばnull。pr_fixが、親の行が無くても同じブランチの実装フローを見つけるのに使う。 */
export function parseImplementBranchWorkItemId(branch: string): number | null {
  const match = /^factory\/issue-[1-9]\d*-wi-([1-9]\d*)$/.exec(branch);
  const id = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

// ---------------------------------------------------------------------------
// classifyProtectedChanges: 保護パスの変更を記録する(止めはしない)
// ---------------------------------------------------------------------------

/**
 * 差分にある保護対象の変更ごとに、人向けの日本語の行を1つずつ返す。
 * 保護パスの判定にはimplementフロー用の一覧(`matchesImplementProtectedPath`)を使う。
 * これはpr_fixの一覧に、`.github/**`、`infra/**`、hook・パッケージマネージャー・
 * devcontainerのディレクトリ、lockfile、ツールの設定、
 * すべての`package.json`を加えたものである。
 *
 * 行は次の順に並べる。
 * 1. 変更された保護パス(変更の種類は問わない)
 * 2. 新しく追加された`*.sh`(`protected_paths.ts`の`isNewShellScript`)
 * 3. `package.json`の`scripts`の変更(呼び出し側が
 *    `steps/pr_workflow_support.ts`の`packageJsonScriptsChanged`で判定して渡す)
 * 3は`package.json`の保護パスの行に含まれるが、より具体的な注記として残す。
 * 保護対象の接頭辞の下に新しい`*.sh`を追加すると、1と2の両方の行が出る。
 *
 * pr_fixの`detectForbiddenChanges`と違い、これは処理を止めない。
 * 結果はimplementのラウンドに保存し、PR本文の「確認して欲しい点」と
 * Discordの`pr_opened`通知に載せる。
 * 保護対象の変更があったラウンドでは、implement_verifyが検証コマンドを実行しない。
 */
export function classifyProtectedChanges(
  changes: readonly ChangedPath[],
  packageJsonScriptsChanged: boolean,
): readonly string[] {
  const reasons: string[] = [];
  for (const change of changes) {
    if (matchesImplementProtectedPath(change.path)) {
      reasons.push(`保護パスを変更: ${change.path}`);
    }
  }
  for (const change of changes) {
    if (isNewShellScript(change)) {
      reasons.push(`新規の*.shを追加: ${change.path}`);
    }
  }
  if (packageJsonScriptsChanged) {
    reasons.push("package.jsonのscriptsを変更");
  }
  return reasons;
}

/**
 * ラウンドで検証コマンドを実行しなかった理由の文言。
 * PR本文の「検査未実施」、Discordの`pr_opened`、
 * `implement_rounds.checks_skipped_reason`で同じ文言を使う。
 */
export const IMPLEMENT_CHECK_SKIP_REASONS = {
  protected_paths: "保護パスを変更したため",
  no_commands: "検査コマンドが未設定のため",
} as const;

// ---------------------------------------------------------------------------
// truncateCheckOutput: `implement_rounds.check_output`には先頭16KBだけを残す
// ---------------------------------------------------------------------------

export const CHECK_OUTPUT_MAX_BYTES = 16 * 1024;

/** `byte`がUTF-8の継続バイト(`10xxxxxx`)かを返す。 */
function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * `text`の先頭`maxBytes`バイトを、正しいUTF-8の文字列として返す。
 * バイトの境界がマルチバイト文字を分断するときは、その文字ごと捨てる。
 * 列の上限はバイト数で決めているため、UTF-16のコード単位ではなくバイトで測る。
 * PostgreSQLの`text`列はNUL文字を受け付けないので、先にNULを取り除く。
 *
 * 呼び出し側は、`maskSecrets`を適用した後の検証コマンドの出力全体を、
 * `insertImplementRound`の前に渡す。
 * プロンプト向けの末尾(`runAllowedCheckCommands`の`outputTail`)ではない。
 */
export function truncateCheckOutput(
  text: string,
  maxBytes: number = CHECK_OUTPUT_MAX_BYTES,
): string {
  const clean = text.replaceAll("\u0000", "");
  const bytes = new TextEncoder().encode(clean);
  if (bytes.byteLength <= maxBytes) return clean;
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end] ?? 0)) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

// ---------------------------------------------------------------------------
// buildImplementPrBody: PRテンプレートの各節をラウンドの結果で埋める
// ---------------------------------------------------------------------------

/** PR本文の「確認して欲しい点」に出す注記。Issueの取り込み後に題名か本文が変わったときだけ出す。 */
export const ISSUE_UPDATED_AFTER_INTAKE_NOTE =
  "この実装は要件定義を作ったときのIssueの内容に基づいており、その後にIssueの題名か本文が更新されています。";

/** 改行コードを`\n`に揃え、前後の空白を除く。GitHubの編集画面は内容を変えずに改行コードを`\r\n`にすることがある。 */
function normalizeIssueText(text: string | null): string {
  return (text ?? "").replaceAll("\r\n", "\n").trim();
}

/**
 * 取り込み時点のIssue(work_items.title / body。要件定義の生成に使った内容)と現在のIssueで、
 * 題名か本文が違えばtrueを返す。実装のプロンプトは常に取り込み時点の内容を使い、
 * この判定はPR本文に注記を足すためだけに使う。
 */
export function issueChangedSinceIntake(
  snapshot: { readonly title: string | null; readonly body: string | null },
  live: { readonly title: string; readonly body: string },
): boolean {
  return (
    normalizeIssueText(snapshot.title) !== normalizeIssueText(live.title) ||
    normalizeIssueText(snapshot.body) !== normalizeIssueText(live.body)
  );
}

export const NO_ACCEPTANCE_CRITERIA_NOTE =
  "(要件定義に受入条件の節がありません)";

const ACCEPTANCE_CRITERIA_HEADING = "受入条件";

/**
 * 承認済みの要件定義書から`## 受入条件`の本文をそのまま取り出す。
 * PR本文の受入条件の節に使う。
 * 節が無いか空のときは、固定の注記を返す。
 * そのような文書は要件定義の検証で弾かれるが、
 * PR本文で空の節を黙って表示することは避けるためである。
 */
export function extractAcceptanceCriteria(markdown: string): string {
  const body = extractSectionBody(markdown, ACCEPTANCE_CRITERIA_HEADING).trim();
  return body.length === 0 ? NO_ACCEPTANCE_CRITERIA_NOTE : body;
}

export type DeployNeeds = {
  /**
   * `f/`・`migrations/`・`.claude/skills/`のいずれかが変わった。
   * マージ後に`self_update`が自動で反映する。
   */
  readonly autoApply: boolean;
  /**
   * `infra/`か`mise.toml`が変わった。
   * `self_update`は反映せず、次にホストで`mise run up`して起動したときに
   * 反映される(通知はしない)。
   */
  readonly onNextUp: boolean;
};

const AUTO_APPLY_PATH_PREFIXES: readonly string[] = [
  "f/",
  "migrations/",
  ".claude/skills/",
];

/**
 * 差分のパスから、PRテンプレートの「備考」のチェックリストを機械的に判定する。
 * `autoApply`は`self_update`が自動で反映するパスの有無、
 * `onNextUp`は`self_update_support.ts`の`classifyChangedPaths`と同じ基準の
 * 「次の`mise run up`での起動時に反映される」変更の有無である。
 * `mise.toml`は、このフローに変更前後の内容が無く`[tools]`・`[env]`の差分を
 * 判定できないため、`classifyChangedPaths`に`true`を渡して
 * 変更があれば必要とみなす(安全側)。
 * 意味があるのはFactory自身のリポジトリだけである。
 * 他のリポジトリにも`infra/`、`migrations/`、`f/`があるかもしれず、
 * Windmillと関係ないパスで項目に印が付いてしまう。
 * そのため呼び出し側が`ImplementPrBodyInput`の`deployChecklist`で使うかを決める。
 */
export function classifyDeployNeeds(
  changedPaths: readonly string[],
): DeployNeeds {
  return {
    autoApply: changedPaths.some((path) =>
      AUTO_APPLY_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
    ),
    onNextUp: classifyChangedPaths(changedPaths, true).needs_host_action,
  };
}

export type ImplementCheckSummary =
  | {
      readonly kind: "ran";
      readonly results: readonly {
        readonly command: string;
        readonly ok: boolean;
      }[];
    }
  | { readonly kind: "skipped"; readonly reason: string };

export type ImplementPrBodyInput = {
  /** Claudeの`summary`。呼び出し側が先に`normalizeJapaneseText`を適用する。 */
  readonly summary: string;
  /** 承認済みの要件定義書(`requirement_drafts`のMarkdown)。 */
  readonly requirementsMarkdown: string;
  /** 最後のラウンドの検証結果。 */
  readonly checks: ImplementCheckSummary;
  /** 最終の差分に対する`classifyProtectedChanges`の行。 */
  readonly protectedChanges: readonly string[];
  /** Claudeの`notes_for_reviewer`。呼び出し側が先に正規化する。 */
  readonly notesForReviewer: readonly string[];
  /** `approval_support.ts`の`buildConsoleUrl(url, { work_item_id })`の値。 */
  readonly requirementsConsoleUrl: string;
  readonly issueNumber: number;
  readonly changedPaths: readonly string[];
  /**
   * 対象のリポジトリがFactory自身なら`true`(呼び出し側が判定する)。
   * そのときだけ「備考」にWindmillへの反映のチェックリストを載せ、
   * それ以外は「なし」にする。
   */
  readonly deployChecklist: boolean;
  /** trueなら「確認して欲しい点」のConsoleリンクの直前にISSUE_UPDATED_AFTER_INTAKE_NOTEを出す。 */
  readonly issueUpdatedAfterIntake: boolean;
};

/*
 * PR本文に入れる、Claudeが書いた文字列を無害化する関数群。
 * ClaudeはIssueとリポジトリを読むので、その文字列は信頼できない入力の影響を受ける。
 * PR本文はGitHubが表示し、Factory自身も解析するので、次の3つを無害化する。
 * - 見出しやHTMLブロックの注入: `#`の見出し、setext形式の下線、生の`<`
 *   (`<!--`や`<details>`など)は、新しい節を開いたり、文字を隠したり、
 *   テンプレートの節の構造を変えたりできる。
 * - closing keywordの乗っ取り: `fixes #5`があると、マージ時にGitHubがIssue #5を閉じ、
 *   `poll_prs`の`extractLinkedIssueNumbers`がPRを誤ったIssueに結び付ける。
 *   そのため`#<数字>`はすべてエスケープする。
 *   本物の`Closes #N`は、無害化した文字列の外で`buildImplementPrBody`が書く。
 * - メンション: `@user`や`@org/team`は人に通知が飛ぶ。
 * 該当する文字の前にバックスラッシュを入れる(GitHubは`\#`、`\<`、`\@`を
 * その文字そのものとして表示する)。奇数個のバックスラッシュでエスケープ済みの文字は
 * そのままにする。自分で入れたエスケープを`\\#`と二重にすると、
 * 文字の効果が戻ってしまうためである。
 */

const ATX_HEADING_LINE = /^(\s{0,3})#/;
const SETEXT_UNDERLINE_LINE = /^(\s{0,3})(=+|-+)\s*$/;
const MENTION_START = /^[A-Za-z0-9_]$/;
const DIGIT = /^[0-9]$/;

function needsInlineEscape(char: string, next: string): boolean {
  if (char === "<") return true;
  if (char === "#") return DIGIT.test(next);
  if (char === "@") return MENTION_START.test(next);
  return false;
}

/**
 * エスケープされていない(直前のバックスラッシュが偶数個の)`<`、`#<数字>`、
 * `@<英数字か_>`の前に`\`を入れる。
 */
function escapeInlineTriggers(text: string): string {
  let out = "";
  let backslashes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (
      char !== "\\" &&
      backslashes % 2 === 0 &&
      needsInlineEscape(char, text.charAt(i + 1))
    ) {
      out += "\\";
    }
    out += char;
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  return out;
}

function escapeBlockLine(line: string): string {
  if (ATX_HEADING_LINE.test(line)) {
    return line.replace(ATX_HEADING_LINE, "$1\\#");
  }
  if (SETEXT_UNDERLINE_LINE.test(line)) {
    return line.replace(/^(\s{0,3})([=-])/, "$1\\$2");
  }
  return line;
}

/**
 * Claudeが書いた複数行の文章(summary)を無害化する。
 * `\r`を取り除き、ATX形式の見出しの行とsetext形式の下線の行をエスケープしてから、
 * 文中のすべての`<`、`#<数字>`、`@<英数字か_>`をエスケープする。
 */
export function sanitizePrProse(text: string): string {
  const blockSafe = text
    .replaceAll("\r", "")
    .split("\n")
    .map(escapeBlockLine)
    .join("\n");
  return escapeInlineTriggers(blockSafe);
}

/**
 * 1行のリスト項目(レビュアーへの注記や保護対象の変更の行)を無害化する。
 * 項目が次の行にはみ出さないよう、改行を含む空白の並びを1つの空白にまとめ、
 * 前後の空白を除いてから`sanitizePrProse`を適用する。
 */
export function sanitizePrLine(text: string): string {
  return sanitizePrProse(text.replace(/\s*\n\s*/g, " ").trim());
}

function checkbox(checked: boolean, label: string): string {
  return `- [${checked ? "x" : " "}] ${label}`;
}

function renderDeployChecklist(changedPaths: readonly string[]): string[] {
  const needs = classifyDeployNeeds(changedPaths);
  const nothingToApply = !needs.autoApply && !needs.onNextUp;
  return [
    "Windmillへの反映:",
    "",
    checkbox(
      needs.autoApply,
      "マージ後に`self_update`が自動で反映する(`f/`・`migrations/`・`.claude/skills/`の変更)",
    ),
    checkbox(
      needs.onNextUp,
      "次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)",
    ),
    checkbox(nothingToApply, "反映するものは無い"),
  ];
}

function renderChecks(checks: ImplementCheckSummary): string {
  if (checks.kind === "skipped") {
    return `検査未実施: ${checks.reason}`;
  }
  return checks.results
    .map((result) => `- ${result.ok ? "pass" : "fail"}: \`${result.command}\``)
    .join("\n");
}

/**
 * `.github/PULL_REQUEST_TEMPLATE.md`の節の順にPR本文を組み立てる。
 * - 概要: summary
 * - 受入条件: 要件定義書の表
 * - 動作確認結果: 最後のラウンドの検証結果(実行しなかったときは「検査未実施」と理由)
 * - 確認して欲しい点: 保護対象の変更、レビュアーへの注記、
 *   Issueの取り込み後の更新の注記(`issueUpdatedAfterIntake`のときだけ)、
 *   承認済みの要件定義を開くConsoleのリンク
 * - 関連リンク: `Closes #N`。PRの作業項目をIssueに結び付ける。
 *   `poll_prs.ts`の`extractLinkedIssueNumbers`はこの形を読む。
 * - 備考: Factory自身のリポジトリ(`deployChecklist`)なら
 *   `classifyDeployNeeds`による反映のチェックリスト、それ以外は「なし」
 * マーカーや告知の文は入れない。運用上の告知はDiscordとConsoleに出す。
 */
export function buildImplementPrBody(input: ImplementPrBodyInput): string {
  const attention = [
    ...input.protectedChanges.map((line) => `- ${sanitizePrLine(line)}`),
    ...input.notesForReviewer.map((line) => `- ${sanitizePrLine(line)}`),
    ...(input.issueUpdatedAfterIntake
      ? [`- ${ISSUE_UPDATED_AFTER_INTAKE_NOTE}`]
      : []),
    `- 要件定義(Console): ${input.requirementsConsoleUrl}`,
  ];
  return [
    "## 概要",
    "",
    sanitizePrProse(input.summary.trim()),
    "",
    "## 受入条件",
    "",
    extractAcceptanceCriteria(input.requirementsMarkdown),
    "",
    "## 動作確認結果",
    "",
    renderChecks(input.checks),
    "",
    "## 確認して欲しい点",
    "",
    ...attention,
    "",
    "## 関連リンク",
    "",
    `Closes #${String(input.issueNumber)}`,
    "",
    "## 備考",
    "",
    ...(input.deployChecklist
      ? renderDeployChecklist(input.changedPaths)
      : ["なし"]),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// decideImplementRoundExit: 検証ループの終了条件(検証が通るまで修正を繰り返す)
// ---------------------------------------------------------------------------

export type ImplementRoundExit =
  | "checks_passed"
  | "checks_skipped"
  | "max_rounds"
  | "daily_budget"
  | "deadline"
  | "stalled"
  | "requirements_gap"
  | "continue";

export type ImplementRoundExitInput = {
  readonly claudeOutcome: ImplementClaudeOutcome;
  /** `skipped`は、保護パスを変更したか、検証コマンドが未設定であることを表す。 */
  readonly checks: "passed" | "failed" | "skipped";
  /** この検証ループの中でのラウンド番号(1始まり)。DBの連番ではない。 */
  readonly round: number;
  /** `factory_config.implement_max_rounds`の値。 */
  readonly maxRounds: number;
  readonly dailyBudgetExceeded: boolean;
  /** 検査に失敗した後、期限までの残りが修正ラウンドの最悪の所要時間(fixRoundWorstCaseSec)に足りない。 */
  readonly deadlineReached: boolean;
  /** このラウンドの検証出力全体の`stallHash`。何も実行しなかったときは`null`。 */
  readonly checkOutputHash: string | null;
  readonly previousCheckOutputHash: string | null;
  /** このラウンドのworktreeの差分の`stallHash`。 */
  readonly diffHash: string;
  readonly previousDiffHash: string | null;
};

/** flow.yamlの実装・検証ステップ(implement_generate / implement_verify)のtimeout(秒)。上げるときはflow.yamlと同じ変更で上げる(tests/scripts/implement_flow.test.tsが一致を確かめる)。 */
export const IMPLEMENT_STEP_TIMEOUT_SEC = 21_600;

/**
 * 1ラウンドのうち、Claudeと検査コマンド以外にかかりうる時間(秒)。
 * gitleaks(最大300秒)と、gitとDBの操作の余裕300秒。
 * 生成・検証ステップの操作はrepoのロックを取らないので、その待ちは含めない(待つのは準備と完了で、それぞれのstep timeoutの中で待つ)。
 */
export const IMPLEMENT_OVERRUN_BASE_SEC = 600;

/** 検査コマンド1件がtimeoutの後に上乗せしうる停止と出力待ちの時間(秒)。ランナーの最大13秒を切り上げた値。worktreeのロックを待つ時間はコマンドのtimeoutの内側で数えるので含めない。 */
export const CHECK_COMMAND_STOP_OVERHEAD_SEC = 15;

export const IMPLEMENT_TIMEOUT_MISFIT_REASON =
  "implement time settings do not fit the flow step timeout";

/** 実装フローの期限(epoch ms)を返す。準備を始めた時刻にimplement_flow_timeout_secを足す。 */
export function implementDeadlineAt(
  startedAtMs: number,
  flowTimeoutSec: number,
): number {
  return startedAtMs + flowTimeoutSec * 1000;
}

/** ステップ間を渡ったcontextのdeadline_atを検証して返す。有限の数でなければ例外を投げる。期限の無い実行を続けず、NaNで全ラウンドが即時timeoutになるのも防ぐ。 */
export function requireDeadlineAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `implement context has no valid deadline_at: ${String(value)}`,
    );
  }
  return value;
}

/**
 * 修正ラウンド1回の最悪の所要時間(秒)を返す。
 * Claudeがimplement_timeout_secまで、gitleaksとgit・DBの操作が基礎の値まで、すべての検査コマンドがimplement_check_timeout_secと停止の上乗せまでかかった場合である。
 * 期限までの残りがこれ以上のときだけ修正ラウンドを始めるので、Claude・gitleaks・検査コマンドがそれぞれのtimeoutまでかかっても、始めたラウンドは期限までに終わる。
 * 例外は、不正な出力の後のClaudeの再試行1回で、これは期限までの残りで打ち切る。打ち切られたラウンドはclaude_errorで終わり、差分をpushしない。
 * 期限で切られたClaudeの差分は検査を経ずに捨てることになるので、実測ではなく最悪値で判定する。
 */
export function fixRoundWorstCaseSec(
  config: Pick<
    FactoryConfig,
    "implement_timeout_sec" | "implement_check_timeout_sec"
  >,
  checkCommandCount: number,
): number {
  return (
    config.implement_timeout_sec +
    IMPLEMENT_OVERRUN_BASE_SEC +
    checkCommandCount *
      (config.implement_check_timeout_sec + CHECK_COMMAND_STOP_OVERHEAD_SEC)
  );
}

/**
 * 実装フローの時間設定が、flow.yamlの実装・検証ステップのtimeoutに収まらなければ理由を返し、収まればnullを返す。
 * 検証ステップは、期限の直前に始まった最初のラウンドの検査部分を期限の後も走らせうる。
 * そのため、期限と、1ラウンド分のgitleaks・git・DB・検査コマンドの和で見積もる(git・DBの操作には個別の上限が無いので、和で余裕を取る)。
 * Claude 1回は、期限の頭打ちが効かない場合でもステップに収まることを確かめる。
 * 理由は`describeReason`が"; "で分けないよう、セミコロンを含めない。
 */
export function implementTimeoutMisfit(
  config: Pick<
    FactoryConfig,
    | "implement_flow_timeout_sec"
    | "implement_timeout_sec"
    | "implement_check_timeout_sec"
  >,
  checkCommandCount: number,
): string | null {
  const perCommand =
    config.implement_check_timeout_sec + CHECK_COMMAND_STOP_OVERHEAD_SEC;
  const verifyTotal =
    config.implement_flow_timeout_sec +
    IMPLEMENT_OVERRUN_BASE_SEC +
    checkCommandCount * perCommand;
  if (verifyTotal > IMPLEMENT_STEP_TIMEOUT_SEC) {
    return `${IMPLEMENT_TIMEOUT_MISFIT_REASON}: implement_flow_timeout_sec ${String(config.implement_flow_timeout_sec)} + ${String(IMPLEMENT_OVERRUN_BASE_SEC)} + ${String(checkCommandCount)} check commands x (implement_check_timeout_sec ${String(config.implement_check_timeout_sec)} + ${String(CHECK_COMMAND_STOP_OVERHEAD_SEC)}) = ${String(verifyTotal)}s exceeds ${String(IMPLEMENT_STEP_TIMEOUT_SEC)}s`;
  }
  const claudeTotal = config.implement_timeout_sec + IMPLEMENT_OVERRUN_BASE_SEC;
  if (claudeTotal > IMPLEMENT_STEP_TIMEOUT_SEC) {
    return `${IMPLEMENT_TIMEOUT_MISFIT_REASON}: implement_timeout_sec ${String(config.implement_timeout_sec)} + ${String(IMPLEMENT_OVERRUN_BASE_SEC)} = ${String(claudeTotal)}s exceeds ${String(IMPLEMENT_STEP_TIMEOUT_SEC)}s`;
  }
  return null;
}

/**
 * implement_verifyが修正のラウンドをもう1回回すか、どの理由で終えるかを決める。
 * 判定は次の優先順で行う。
 * 1. Claude自身が`requirements_gap`を返したら、必ずループを終える。
 * 2. 検証を実行しなかったラウンドは`checks_skipped`で終える(GitHubのCIに任せる)。
 * 3. 検証が通ったら終える。
 * 4. ガードとして、ラウンド上限、日次予算、フロー全体の期限、停滞の検出を確かめる。
 *    停滞は、差分か検証出力が前のラウンドと同じ状態で、
 *    もう1回修正しても予算を使うだけになる。
 * `continue`は、検証が失敗し、どのガードにも当たらなかったことを表す。
 * 終了の理由から`implement_rounds.outcome`への対応は`roundOutcomeForExit`が決める。
 */
export function decideImplementRoundExit(
  state: ImplementRoundExitInput,
): ImplementRoundExit {
  if (state.claudeOutcome === "requirements_gap") return "requirements_gap";
  if (state.checks === "skipped") return "checks_skipped";
  if (state.checks === "passed") return "checks_passed";
  if (state.round >= state.maxRounds) return "max_rounds";
  if (state.dailyBudgetExceeded) return "daily_budget";
  if (state.deadlineReached) return "deadline";
  if (
    state.previousDiffHash !== null &&
    state.diffHash === state.previousDiffHash
  ) {
    return "stalled";
  }
  if (
    state.checkOutputHash !== null &&
    state.previousCheckOutputHash !== null &&
    state.checkOutputHash === state.previousCheckOutputHash
  ) {
    return "stalled";
  }
  return "continue";
}

/**
 * 検証ループを`exit`で終えたラウンドの`implement_rounds.outcome`を返す。
 * `continue`の場合は、検証が失敗して次に修正のラウンドが続くラウンドの値になる。
 * - `checks_passed`は`done`にする。
 * - `checks_skipped`、`stalled`、`requirements_gap`は同じ名前のままにする。
 * - `max_rounds`、`daily_budget`、`deadline`、`continue`は、どれも検証が失敗したラウンドなので
 *   `check_failed`にする。
 */
export function roundOutcomeForExit(
  exit: ImplementRoundExit,
): ImplementRoundOutcome {
  switch (exit) {
    case "checks_passed":
      return "done";
    case "checks_skipped":
      return "checks_skipped";
    case "stalled":
      return "stalled";
    case "requirements_gap":
      return "requirements_gap";
    case "max_rounds":
    case "daily_budget":
    case "deadline":
    case "continue":
      return "check_failed";
  }
}

/**
 * `text`のsha256を16進で返す。ラウンドの差分と検証出力の停滞検出に使う指紋である。
 * 差分の指紋には追跡されていないファイルを含めること
 * (`git add -A --intent-to-add`の後に`git diff HEAD`を取る、
 * またはporcelainの状態と差分を合わせるなど)。
 * 素の`git diff`は新しいファイルを含まないので、ファイルを追加しただけのラウンドが
 * 前のラウンドと同じ指紋になり、誤って停滞と判定してしまう。
 */
export function stallHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// isRequirementsApprovedForAttempt: implement_prepareの関門と、
// retry_work_itemがimplementとpipelineのどちらを再実行するかの判定に使う
// ---------------------------------------------------------------------------

/**
 * `approval`(`db.latestRequirementsApproval`の行か`null`)が、
 * ちょうど`attempt`回目の要件定義を承認したものかを返す。
 */
export function isRequirementsApprovedForAttempt(
  approval: { readonly status: string; readonly attempt: number } | null,
  attempt: number,
): boolean {
  return (
    approval !== null &&
    approval.status === "approved" &&
    approval.attempt === attempt
  );
}

// ---------------------------------------------------------------------------
// ブランチのPRで動いている修正・レビュー
// ---------------------------------------------------------------------------

export const ACTIVE_PR_RUN_REASON = "pull request has an active fix run";

/** ブランチのPRで、終端に達していないpr_fix / pr_reviewがある(`hasUnfinishedPrRun`)。実装フローの準備はworktreeに触れずに止まる。 */
export class ActivePrRunError extends Error {
  constructor() {
    super(ACTIVE_PR_RUN_REASON);
    this.name = "ActivePrRunError";
  }
}
