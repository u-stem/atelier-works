// drawio.htmlの中で動く。親のページからpostMessageで図のXMLを受け取り、同梱のビューアで描く。
// sandbox="allow-scripts"のiframeなので不透明なオリジンで動き、Cookieにも親のDOMにも届かない。
// 親へ返すのは図の高さだけにする。TypeScriptのビルドを通らないので、小さく保つ。
(() => {
  // 親(src/lib/drawioMessages.ts)が送る大きさの上限と合わせる。
  const MAX_XML_LENGTH = 256 * 1024;
  const diagram = document.getElementById("diagram");
  if (diagram === null) {
    return;
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
      typeof data.xml === "string" &&
      data.xml.length <= MAX_XML_LENGTH
    );
  }

  function render(xml) {
    diagram.textContent = "";
    const element = document.createElement("div");
    element.className = "mxgraph";
    element.setAttribute("data-mxgraph", JSON.stringify(viewerConfig(xml)));
    diagram.appendChild(element);
    if (typeof GraphViewer === "undefined") {
      return;
    }
    GraphViewer.processElements();
  }

  // 図のリンクは開かない。ビューアの経路と、ラベルの中のaの経路の両方を止める。
  if (typeof Graph !== "undefined") {
    Graph.prototype.openLink = () => {};
  }
  document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Element && event.target.closest("a")) {
        event.preventDefault();
      }
    },
    true,
  );

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) {
      return;
    }
    if (isRenderMessage(event.data)) {
      render(event.data.xml);
    }
  });

  // 高さは親が数値に絞って使う。ここでは測った値をそのまま送る。
  new ResizeObserver(() => {
    window.parent.postMessage(
      { type: "drawio:height", height: Math.ceil(diagram.offsetHeight) },
      "*",
    );
  }).observe(diagram);
})();
