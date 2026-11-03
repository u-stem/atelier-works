/** フォーカスを受け取れる要素。 */
export type Focusable = { readonly focus: () => void };

/** 子孫から要素を1つ探せるもの。フォームの要素が当てはまる。 */
export type InvalidSource = {
  readonly querySelector: (selector: string) => Focusable | null;
};

export function focusFirstInvalid(_source: InvalidSource): boolean {
  return false;
}
