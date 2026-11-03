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

/** 誤りのある入力欄を数えられるもの。フォームの要素が当てはまる。 */
export type InvalidCounter = InvalidSource & {
  readonly querySelectorAll: (selector: string) => { readonly length: number };
};

/**
 * 最初の誤りの入力欄に、すでにフォーカスがあるときの読み上げ用の文。そうでなければ空の文字列を返す。
 * すでにフォーカスがある欄へ`focus()`しても、イベントが起きず、読み上げは何も伝えない。
 * フォーカスが移るときは、移った欄の説明が誤りを伝えるので、この文は要らない。
 */
export function invalidAnnouncement(
  source: InvalidCounter,
  active: unknown,
): string {
  const first = source.querySelector(INVALID_CONTROL);
  if (first === null || first !== active) {
    return "";
  }
  return `入力に誤りがあります(${source.querySelectorAll(INVALID_CONTROL).length}件)`;
}

/** 読み上げ専用の領域に渡す文。`serial`が変わるたびに、同じ文でも読み直される。 */
export type InvalidStatusMessage = {
  readonly text: string;
  readonly serial: number;
};

/**
 * 読み上げ専用の領域を空に戻す。誤りの無い送信に進むとき、前の誤りの件数を残さないために使う。
 * すでに空なら同じ値を返し、描き直しを起こさない。
 */
export function clearedStatus(
  status: InvalidStatusMessage,
): InvalidStatusMessage {
  return status.text === "" ? status : { text: "", serial: status.serial };
}
