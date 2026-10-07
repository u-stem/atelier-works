// diagrams.netの埋め込み用の静的ビューア(`viewer-static.min.js`と
// `<div class="mxgraph" data-mxgraph='...'>`の規約。
// https://www.diagrams.net/doc/faq/embed-html-options)で、draw.io(mxGraph)の
// 図をその場に描く。図の内容は`data-mxgraph`のJSONからブラウザの中だけで描画し、
// どこにも送らない。外部と通信するのは、静的なスクリプト1つを配信する
// diagrams.netのCDNへの取得だけ(`docs/security.md`のdraw.ioの節を参照)。
//
// 文書ページの図はすべて同じ`window.GraphViewer`を共有するので、スクリプトは
// ページごとに一度だけ読み込む(モジュールスコープの単一のPromise)。
// `<script>`を2回入れても、同じ`processElements()`をもう一度走らせるだけになる。
//
// CSPと別オリジンのスクリプトの読み込みは、ブラウザでの実行時には
// 確かめていない。`wmill app dev`で確かめる点は、CSPがscriptタグを
// ブロックしないか(コンソールに`Refused to load the script...`が出ないか)と、
// 図が実際に描かれるか。ブロックされる場合の代替は、
// `viewer-static.min.js`(Apache-2.0)をこのアプリのファイルとして同梱し、
// バンドルする資産としてimportすること(未実装)。

import React, { useEffect, useRef, useState } from "react";

const VIEWER_SCRIPT_URL = "https://viewer.diagrams.net/js/viewer-static.min.js";

type GraphViewerGlobal = {
  processElements: () => void;
};

declare global {
  interface Window {
    // `VIEWER_SCRIPT_URL`のスクリプトが読み込み後に設定する。このアプリが
    // 管理していないスクリプトなので`unknown`で受け、使う前に
    // `isGraphViewerGlobal`で絞り込む。
    GraphViewer?: unknown;
  }
}

function isGraphViewerGlobal(value: unknown): value is GraphViewerGlobal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "processElements" in value && typeof value.processElements === "function"
  );
}

function getGraphViewerGlobal(): GraphViewerGlobal | null {
  return isGraphViewerGlobal(window.GraphViewer) ? window.GraphViewer : null;
}

let viewerScriptPromise: Promise<void> | null = null;

/**
 * diagrams.netの静的ビューアのスクリプトを、ページ全体で一度だけ読み込む
 * (モジュールスコープの単一のPromise。理由はファイル冒頭を参照)。
 */
function loadViewerScript(): Promise<void> {
  if (viewerScriptPromise !== null) {
    return viewerScriptPromise;
  }
  viewerScriptPromise = new Promise((resolve, reject) => {
    const existing = getGraphViewerGlobal();
    if (existing !== null) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = VIEWER_SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () =>
      reject(new Error(`failed to load ${VIEWER_SCRIPT_URL}`)),
    );
    document.head.appendChild(script);
  });
  return viewerScriptPromise;
}

type ViewerState = "loading" | "ready" | "error";

/**
 * draw.ioの図を1つ、diagrams.netの埋め込み用の静的ビューアでその場に描く。
 * `xml`は、`f/factory/steps/console_query.ts`の`requirements_doc`ビューが
 * 要件定義ディレクトリから読み出した、圧縮していないmxGraphのXML。
 */
export function DrawioViewer({
  name,
  xml,
}: {
  name: string;
  xml: string;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ViewerState>("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    loadViewerScript()
      .then(() => {
        if (cancelled) {
          return;
        }
        const graphViewer = getGraphViewerGlobal();
        if (graphViewer === null) {
          setState("error");
          return;
        }
        graphViewer.processElements();
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "error") {
    return (
      <div className="diagram-viewer diagram-viewer-error">
        図 {name} を読み込めませんでした(draw.io
        ビューアーの取得に失敗しました)。
      </div>
    );
  }

  const dataMxgraph = JSON.stringify({
    xml,
    nav: true,
    resize: true,
    toolbar: "zoom layers lightbox",
    highlight: "#0000ff",
  });

  return (
    <div className="diagram-viewer" ref={containerRef}>
      <div
        className="mxgraph"
        style={{ maxWidth: "100%" }}
        data-mxgraph={dataMxgraph}
      />
    </div>
  );
}
