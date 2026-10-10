// 図を描くiframeの中で動く受け口のスクリプトを、固定の文字列として持つ。
// iframeのCSPは、このスクリプトをハッシュで許す(`drawioFrameHtml.ts`)。
// 文字列を1文字でも変えるとハッシュが合わずに動かなくなるので、変えたら
// `DRAWIO_FRAME_SCRIPT_INTEGRITY`も更新する。一致は`tests/lib/drawio_frame.test.ts`が確かめる。
// 保護パスの一覧(`f/factory/lib/protected_paths.ts`)に入れてあり、人が変える。

/** 親が送る図のXMLの上限。`drawioMessages.ts`の`MAX_XML_BYTES`と同じ値にする。 */
export const FRAME_MAX_XML_LENGTH = 256 * 1024;

/**
 * 受け口のスクリプトのSRIの形のハッシュ(`sha256-<base64>`)。CSPの`script-src`にそのまま入れる。
 * 値は`DRAWIO_FRAME_SCRIPT`の文字列全体のsha256をbase64にしたものである。
 */
export const DRAWIO_FRAME_SCRIPT_INTEGRITY =
  "sha256-jRCABPQIK8NltS6CcEn4ONg98vlqsLS2YQW0moJaAKI=";

/**
 * 受け口のスクリプト。ビューアのスクリプトの後に実行され、次のことをする。
 * - リンクを開く経路(`Graph.prototype.openLink`、`labelLinkClicked`、`customLinkClicked`)と、
 *   図形ライブラリの動的な取得(`mxStencilRegistry`)と、`window.open`を無効にする。
 * - clickとauxclickとsubmitの既定の動作を止める。
 * - 親から`drawio:render`を1回だけ受け取り、lightbox、nav、ツールバーを無効にして描く。
 *   受け取るのは、送り元が`window.parent`のものだけである。
 * - 図の高さ(`drawio:height`)と、失敗の種類(`drawio:error`。固定の3つ)だけを親へ返す。
 * ビルドを通らずにそのままiframeに入るので、小さく保つ。HTMLに埋め込むので、`</script`を含めてはならない。
 */
export const DRAWIO_FRAME_SCRIPT = `
(() => {
  const MAX_XML_LENGTH = ${FRAME_MAX_XML_LENGTH};
  const ERROR_TEXTS = {
    viewer_missing: "ビューアが読み込まれていません",
    render_failed: "図を表示できません",
    too_large: "図が大きすぎて表示できません",
  };
  const diagram = document.getElementById("diagram");
  if (diagram === null) {
    return;
  }
  const noop = () => {};

  if (typeof Graph !== "undefined") {
    Graph.prototype.openLink = noop;
    for (const name of ["labelLinkClicked", "customLinkClicked"]) {
      if (typeof Graph.prototype[name] === "function") {
        Graph.prototype[name] = noop;
      }
    }
  }
  if (typeof mxStencilRegistry !== "undefined") {
    mxStencilRegistry.dynamicLoading = false;
    mxStencilRegistry.allowEval = false;
    if (typeof mxStencilRegistry.loadStencilSet === "function") {
      mxStencilRegistry.loadStencilSet = noop;
    }
  }
  window.open = () => null;

  for (const type of ["click", "auxclick", "submit"]) {
    document.addEventListener(type, (event) => event.preventDefault(), true);
  }

  let rendered = false;

  function reportError(reason) {
    diagram.textContent = ERROR_TEXTS[reason];
    window.parent.postMessage({ type: "drawio:error", reason }, "*");
  }

  function isRenderMessage(data) {
    return (
      typeof data === "object" &&
      data !== null &&
      data.type === "drawio:render" &&
      typeof data.xml === "string"
    );
  }

  function render(xml) {
    if (xml.length > MAX_XML_LENGTH) {
      reportError("too_large");
      return;
    }
    if (typeof GraphViewer === "undefined") {
      reportError("viewer_missing");
      return;
    }
    diagram.textContent = "";
    const element = document.createElement("div");
    element.className = "mxgraph";
    element.setAttribute(
      "data-mxgraph",
      JSON.stringify({ xml, lightbox: false, nav: false, resize: true, "auto-fit": true }),
    );
    diagram.appendChild(element);
    try {
      GraphViewer.processElements();
    } catch {
      reportError("render_failed");
      return;
    }
    if (element.querySelector("svg") === null) {
      reportError("render_failed");
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) {
      return;
    }
    if (!isRenderMessage(event.data) || rendered) {
      return;
    }
    rendered = true;
    render(event.data.xml);
  });

  new ResizeObserver(() => {
    window.parent.postMessage(
      { type: "drawio:height", height: Math.ceil(diagram.offsetHeight) },
      "*",
    );
  }).observe(diagram);
})();
`;
