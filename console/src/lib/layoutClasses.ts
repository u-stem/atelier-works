// 画面の本文を包む枠と、枠の下端に貼り付くページ送りの帯のclass。
// 帯の値は枠の値に依存するので、同じファイルで対にして置く。
// 対応は`layoutClasses.test.ts`が確かめる。

/**
 * 画面の本文を包む、縦にスクロールする枠のclass。
 *
 * - `relative`: 枠の中の`position:absolute`の要素(読み上げ専用の文字など)の位置の基準を枠にする。
 *   基準が枠の外にあると、要素が枠の外に置かれ、枠の外側が余分な高さを持つ。
 *   その要素へフォーカスや検索で移ると、外側がスクロールして見出しの帯が外れる。
 * - `py-6`: 上下に1.5remの余白を持つ。下端に貼り付くページ送りは、この余白の分だけ下げて置く(`PAGINATION_BAR_CLASS`の`-bottom-6`)。
 * - `scroll-pb-28`: キーボードで移したフォーカスが、貼り付いたページ送りに覆われないようにする。
 *   ページ送りの高さは、1行で約57px、折り返して2行で約100pxである。
 *   7rem(112px)は2行の高さを超える。
 *   帯の中のボタンは、この余白を`PAGINATION_BUTTON_CLASS`の`-scroll-mb-28`で打ち消す。
 */
export const SCROLL_BODY_CLASS =
  "relative flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto px-4 py-6 scroll-pb-28 md:px-8";

/**
 * 全画面に共通の`main`のclass。
 *
 * - `relative`: 枠の外へ出た`position:absolute`の要素の位置の基準を`main`にする。基準が無いと`body`になり、windowがスクロールできる長さになる。
 * - `overflow-clip`: はみ出しを切る。`overflow-hidden`と違い、スクロール枠にならず、プログラムからも`scrollTop`が動かない。
 *   `main`が動くと、`overflow-hidden`で操作では戻せないまま、見出しの帯が外れる。
 * - `min-h-0`: `overflow-clip`はスクロール枠でないので、縦に並べる幅では中身の高さが最小の高さになる。
 *   0にして、本文の枠が画面の高さに収まるようにする。
 */
export const APP_MAIN_CLASS =
  "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip";

/**
 * ページ送りの帯のclass。枠の下端に貼り付く。
 * `-bottom-6`は`SCROLL_BODY_CLASS`の`py-6`の分だけ下げる。余白の上で止まると、帯の下に次の項目が見えるためである。
 * 背景と上の境界線で、下をくぐる一覧と重ならずに読める。
 */
export const PAGINATION_BAR_CLASS =
  "sticky -bottom-6 z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border bg-background py-3 text-small text-muted-foreground";

/** 本文の枠の上端に貼り付く部分のclass。 */
export const STICKY_HEADER_CLASS = "";

/**
 * ページ送りの帯の中のボタンに付けるclass。
 * 帯は枠の下端から`scroll-pb-28`の内側にあり、そのままでは、フォーカスのたびに枠がその分スクロールする。
 * `-scroll-mb-28`で`SCROLL_BODY_CLASS`の`scroll-pb-28`を打ち消す。
 */
export const PAGINATION_BUTTON_CLASS = "-scroll-mb-28";
