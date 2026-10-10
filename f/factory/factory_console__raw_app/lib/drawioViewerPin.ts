// 図のビューアのスクリプトの固定と、ビューアに渡す設定。版(commit)とSRIの値を持つ。
// 値は`console/drawio-viewer.json`と同じでなければならない。raw appは
// そのファイルをimportできないので、ここに写し、一致は
// `tests/lib/drawio_viewer_pin.test.ts`が確かめる。
// 版を上げるときは、`docs/internals/console.md`の手順で
// `console/drawio-viewer.json`を更新し、この2つの値を合わせる。

/** jgraph/drawioのcommit。リリースのタグが指すcommitで、branchやtagではない。 */
export const DRAWIO_VIEWER_COMMIT = "9034053fba80a435e27d68d374bc564b83917ae9";

/**
 * ビューアのスクリプトのSRI(`sha256-<base64>`)。
 * `console/drawio-viewer.json`の`sha256`(16進)をbase64にした値である。
 */
export const DRAWIO_VIEWER_INTEGRITY =
  "sha256-vHWGy2LuyYAYwTt4YZB406cXnMe/xxHFZt2hlSdSCjA=";

/**
 * commitを固定したjsDelivrのURL。raw.githubusercontent.comは
 * `text/plain`と`nosniff`で返すので、scriptとして読めない。
 */
export const DRAWIO_VIEWER_SCRIPT_URL = `https://cdn.jsdelivr.net/gh/jgraph/drawio@${DRAWIO_VIEWER_COMMIT}/src/main/webapp/js/viewer-static.min.js`;

/**
 * `data-mxgraph`に入れるJSONを返す。リンクを開く機能はすべて切る。
 * `lightbox`と`nav`は別ページや別ウィンドウへ移る経路になり、
 * `toolbar`を渡さなければ、ツールバーのボタンも出ない。
 * 図のXMLは信頼できない入力なので、図のリンクで外へ出る経路を残さない。
 */
export function buildGraphViewerConfig(xml: string): string {
  return JSON.stringify({
    xml,
    lightbox: false,
    nav: false,
    resize: true,
    highlight: "#0000ff",
  });
}
