// 実リポジトリの閉包をたどる検査が、最低いくつの訪問を要するかを測るテスト用の部品。

/**
 * `fits`が真を返す最小の整数を、二分探索で返す。
 * `fits`は、ある値で真なら、それより大きい値でも真になる(単調である)ことを前提にする。
 * `upper`でも偽なら、`upper + 1`を返す。
 */
export async function minimalPassingLimit(
  fits: (limit: number) => Promise<boolean>,
  upper: number,
): Promise<number> {
  if (!(await fits(upper))) {
    return upper + 1;
  }
  let low = 1;
  let high = upper;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await fits(middle)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}
