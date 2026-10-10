// 図のビューアのスクリプトの固定。版(commit)とSRIの値と、取得元のURLを持つ。
// 値は`console/drawio-viewer.json`と同じでなければならない。raw appは
// そのファイルをimportできないので、ここに写し、一致は
// `tests/lib/drawio_viewer_pin.test.ts`が確かめる。
// 版を上げるときは、`docs/internals/console.md`の手順で
// `console/drawio-viewer.json`を更新し、ここの値を合わせる。
// 保護パスの一覧(`f/factory/lib/protected_paths.ts`)に入れてあり、人が変える。

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
