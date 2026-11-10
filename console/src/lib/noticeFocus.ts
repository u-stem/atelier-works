// 閉じるまで残る知らせへ、画面が移動してフォーカスを置くかの判定。
// 知らせは`role="alert"`で読み上げられるので、利用者が別の入力欄で操作している間は、フォーカスもスクロールも奪わない。
// DOMには触れない。呼び出す側が、見えているかと、フォーカスのある要素を渡す。

/**
 * 移動の理由。
 * `shown`は、隠れていたタブが見えるようになり、残っている知らせがあること。
 * `arrived`は、タブが見えている間に、新しい知らせが届いたこと。
 */
export type NoticeMoveReason = "shown" | "arrived";

/** ある時点の、知らせの番号(無ければ`undefined`)と、タブが見えているか。 */
export type NoticeSeen = {
  readonly id: number | undefined;
  readonly visible: boolean;
};

/**
 * 前の時点と今の時点から、知らせへ移る理由を決める。移らないときは`null`。
 * 隠れたタブには移らない。見えないところで、フォーカスもスクロールも動かさないためである。
 */
export function noticeMoveReason(
  prev: NoticeSeen,
  next: NoticeSeen,
): NoticeMoveReason | null {
  if (next.id === undefined || !next.visible) return null;
  if (!prev.visible) return "shown";
  return prev.id === next.id ? null : "arrived";
}

/**
 * 知らせへ移るか。
 * `shown`は、利用者がタブを選んだ直後でフォーカスがタブの上にあるので、移る。
 * `arrived`は、フォーカスが体(body)にあるか、確認のダイアログを閉じて戻った先(`trigger`、ダイアログを開いたボタン)にあるときだけ移る。
 * 絞り込み欄など、別の要素にフォーカスがあるときは移らない。
 */
export function shouldMoveToNotice(input: {
  reason: NoticeMoveReason | null;
  active: unknown;
  body: unknown;
  trigger: unknown;
}): boolean {
  if (input.reason === null) return false;
  if (input.reason === "shown") return true;
  return (
    input.active === null ||
    input.active === input.body ||
    (input.trigger !== null && input.active === input.trigger)
  );
}
