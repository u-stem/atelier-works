// 要対応の画面で選んだ項目を、URLの`?approval=<id>`、`?failure=<id>`、`?notice=<id>`に持つための読み書き。
// 引数は選択を表すだけで、承認や再実行などの操作は起こさない。

import { parseIdParam } from "./routeParams.ts";

/** 要対応の項目の種類。URLの引数の名前でもある。 */
export const INBOX_KINDS = ["approval", "failure", "notice"] as const;

export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxSelection = {
  readonly type: InboxKind;
  readonly id: number;
};

/**
 * URLの引数から選択を読む。
 * 引数は1つだけ受け付ける。2つ以上あるときは、値が正しくても選択を決められないので無視する。
 * 値は正の整数の文字列に限る(空、符号、小数、先頭の0、安全でない大きさは`null`)。
 * 同じ引数が繰り返されたときは最初の値を使う。
 */
export function parseSelection(params: URLSearchParams): InboxSelection | null {
  const present = INBOX_KINDS.filter((kind) => params.has(kind));
  const only = present[0];
  if (present.length !== 1 || only === undefined) {
    return null;
  }
  const id = parseIdParam(params.get(only));
  return id === null ? null : { type: only, id };
}

/**
 * `params`の選択を`selection`に置き換えた新しい`URLSearchParams`を返す。
 * 3種類の引数を先に外してから1つだけ置くので、同時に2つは残らない。
 * `selection`が`null`なら選択を外す。ほかの引数と`params`自身は変えない。
 */
export function withSelection(
  params: URLSearchParams,
  selection: InboxSelection | null,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const kind of INBOX_KINDS) {
    next.delete(kind);
  }
  if (selection !== null) {
    next.set(selection.type, String(selection.id));
  }
  return next;
}
