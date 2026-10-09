// 要対応の画面で選んだ承認依頼を、URLの`?approval=<id>`に持つための読み書き。
// URLの引数は選択を表すだけで、承認や却下などの操作は起こさない。

export const APPROVAL_PARAM = "approval";

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * `?approval=`の値を承認依頼のidとして読む。
 * 正の整数の文字列だけを受け付け、それ以外(空、符号、小数、先頭の0、安全でない大きさ)は`null`にする。
 * 引数が繰り返されたときは最初の値を使う。
 */
export function parseApprovalParam(params: URLSearchParams): number | null {
  const value = params.get(APPROVAL_PARAM);
  if (value === null || !POSITIVE_INTEGER.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * `params`の`approval`を`id`に置き換えた新しい`URLSearchParams`を返す。
 * `id`が`null`なら`approval`を外す。ほかの引数と`params`自身は変えない。
 */
export function withApprovalParam(
  params: URLSearchParams,
  id: number | null,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (id === null) {
    next.delete(APPROVAL_PARAM);
  } else {
    next.set(APPROVAL_PARAM, String(id));
  }
  return next;
}
