/** フォーカスを受け取れる要素。 */
export type Focusable = { readonly focus: () => void };

/** 子孫から要素を1つ探せるもの。フォームの要素が当てはまる。 */
export type InvalidSource = {
  readonly querySelector: (selector: string) => Focusable | null;
};

/** `Field`が誤りのある入力欄に付ける属性。 */
const INVALID_CONTROL = '[aria-invalid="true"]';

/**
 * 誤りのある入力欄のうち、文書の順で最初のものへフォーカスを移す。移せたら`true`を返す。
 * 送信が誤りで止まったとき、画面の読み上げは入力欄にフォーカスが移るまで誤りを伝えない。
 * 入力欄の並びは画面の並びと同じなので、並びを別に持たない。
 */
export function focusFirstInvalid(source: InvalidSource): boolean {
  const control = source.querySelector(INVALID_CONTROL);
  if (control === null) {
    return false;
  }
  control.focus();
  return true;
}
