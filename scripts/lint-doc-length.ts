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

/**
 * 文書`path`の行数が上限を超えていれば、`path:line: [max-lines] 内容`の形で返す。
 * 行の番号は、上限を超えた最初の行にする。上限以下なら`undefined`。
 */
export function findDocLengthViolation(
  path: string,
  markdown: string,
): string | undefined {
  const lines = countLines(markdown);
  if (lines <= MAX_DOC_LINES) return undefined;
  return `${path}:${MAX_DOC_LINES + 1}: [max-lines] the document has ${lines} lines, over the limit of ${MAX_DOC_LINES}; split it into documents by purpose`;
}
