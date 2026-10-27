// 描画したHTMLの文字列を静的に検査する、アクセシビリティの規則。依存を持たない。

export type A11yRuleId =
  | "idref"
  | "duplicate-id"
  | "heading-order"
  | "input-label"
  | "button-name"
  | "link-name";

export type A11yViolation = {
  readonly rule: A11yRuleId;
  readonly message: string;
};

export type A11yOptions = {
  /** 検査する断片の前にある見出しの段。ページの見出し(h1)が断片の外にあるときは1にする。 */
  readonly headingStart?: number;
};

export function checkA11y(
  _html: string,
  _options: A11yOptions = {},
): readonly A11yViolation[] {
  return [];
}
