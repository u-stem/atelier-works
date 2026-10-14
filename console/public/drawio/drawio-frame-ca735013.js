// drawio.htmlの中で動く。親のページからpostMessageで図のXMLを受け取り、同梱のビューアで描く。
// sandbox="allow-scripts"のiframeなので不透明なオリジンで動き、Cookieにも親のDOMにも届かない。
// 親へ返すのは、図の高さと、失敗の種類(固定の3つ)だけにする。
// TypeScriptのビルドを通らないので、小さく保つ。
(() => {
  // 親(src/lib/drawioMessages.ts)が送る大きさの上限と、対にして合わせる。
  const MAX_XML_LENGTH = 256 * 1024;
  // 失敗の種類と、iframeの中に出す固定の文。例外の文面はページに出さない。
  const ERROR_TEXTS = {
    viewer_missing: "ビューアが読み込まれていません",
    render_failed: "図を表示できません",
    too_large: "図が大きすぎて表示できません",
  };
  const diagram = document.getElementById("diagram");
  if (diagram === null) {
    return;
  }

  // 1つのiframeで描くのは1回だけにする。親は図ごとにiframeを作り直す。
  let rendered = false;

  function reportError(reason) {
    diagram.textContent = ERROR_TEXTS[reason];
    window.parent.postMessage({ type: "drawio:error", reason }, "*");
  }

  // ツールバー、lightbox、ナビゲーションはどれも外部のページを開く経路なので無効にする。
  function viewerConfig(xml) {
    return {
      xml,
      lightbox: false,
      nav: false,
      resize: true,
      "auto-fit": true,
    };
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
    element.setAttribute("data-mxgraph", JSON.stringify(viewerConfig(xml)));
    diagram.appendChild(element);
    try {
      GraphViewer.processElements();
    } catch {
      reportError("render_failed");
      return;
    }
    // ビューアは要素ごとの失敗を例外にせず、要素の中に文として書く。描けたかは図が入ったかで見る。
    if (element.querySelector("svg") === null) {
      reportError("render_failed");
    }
  }

  // 図のリンクは開かない。ビューアの経路と、ラベルの中のaの経路の両方を止める。
  if (typeof Graph !== "undefined") {
    Graph.prototype.openLink = () => {};
  }
  // クリックの既定の動作はすべて止める。この画面に、押して動かす要素は無い。
  for (const type of ["click", "auxclick"]) {
    document.addEventListener(type, (event) => event.preventDefault(), true);
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

  // 高さは親が数値に絞って使う。ここでは測った値をそのまま送る。
  new ResizeObserver(() => {
    window.parent.postMessage(
      { type: "drawio:height", height: Math.ceil(diagram.offsetHeight) },
      "*",
    );
  }).observe(diagram);
})();
