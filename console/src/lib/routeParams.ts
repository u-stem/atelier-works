// 経路の引数やURLの引数から、番号(作業項目のid、試行の番号)を読む。

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** 正の整数の文字列だけを数にする。空、符号、小数、先頭の0、安全でない大きさは`null`にする。 */
export function parseIdParam(value: string | null | undefined): number | null {
  if (value === undefined || value === null || !POSITIVE_INTEGER.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
