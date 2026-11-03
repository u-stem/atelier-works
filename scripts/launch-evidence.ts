// 辺の証拠の照合。
// 証拠は、ソースのコードに実在する文字列である。

/** 辺の根拠になるソースの文字列。`file`は`f/factory`からの相対パス。 */
export type Evidence = {
  readonly file: string;
  readonly includes: string;
};

export function stripComments(_source: string): string {
  return "";
}

export function findMissingEvidence(
  _edges: readonly { readonly evidence: readonly Evidence[] }[],
  _readSource: (file: string) => string | undefined,
): string[] {
  return [];
}
