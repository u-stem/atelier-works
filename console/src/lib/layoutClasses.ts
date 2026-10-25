/**
 * 画面の本文を包む、縦にスクロールする枠のclass。
 *
 * - `py-6`: 上下に1.5remの余白を持つ。下端に貼り付くページ送りは、この余白ぶん下げて置く(`-bottom-6`)。
 *   余白を変えるときは、ページ送りの`-bottom-*`も揃える。
 * - `scroll-pb-28`: キーボードで移したフォーカスが、貼り付いたページ送りの下に隠れないようにする。
 *   ページ送りの高さは、1行で約57px、折り返して2行で約100pxである。
 *   7rem(112px)は2行の高さを超える。
 */
export const SCROLL_BODY_CLASS =
  "flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto px-4 py-6 scroll-pb-28 md:px-8";

/**
 * 全画面に共通の`main`のclass。
 * `relative`で、枠の中の`position:absolute`の要素(読み上げ専用の文字やダイアログ)の位置の基準を`main`にする。
 * 基準が無いと、基準が`body`になり、`overflow-hidden`で切られずに、windowがスクロールできる長さになる。
 */
export const APP_MAIN_CLASS =
  "relative flex min-w-0 flex-1 flex-col overflow-hidden";
