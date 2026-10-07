// headless Claudeが書いた監査レポート(`.claude/skills/factory-audit/`の
// `template.md`と`SKILL.md`)と、一緒に出す構造化出力(要約と改善提案)を
// 機械的に検査する。
// すべてI/OやWindmill・GitHubに依存しない純粋関数のため、監査の
// パイプライン(工程5)と同じ検査を単体テストでも行える。
//
// 各`check*`関数は日本語の問題点の一覧を返す(問題が無ければ空)。
// `validateAuditReport`はレポート単位の検査をまとめて1つの結果にし、
// `checkAuditOutput`は構造化出力を別に検査する。

import {
  checkForbiddenSyntax,
  checkLengths,
  extractH2Headings,
} from "./requirements_doc.ts";

/** 生成した監査レポートを置く基底ディレクトリ。workerだけが使うvolumeにある。 */
export const AUDIT_BASE_DIR = "/var/lib/factory/audits";

/** 唯一の基準となるテンプレートのパス(リポジトリのルートからの相対パス)。 */
export const AUDIT_TEMPLATE_RELATIVE_PATH =
  ".claude/skills/factory-audit/template.md";

/**
 * 1回の監査でheadless Claudeが読む、Factoryのself cloneから作る
 * 使い捨てのdetached worktreeのディレクトリを返す。
 * その実行の作業用ディレクトリと同じ階層に置く。
 * `self_update`がデプロイ元にする稼働中のself cloneを、モデルに見せないためである。
 */
export function auditSnapshotDir(workItemId: number): string {
  return `${AUDIT_BASE_DIR}/wi-${String(workItemId)}-snapshot`;
}

/** 生成した監査レポートのファイル名。 */
export const REPORT_MD_FILENAME = "report.md";

/** 集めた根拠資料のファイル名。 */
export const EVIDENCE_MD_FILENAME = "evidence.md";

/**
 * 監査レポートのテンプレートが持つ`##`見出しの固定の並び。
 * `checkAuditSections`は、生成された文書の見出しをこの一覧と順序まで含めて比べる。
 */
export const AUDIT_SECTIONS: readonly string[] = [
  "対象期間と要約",
  "実行状況",
  "失敗と要人手",
  "承認の傾向",
  "改善提案",
  "見送った論点",
];

/**
 * 監査の構造化出力に含まれる改善提案1件。
 * タイトルはレポートの改善提案の表のいずれかの行と一致させる。
 */
export type AuditProposal = { readonly title: string; readonly body: string };

const MAX_SUMMARY_CHARS = 200;
const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 3000;
const MAX_PROPOSALS = 5;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/;
const HTML_COMMENT_GLOBAL_PATTERN = /<!--[\s\S]*?-->/g;
/**
 * 読み手やMarkdownの描画処理がリンクとみなしうるものすべてに一致する。
 * 大文字小文字を問わない`http(s)://`のURL、スキームを省いた`//host`、
 * 裸の`www.host`が対象である。
 * `//host`は直前が単語文字・`:`・`/`でないものに限り、`https://`の中の
 * `//`やパス中の連続したスラッシュは数えない。
 * 一致したものは、許可リストと比べる前に`normalizeUrl`で正規化する。
 */
const URL_PATTERN =
  /(?:https?:\/\/|(?<![\w:/])\/\/(?=[\w-])|(?<![\w.])www\.)[^\s)>"']*/gi;
const SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;
/**
 * 許可リストのURLの接頭辞の直後に続いてよい文字。
 * 単純な`startsWith`では、接頭辞`https://github.com/octo/atelier-works`に対して
 * `https://github.com/octo/atelier-works-evil`も通ってしまう。
 * そのため、接頭辞と完全に一致するか、パス・クエリ・フラグメントの
 * 区切りで続く場合だけを許す。
 */
const URL_PREFIX_BOUNDARY_CHARS = new Set(["/", "?", "#"]);

/**
 * `checkForbiddenSyntax`に渡す前に、`text`からHTMLコメントを取り除く。
 * HTMLコメントは`<`で始まり次の`>`で終わるため、その検査の
 * 「残ったHTMLタグ・埋めていないプレースホルダ」のパターンにも一致する。
 * 取り除かないと、1つのコメントが`checkHtmlComments`と
 * `checkForbiddenSyntax`の両方で二重に報告される。
 */
function stripHtmlComments(text: string): string {
  return text.replace(HTML_COMMENT_GLOBAL_PATTERN, "");
}

/**
 * `url`が許可リストの接頭辞1つに当てはまるかを返す。
 * 完全に一致するか、接頭辞の直後がパス・クエリ・フラグメントの区切り
 * (`/`、`?`、`#`)である場合に当てはまるとみなす。
 * 単純な`url.startsWith(prefix)`では、名前の先頭が同じだけの別の
 * リポジトリ(接頭辞`.../atelier-works`に対する`.../atelier-works-evil`など)も
 * 通してしまう。
 */
