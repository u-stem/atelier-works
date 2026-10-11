// 期間、種類、テーマの切り替えで、選択中の項目を示すクラス。
// 面の明るさの差はどのテーマでも小さいので、藍の枠線と藍寄りの面で未選択と分ける。
// 文字の太さは変えない。変えると文字幅が動き、隣の項目の位置がずれる。
// hoverでも面と文字の色を保つ。保たないと、ボタンのhover色に変わって選択中の面が消える。

/** 枠線の太さも含む。未選択の項目は、同じ太さの枠線(透明でもよい)を持たせる。 */
export const SELECTED_STYLE =
  "border border-primary bg-selected text-selected-foreground hover:bg-selected hover:text-selected-foreground";
