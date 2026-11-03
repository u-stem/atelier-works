// 辺の証拠の照合。
// 証拠は、ソースのコードに実在する文字列である。
// ソースの本文は読み出し関数の中だけで扱い、結果にはファイル名と探した文字列だけを返す。

/** 辺の根拠になるソースの文字列。`file`は`f/factory`からの相対パス。 */
export type Evidence = {
  readonly file: string;
  readonly includes: string;
};

/**
 * `f/factory`の下のTypeScriptのソースを指す相対パスの形。
 * `..`、絶対パス、拡張子の違うファイルは、この形に当てはまらない。
 */
const SOURCE_FILE = /^[a-z_]+(\/[a-z_]+)*\.ts$/;

/**
 * コメントを除いたソースを返す。コメントの中の語を、証拠にしないためである。
 * 行のコメントは、行頭か空白の後の`//`だけを外す。`"https://x"`や`/a\/\/b/`の中の`//`は、コードなので残す。
 * ブロックコメントは、行頭に`*`の無い行も含めて外す。
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** `text`の中の`needle`(固定の文字列)の、重ならない出現の数。 */
function countOccurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + needle.length)
  ) {
    count += 1;
  }
  return count;
}

/**
 * 証拠のうち、ソースのコードにちょうど1か所で見つからないものを、`file: includes`の配列で返す。
 * 形の検査を通らない`file`は、`readSource`に渡さずに欠けとして扱う。
 * `readSource`は、ファイルが無ければundefinedを返す。ファイルの本文は返さない。
 */
export function findMissingEvidence(
  edges: readonly { readonly evidence: readonly Evidence[] }[],
  readSource: (file: string) => string | undefined,
): string[] {
  const code = new Map<string, string | undefined>();
  const codeOf = (file: string): string | undefined => {
    if (!code.has(file)) {
      const source = readSource(file);
      code.set(file, source === undefined ? undefined : stripComments(source));
    }
    return code.get(file);
  };
  const missing: string[] = [];
  for (const edge of edges) {
    for (const { file, includes } of edge.evidence) {
      const found = SOURCE_FILE.test(file) ? codeOf(file) : undefined;
      if (found === undefined || countOccurrences(found, includes) !== 1) {
        missing.push(`${file}: ${includes}`);
      }
    }
  }
  return missing;
}
