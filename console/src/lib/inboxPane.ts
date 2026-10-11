// 要対応の画面で、幅が狭いときに一覧と詳細のどちらを出すかを決める。
// 広い画面(lg以上)では、どちらの面でも一覧と詳細を並べて出す。

import { cn } from "./cn.ts";
import type { InboxSelection } from "./inboxSelection.ts";

export type InboxPane = "list" | "detail";

/** 狭い画面で出す面。項目を選んでいれば詳細、選んでいなければ一覧にする。 */
export function inboxPane(selection: InboxSelection | null): InboxPane {
  return selection === null ? "list" : "detail";
}

/** 一覧のペインのクラス。狭い画面では幅いっぱいに広げ、詳細の面のあいだは隠す。 */
export function inboxListClass(pane: InboxPane): string {
  return cn(
    "w-full shrink-0 overflow-y-auto border-border bg-card lg:w-80 lg:border-r xl:w-[28rem]",
    pane === "detail" && "hidden lg:block",
  );
}

/** 詳細のペインのクラス。中身を縦に並べて高さを分け合う。狭い画面では一覧の面のあいだは隠す。 */
export function inboxDetailClass(pane: InboxPane): string {
  return cn(
    "flex min-w-0 flex-1 flex-col overflow-y-auto",
    pane === "list" && "hidden lg:flex",
  );
}

/**
 * 選択の変更で履歴を積むか。
 * 狭い画面で項目を選ぶと面が一覧から詳細へ切り替わるので、戻る操作で一覧へ戻れるよう履歴を積む。
 * それ以外(広い画面、選択を外す操作)は面が変わらないか、一覧へ戻る操作そのものなので、積まずに置き換える。
 */
export function selectionPushesHistory(
  narrow: boolean,
  next: InboxSelection | null,
): boolean {
  return narrow && next !== null;
}

/** 狭い画面で一覧から項目を選んで積んだ履歴の印。`location.state`に載せる。 */
export const LIST_ORIGIN_STATE = { fromList: true };

/**
 * 詳細から一覧へ戻る方法。
 * 一覧から選んで積んだ履歴(印あり)は、戻る操作で一覧へ戻る。履歴が空の項目を残さないためである。
 * 選択つきのURLを直接開いたとき(印なし)は戻る先が一覧とは限らないので、選択を外して置き換える。
 */
export function listBackAction(state: unknown): "pop" | "clear" {
  return typeof state === "object" &&
    state !== null &&
    "fromList" in state &&
    state.fromList === true
    ? "pop"
    : "clear";
}

/** 一覧の行を探すための属性の値。種類とidで行を見分ける。 */
export function rowDomKey(selection: InboxSelection): string {
  return `${selection.type}:${selection.id}`;
}

/**
 * 選択の変更で履歴の項目に載せる`location.state`。
 * 積むときは一覧から選んだ印を付ける。置き換えるときは、置き換わる項目の印をそのまま引き継ぐ。
 * 印を落とすと、広い幅で選び直した後に狭い幅へ戻ったとき、戻る操作が置き換えになり一覧の履歴が重なるためである。
 */
export function selectionHistoryState(
  push: boolean,
  current: unknown,
): unknown {
  return push ? LIST_ORIGIN_STATE : current;
}
