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
  openNavDrawer(): { onceClosed(callback: () => void): () => void } | null;
};

export function shouldMoveFocus(
  _previous: string | null,
  _current: string,
): boolean {
  return false;
}

export function moveFocusAfterNavigation(_env: FocusEnv): () => void {
  return () => undefined;
}
