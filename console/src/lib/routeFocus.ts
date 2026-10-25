// 画面の遷移の後にフォーカスを移す判定と手順。DOMには触れず、操作は引数で受ける。

/** 見出し(PageHeaderのh1)のid。遷移後のフォーカスの移し先になる。 */
export const PAGE_HEADING_ID = "page-heading";

/** 本文(main)のid。本文へスキップするリンクと、見出しが無い画面のフォーカスの移し先になる。 */
export const MAIN_ID = "main-content";

export type FocusTarget = {
  focus(options?: { preventScroll?: boolean }): void;
};

export type FocusEnv = {
  heading(): FocusTarget | null;
  main(): FocusTarget | null;
  /**
   * 開いているメニューのドロワー。無ければ`null`。
   * `onceClosed`は閉じた後に一度だけ呼ばれ、戻り値の関数で取り消せる。
   */
  openNavDrawer(): { onceClosed(callback: () => void): () => void } | null;
};

/**
 * 遷移でフォーカスを移すか。
 * 移すのは、前の画面があり、`pathname`が変わったときだけである。
 * `search`や`hash`だけの変更(タブ、選択、絞り込み)では、画面の中の操作を妨げないよう移さない。
 * 最初の表示でも移さない。ブラウザが決めた位置を残すためである。
 */
export function shouldMoveFocus(
  previous: string | null,
  current: string,
): boolean {
  return previous !== null && previous !== current;
}

/**
 * 遷移後のフォーカスを、見出しへ移す。見出しが無い画面では、本文へ移す。
 * メニューのドロワーが開いているときは、閉じ終わってから移す。
 * `<dialog>`を閉じると、ブラウザが開く前の要素へフォーカスを戻すので、先に移すと奪われる。
 * 戻り値の関数を呼ぶと、閉じるのを待っている移動を取り消す。
 */
export function moveFocusAfterNavigation(env: FocusEnv): () => void {
  const move = (): void => {
    const target = env.heading() ?? env.main();
    // フォーカスによるスクロールで外側の枠が動くと、見出しの帯が外れる。位置は動かさない。
    target?.focus({ preventScroll: true });
  };
  const drawer = env.openNavDrawer();
  if (drawer === null) {
    move();
    return () => undefined;
  }
  return drawer.onceClosed(move);
}

export function createRouteFocusTracker(): (pathname: string) => boolean {
  return () => false;
}
