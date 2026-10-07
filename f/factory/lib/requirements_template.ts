// 要件定義書テンプレートの固定値(節の一覧、IDの形式、長さの上限)を定義する。
// テンプレートの正本は`.claude/skills/factory-requirements/template.md`で、
// Claudeへのプロンプトと`requirements_doc.ts`の機械検証の両方が従う。
// 定義をここに集めて、テンプレートと検証器の食い違いをテストで検出する
// (`tests/lib/requirements_template.test.ts`が見出しの一致を確かめる)。

import { assertGitHubName } from "./types.ts";

/**
 * 要件定義書テンプレートの`##`見出しを、並び順どおりに並べたもの。
 * `requirements_doc.ts`の`checkSections`は、生成した文書の見出しを
 * 順序も含めてこの一覧と比べる。
 */
export const REQUIREMENTS_SECTIONS: readonly string[] = [
  "背景・目的",
  "スコープ",
  "用語",
  "利用者と利用シーン",
  "業務要件",
  "機能要件",
  "非機能要件",
  "制約・前提",
  "受入条件",
  "未決事項",
  "変更履歴",
];

/** 機能要件・非機能要件・受入条件の各表で使うIDの形式。 */
export const REQUIREMENT_ID_PATTERNS: {
  readonly FR: RegExp;
  readonly NFR: RegExp;
  readonly AC: RegExp;
} = {
  FR: /^FR-\d{3}$/,
  NFR: /^NFR-\d{3}$/,
  AC: /^AC-\d{3}$/,
};

/** 文書全体の文字数の上限の目安(タイトルと表を含む)。 */
export const MAX_DOC_CHARS = 8000;

/** 1行の文字数の上限の目安。 */
export const MAX_LINE_CHARS = 200;

/** 1つの要件定義書に埋め込める図の最大数。 */
export const MAX_DIAGRAMS = 3;

/** 地の文の1段落に含めてよい文の最大数。文は`。`で区切って数える。 */
export const MAX_SENTENCES_PER_PARAGRAPH = 3;

/** 図のファイル名・図名の形式。英小文字・数字・ハイフンだけを許す。 */
export const DIAGRAM_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * 本文に埋め込んだ図の参照`![name](name.drawio)`に一致する。
 * 後方参照(`\1`)で、リンクテキストとファイル名が同じ文字列であることを求める。
 * drawio-diagramスキルの命名規則(図名 = ファイル名 = 本文の参照)に合わせるため。
 */
export const DIAGRAM_REF_PATTERN = /!\[([a-z0-9-]{1,64})\]\(\1\.drawio\)/g;

/** テンプレートの正本のパス。リポジトリのルートからの相対パス。 */
export const TEMPLATE_RELATIVE_PATH =
  ".claude/skills/factory-requirements/template.md";

/**
 * 生成した要件定義書を置くディレクトリの基点。
 * workerだけがマウントするボリュームである。
 */
export const REQUIREMENTS_BASE_DIR = "/var/lib/factory/requirements";

/**
 * 生成1回分の要件定義書と図を書き込むディレクトリのパスを組み立てる。
 * 形式は`<base>/<owner>/<repo>/issue-<issueNumber>/wi-<workItemId>/attempt-<attempt>`。
 *
 * `owner`と`repo`はGitHubのwebhookやAPIから来る値なので、
 * パスに埋め込む前に`assertGitHubName`で検証する。
 * GitHubのログイン名・リポジトリ名として不正なら例外を投げる。
 * 数値の引数が0以上の整数でないときも例外を投げる。
 */
export function buildRequirementsDocDir(
  base: string,
  owner: string,
  repo: string,
  issueNumber: number,
  workItemId: number,
  attempt: number,
): string {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const numericParts: readonly (readonly [string, number])[] = [
    ["issueNumber", issueNumber],
    ["workItemId", workItemId],
    ["attempt", attempt],
  ];
  for (const [label, value] of numericParts) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `buildRequirementsDocDir: ${label} must be a non-negative integer (got ${String(value)})`,
      );
    }
  }
  return `${base}/${owner}/${repo}/issue-${String(issueNumber)}/wi-${String(workItemId)}/attempt-${String(attempt)}`;
}
