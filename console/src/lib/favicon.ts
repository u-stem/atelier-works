// ブラウザのタブに出すアイコン。`BrandMark`と同じ形のSVGを、`data:`のURLにして`<head>`に足す。
// CSPの`img-src`は自分のオリジンと`data:`だけを許すので、外のファイルを読まない`data:`にする。
// `console/index.html`は保護パスで、静的な`<link>`を置けないため、起動時にスクリプトから足す。

/** 藍(`--primary`のライト)と、その上に載せる色(`--primary-foreground`のライト)。タブの外の色はブラウザが決めるので、テーマに依らず同じ色にする。 */
const TILE = "#3845bf";
const MARK = "#fafcff";

/** タブのアイコンのSVG。形は`BrandMark`と同じで、色はCSSの変数でなく固定の値にする。 */
export const FAVICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
  `<rect width="32" height="32" rx="9" fill="${TILE}"/>`,
  `<rect x="8" y="8.5" width="16" height="3.5" rx="1.75" fill="${MARK}"/>`,
  `<rect x="8" y="14.25" width="11" height="3.5" rx="1.75" fill="${MARK}" opacity="0.8"/>`,
  `<rect x="8" y="20" width="6" height="3.5" rx="1.75" fill="${MARK}" opacity="0.6"/>`,
  `<circle cx="22.5" cy="21.75" r="2.25" fill="${MARK}"/>`,
  "</svg>",
].join("");

/** `<link rel="icon">`に入れる`data:`のURL。 */
export function faviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;
}

/** `<link>`要素のうち、アイコンに使う属性。 */
export type IconLink = { rel: string; type: string; href: string };

/** 文書の`<head>`にタブのアイコンを足す。ブラウザでは`document`を渡す。 */
export function installFaviconIn<L extends object>(doc: {
  createElement: (tag: "link") => L;
  head: { append: (link: L) => void };
}): void {
  const icon: IconLink = {
    rel: "icon",
    type: "image/svg+xml",
    href: faviconHref(),
  };
  doc.head.append(Object.assign(doc.createElement("link"), icon));
}
