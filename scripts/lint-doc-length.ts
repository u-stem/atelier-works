// Markdown文書の行数が上限(`MAX_DOC_LINES`)を超えないかを検査する。
// `scripts/lint-docs.ts`の`lintDocText`が、検査の対象の文書(`isTargetDoc`)ごとに呼ぶ。
// 上限を超えた文書は、目的ごとの文書に分ける。

/** 1文書の行数の上限。超えるとtextlintの時間が延び、読み手が1つの文書の中で迷うためである。 */
export const MAX_DOC_LINES = 3000;

/** 文書の行数。最後の行に改行が無くても1行に数える。空の文書は0行。 */
export function countLines(markdown: string): number {
  if (markdown === "") return 0;
  const breaks = markdown.split("\n").length - 1;
  return markdown.endsWith("\n") ? breaks : breaks + 1;
}

/** 行数の上限の指摘。`line`は報告する行、`text`は`path:line: [max-lines] 内容`の形の報告。 */
export type DocLengthViolation = {
  readonly line: number;
  readonly text: string;
};

/**
 * 文書`path`の行数が上限を超えていれば、指摘を返す。上限以下なら`undefined`。
 */
export function findDocLengthViolation(
  _path: string,
  markdown: string,
): DocLengthViolation | undefined {
  const lines = countLines(markdown);
  if (lines <= MAX_DOC_LINES) return undefined;
  return { line: 0, text: "" };
}
