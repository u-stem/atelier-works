// 設計書テンプレートの固定値(章の一覧、IDの形式、ファイル名、置き場所)を定義する。
// テンプレートの正本は`.claude/skills/factory-design/template.md`で、
// Claudeへのプロンプトと`design_doc.ts`の機械検証の両方が従う。
// 定義をここに集めて、テンプレートと検証器の食い違いをテストで検出する
// (`tests/lib/design_template.test.ts`が見出しの一致を確かめる)。
// 長さの上限と図の数の上限は要件定義書と同じで、`requirements_template.ts`の定数を検査が使う。

import { dirname } from "node:path";
import { buildRequirementsDocDir } from "./requirements_template.ts";
import { assertGitHubName } from "./types.ts";

/**
 * 設計書テンプレートの`##`見出しを、並び順どおりに並べたもの。
 * `design_doc.ts`は、生成した文書の見出しを順序も含めてこの一覧と比べる。
 */
export const DESIGN_SECTIONS: readonly string[] = [
  "方針",
  "構成要素と境界",
  "データの流れ",
  "インターフェース",
  "エラーと境界条件",
  "テスト方針",
  "要件との対応表",
  "未決事項",
  "変更履歴",
];

/** 要件との対応表の各行に付けるIDの形式。 */
export const DESIGN_ID_PATTERN: RegExp = /^DS-\d{3}$/;

/** テンプレートの正本のパス。リポジトリのルートからの相対パス。 */
export const DESIGN_TEMPLATE_RELATIVE_PATH =
  ".claude/skills/factory-design/template.md";

/**
 * 試行ディレクトリに置く設計書テンプレートの複製のファイル名。
 * Claudeが`Edit`で編集してよいのはこのファイルだけ。
 */
export const DESIGN_MD_FILENAME = "design.md";

/**
 * 設計1回分の設計書と図を書き込むディレクトリのパスを組み立てる。
 * 形式は`<base>/<owner>/<repo>/issue-<issueNumber>/wi-<workItemId>/design/req-<attempt>/attempt-<designAttempt>`。
 *
 * 要件定義の試行(`attempt`)と設計の試行(`designAttempt`)の両方をパスに入れる。
 * 設計が要件の不足を返して要件定義へ戻ると、作業項目の設計の試行は0に戻る。
 * パスに要件の試行が無いと、承認済みの設計の図を、戻った後の設計が上書きしうる。
 * 作業項目の掃除は`wi-<workItemId>`ごと消すので、この配置は掃除を変えない。
 *
 * 名前と数値は`buildRequirementsDocDir`と同じ検査を通す。
 * `designAttempt`は1以上の整数でなければ例外を投げる。
 */
export function buildDesignDocDir(
  base: string,
  owner: string,
  repo: string,
  issueNumber: number,
  workItemId: number,
  attempt: number,
  designAttempt: number,
): string {
  const workItemDir = dirname(
    buildRequirementsDocDir(
      base,
      owner,
      repo,
      issueNumber,
      workItemId,
      attempt,
    ),
  );
  if (!Number.isInteger(designAttempt) || designAttempt < 1) {
    throw new Error(
      `buildDesignDocDir: designAttempt must be a positive integer (got ${String(designAttempt)})`,
    );
  }
  return `${workItemDir}/design/req-${String(attempt)}/attempt-${String(designAttempt)}`;
}

/**
 * 試行ディレクトリに、保存済みの設計書の下書きが指すものと同じパスの下書きがあるときの`needs_human`の理由。
 * 設計書の生成はディレクトリを空にして書くので、保存済みの下書きの図を消さないために止める。
 */
export const DESIGN_DOC_DIR_IN_USE_REASON =
  "design document directory already holds a saved draft";

/** 設計の構造化出力の`summary`の長さの上限(コードポイント)。 */
export const DESIGN_SUMMARY_MAX_CHARS = 1000;

/** 設計の構造化出力の`open_questions`の件数の上限。 */
export const DESIGN_OPEN_QUESTIONS_MAX_COUNT = 30;

/** 設計の構造化出力の`open_questions`の1要素の長さの上限(コードポイント)。 */
export const DESIGN_OPEN_QUESTION_MAX_CHARS = 1000;

/**
 * 設計書が読む対象リポジトリの、読み取り専用のdetachedなworktreeのパスを返す。
 * 形式は`/workspaces/<owner>/<repo>/design-<issueNumber>`で、`ensureRepo`のメインのcloneの隣に置く。
 * 要件定義用の`req-<N>`とは別のパスにする。要件定義の承認の反映が`req-<N>`を消すので、共有すると設計の途中で消えるため。
 * `owner`と`repo`は`assertGitHubName`で検証し、不正なら例外を投げる。
 * `issueNumber`が0以上の整数でないときも例外を投げる。
 */
export function buildDesignWorktreeDir(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  assertGitHubName(owner);
  assertGitHubName(repo);
  if (!Number.isInteger(issueNumber) || issueNumber < 0) {
    throw new Error(
      `buildDesignWorktreeDir: issueNumber must be a non-negative integer (got ${String(issueNumber)})`,
    );
  }
  return `/workspaces/${owner}/${repo}/design-${String(issueNumber)}`;
}
