// 実リポジトリの閉包をたどる検査が、最低いくつの訪問を要するかを測るテスト用の部品。

/**
 * `fits`が真を返す最小の整数を、二分探索で返す。
 * `fits`は、ある値で真なら、それより大きい値でも真になる(単調である)ことを前提にする。
 * `upper`でも偽なら、`upper + 1`を返す。
 */
export async function minimalPassingLimit(
  _fits: (limit: number) => Promise<boolean>,
  _upper: number,
): Promise<number> {
  return 0;
}
