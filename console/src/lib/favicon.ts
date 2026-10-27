/** タブのアイコンのSVG。 */
export const FAVICON_SVG = "";

/** `<link rel="icon">`に入れる`data:`のURL。 */
export function faviconHref(): string {
  return "";
}

/** `<link>`要素のうち、アイコンに使う属性。 */
export type IconLink = { rel: string; type: string; href: string };

/** `<head>`に`<link>`を足す手段。ブラウザでは`document`の操作を渡す。 */
export type FaviconHost<L extends IconLink> = {
  createLink: () => L;
  append: (link: L) => void;
};

/** タブのアイコンを`<head>`に足す。 */
export function installFavicon<L extends IconLink>(host: FaviconHost<L>): void {
  void host;
}
