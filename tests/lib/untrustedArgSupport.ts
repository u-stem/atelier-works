// flow.yamlの式が作る、包んだ引数の文字列と同じものを作る。
// 式は`JSON.stringify(<値>).replace(/\$/g, "\\u0024")`の形で、JSONの`$`をすべて`\u0024`に置き換える。
// 本番のstepは戻す側だけを使うので、作る側はテストにだけ置く。

/** 包む式の終わり。flow.yamlの式と、この関数が同じ置き換えをすることを、flowの定義を読むテストが照合する。 */
export const SEAL_SUFFIX = '.replace(/\\$/g, "\\\\u0024")';

export function sealUntrustedArg(value: unknown): string {
  return JSON.stringify(value).replace(/\$/g, "\\u0024");
}