function matchesUrlPrefix(url: string, prefix: string): boolean {
  const normalizedUrl = normalizeUrl(url);
  const normalizedPrefix = prefix.toLowerCase();
  if (normalizedUrl === normalizedPrefix) return true;
  if (!normalizedUrl.startsWith(normalizedPrefix)) return false;
  const boundary = normalizedUrl.charAt(normalizedPrefix.length);
  return URL_PREFIX_BOUNDARY_CHARS.has(boundary);
}

/**
 * `URL_PATTERN`に一致した文字列を小文字にし、スキームの無い形
 * (`//host`、`www.host`)には`https://`を補う。
 * こうして完全なURLと同じように許可リストと比べる。
 * 正規化しても許可された接頭辞に当てはまらない形は、安全側に倒して拒否される。
 */
function normalizeUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("//")) return `https:${lower}`;
  if (lower.startsWith("www.")) return `https://${lower}`;
  return lower;
}

/**
 * Issueに載る構造化出力の文字列1つ(提案のタイトルと本文、または要約)に、
 * HTMLコメント、`checkForbiddenSyntax`、URLの許可リストの検査をかける。
 * 問題点にはそれぞれ`label`を前置きする。
 */
function checkIssueText(
  text: string,
  label: string,
  allowedUrlPrefixes: readonly string[],
): string[] {
  const issues = [
    ...checkHtmlComments(text).map((issue) => `${label}: ${issue}`),
    ...checkForbiddenSyntax(stripHtmlComments(text)).map(
      (issue) => `${label}: ${issue}`,
    ),
  ];
  for (const url of text.match(URL_PATTERN) ?? []) {
    if (!allowedUrlPrefixes.some((prefix) => matchesUrlPrefix(url, prefix))) {
      issues.push(`${label}に許可されていないURLが含まれています`);
    }
  }
  return issues;
}

/**
 * `| a | b |`形式の表の行をセルに分ける。
 * GFMのエスケープされたパイプ(`\|`は列の区切りではなく文字の`|`)を
 * 区切りとして扱わず、結果ではエスケープを外す。
 * それ以外は`row.split("|")`と同じ形(両端の`|`による空のセルも含む)で返すため、
 * 添字でセルを取り出す呼び出し側(タイトルの列など)を変えずに済む。
 */
function splitTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i += 1) {
    const char = row.charAt(i);
    if (char === "\\" && row.charAt(i + 1) === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * `row`が表の区切り行かを返す。
 * 両端の`|`による空のセルを除き、すべてのセルが`:?-{3,}:?`に一致すれば区切り行とみなす。
 */
function isSeparatorRow(row: string): boolean {
  const cells = splitTableRow(row).filter((cell) => cell !== "");
  return (
    cells.length > 0 && cells.every((cell) => SEPARATOR_CELL_PATTERN.test(cell))
  );
}

/** `markdown`の`##`見出しが、順序も含めて`AUDIT_SECTIONS`と完全に一致するかを検査する。 */
export function checkAuditSections(markdown: string): string[] {
  const headings = extractH2Headings(markdown);
  const inOrder =
    headings.length === AUDIT_SECTIONS.length &&
    headings.every((heading, index) => heading === AUDIT_SECTIONS[index]);
  if (inOrder) {
    return [];
  }
  return [
    `章立てがテンプレートと一致しません(期待: ${AUDIT_SECTIONS.join(" / ")}、実際: ${headings.join(" / ")})`,
  ];
}

/**
 * 残ったHTMLコメントを検出する。
 * `<!-- factory:issue_proposal:1 -->`のような内部の目印が、
 * レポートや構造化出力に漏れてはならないためである。
 */
export function checkHtmlComments(text: string): string[] {
  return HTML_COMMENT_PATTERN.test(text)
    ? ["HTMLコメントが含まれています"]
    : [];
}

const H2_HEADING_PATTERN = /^##\s+(.*\S)\s*$/;

/**
 * `heading`という名前の`##`の節の本文(その見出しから次の`##`見出し、
 * または文書の終わりまでの行)を返す。見出しが無ければ`null`を返す。
 */
function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex(
    (line) => line.match(H2_HEADING_PATTERN)?.[1] === heading,
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^##\s/.test(line));
  return (next < 0 ? rest : rest.slice(0, next)).join("\n");
}

/**
 * 改善提案の節にある表のタイトルの列を、行の順に返す。
 * 節の本文が「該当なし」だけなら(その期間に提案が無い)`[]`を返す。
 * 節が無いか表を解析できないときは`null`を返す。
 * 解析できないのは、見出し行・区切り行・データ行1つに満たない場合と、
 * 2つ目の`|`の行が正しい区切り行でない場合である。後者を確かめないと、
 * 区切り行の無い表で最初のデータ行を区切り行と取り違えて、気づかないまま
 * 誤って解析してしまう。
 */
export function extractProposalTitles(markdown: string): string[] | null {
  const body = sectionBody(markdown, "改善提案");
  if (body === null) return null;
  // 意図して完全一致だけを認める。一部だけや余計な文字を含む「該当なし」は、
  // 意図した目印より誤りである可能性が高い。そのため「提案なし」とは受け取らず
  // 表の解析に進め、表に見えなければ`null`にする。寛容さより安全側を優先する。
  if (body.trim() === "該当なし") return [];
  const rows = body.split("\n").filter((line) => line.trim().startsWith("|"));
  if (rows.length < 3) return null;
  const separatorRow = rows[1] ?? "";
  if (!isSeparatorRow(separatorRow)) return null;
  return rows.slice(2).map((row) => splitTableRow(row)[2] ?? "");
}

/**
 * レポートの改善提案の表に並ぶタイトルが、構造化出力の`proposals`の
 * タイトルと(順序を問わず集合として)完全に一致するかを検査する。
 */
export function checkProposalTable(
  markdown: string,
  proposals: readonly AuditProposal[],
): string[] {
  const titles = extractProposalTitles(markdown);
  if (titles === null) return ["改善提案の表が読めません"];
  const expected = [...proposals.map((p) => p.title)].sort();
  const actual = [...titles].sort();
  const matches =
    expected.length === actual.length &&
    expected.every((title, index) => title === actual[index]);
  if (!matches) {
    return [
      `改善提案の表(${actual.length}件)と構造化出力(${expected.length}件)のタイトルが一致しません`,
    ];
  }
  return [];
}

export type AuditReportValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: string[] };

/** 書き終えた監査レポートにレポート単位の検査をすべてかけ、結果を1つの判定にまとめる。 */
export function validateAuditReport(
  markdown: string,
  proposals: readonly AuditProposal[],
): AuditReportValidation {
  const issues = [
    ...checkAuditSections(markdown),
    ...checkForbiddenSyntax(stripHtmlComments(markdown)),
    ...checkHtmlComments(markdown),
    ...checkLengths(markdown),
    ...checkProposalTable(markdown, proposals),
  ];
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * 監査の構造化出力(要約と提案)を検査する。
 * 要約の長さ、提案ごとのタイトルと本文の長さ、タイトルの重複、提案の件数を見る。
 * さらに要約とすべての提案に同じ検査(`checkIssueText`)をかけ、
 * HTMLコメント、`checkForbiddenSyntax`によるAI文章の癖、URLを確かめる。
 * URLは大文字小文字を問わず、スキームの無い`//host`や`www.host`も含め、
 * すべて`allowedUrlPrefixes`のいずれかに当てはまる必要がある
 * (このリポジトリのGitHubのURLなどを渡し、モデルがほかを指せないようにする)。
 * 当てはまるかは、単なる文字列の接頭辞ではなく、パス・クエリ・フラグメントの
 * 区切りまで含めて判定する(`matchesUrlPrefix`を参照)。
 */
export function checkAuditOutput(
  output: {
    readonly summary: string;
    readonly proposals: readonly AuditProposal[];
  },
  allowedUrlPrefixes: readonly string[],
): string[] {
  const issues: string[] = [];
  if (output.summary.length > MAX_SUMMARY_CHARS) {
    issues.push(`summaryが${MAX_SUMMARY_CHARS}字を超えています`);
  }
  issues.push(...checkIssueText(output.summary, "summary", allowedUrlPrefixes));
  if (output.proposals.length > MAX_PROPOSALS) {
    issues.push(`提案が${MAX_PROPOSALS}件を超えています`);
  }
  const seen = new Set<string>();
  output.proposals.forEach((proposal, index) => {
    const label = `提案${index + 1}`;
    if (
      proposal.title.trim().length === 0 ||
      proposal.title.length > MAX_TITLE_CHARS
    ) {
      issues.push(`${label}のtitleが空か${MAX_TITLE_CHARS}字を超えています`);
    }
    if (proposal.body.length > MAX_BODY_CHARS) {
      issues.push(`${label}のbodyが${MAX_BODY_CHARS}字を超えています`);
    }
    const trimmedTitle = proposal.title.trim();
    if (seen.has(trimmedTitle)) {
      issues.push(`${label}のtitleが重複しています`);
    }
    seen.add(trimmedTitle);
    issues.push(
      ...checkIssueText(
        `${proposal.title}\n${proposal.body}`,
        label,
        allowedUrlPrefixes,
      ),
    );
  });
  return issues;
}
