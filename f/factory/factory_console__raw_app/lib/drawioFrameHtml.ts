// 図を描くiframeの`srcdoc`に入れるHTMLを、固定の部品から組み立てる。
// XMLは入れない。XMLは、iframeが読み込まれた後にpostMessageで1回だけ渡す(`drawioMessages.ts`)。
// 保護パスの一覧(`f/factory/lib/protected_paths.ts`)に入れてあり、人が変える。

import {
  DRAWIO_FRAME_SCRIPT,
  DRAWIO_FRAME_SCRIPT_INTEGRITY,
} from "./drawioFrameScript";
import {
  DRAWIO_VIEWER_INTEGRITY,
  DRAWIO_VIEWER_SCRIPT_URL,
} from "./drawioViewerPin";

/**
 * iframeのCSP。スクリプトは、受け口のinline scriptのハッシュと、固定したビューアのURLだけを許す。
 * `connect-src 'none'`と`default-src 'none'`で、図の中からの通信と外部資源の読み込みを塞ぐ。
 * 画像とフォントは`data:`だけを許し、図に埋め込まれた画像は描ける。外部の画像のURLは読まない。
 * `unsafe-eval`を許さないので、ビューアの`eval`は動かない。
 */
export function buildFrameCsp(): string {
  return [
    "default-src 'none'",
    `script-src '${DRAWIO_FRAME_SCRIPT_INTEGRITY}' ${DRAWIO_VIEWER_SCRIPT_URL}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** 縦のスクロールバーが出入りしても幅が変わらないようにする。変わると、ビューアが図を合わせ直して高さが往復する。 */
const FRAME_STYLE = `
html { scrollbar-gutter: stable; }
html, body { margin: 0; background: #fff; overflow-x: hidden; overflow-y: auto; }
`;

/**
 * `<iframe srcdoc>`に入れるHTMLを返す。引数は取らず、毎回同じ文字列を返す。
 * 親のページにスクリプトを入れず、ビューアのスクリプトはこの文書の中だけで読む。
 */
export function buildDrawioFrameHtml(): string {
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${buildFrameCsp()}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${FRAME_STYLE}</style>`,
    "</head>",
    "<body>",
    '<div id="diagram"></div>',
    `<script src="${DRAWIO_VIEWER_SCRIPT_URL}" integrity="${DRAWIO_VIEWER_INTEGRITY}" crossorigin="anonymous"></script>`,
    `<script>${DRAWIO_FRAME_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
