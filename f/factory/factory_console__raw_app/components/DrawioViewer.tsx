// diagrams.netの埋め込み用の静的ビューア(`viewer-static.min.js`と
// `<div class="mxgraph" data-mxgraph='...'>`の規約。
// https://www.diagrams.net/doc/faq/embed-html-options)で、draw.io(mxGraph)の
// 図をその場に描く。図の内容は`data-mxgraph`のJSONからブラウザの中だけで描画し、
// どこにも送らない。外部と通信するのは、ビューアのスクリプト1つの取得だけである。
//
// このコンポーネントは、Windmillと同じオリジンでビューアを動かす。図のXMLは
// 信頼できないIssueの内容に由来するので、次の多層防御を置く(`docs/security.md`の
// draw.ioの節を参照)。
// - スクリプトはcommitを固定したjsDelivrのURLから、SRIを付けて読む
//   (`lib/drawioViewerPin.ts`。値は`console/drawio-viewer.json`と同じ)。
//   SRIが合わなければブラウザが実行せず、図は読み込み失敗の表示になる。
// - `lightbox`・`nav`・ツールバーを切り、図の入れ物でclickとauxclickの
//   既定の動作を止めて、図のリンクで外へ遷移させない。
// - `f/factory/lib/drawio.ts`の`validateDrawioXml`が、`link`属性などを含む図を
//   生成の時点で拒否する。
//
// 文書ページの図はすべて同じ`window.GraphViewer`を共有するので、スクリプトは
// ページごとに一度だけ読み込む(モジュールスコープの単一のPromise)。
// `<script>`を2回入れても、同じ`processElements()`をもう一度走らせるだけになる。
//
// ブラウザでの実行時には確かめていない点がある。`wmill app dev`で、
// jsDelivrのURLがスクリプトとして読めてSRIが通ること(コンソールに
// SRIの不一致や`Refused to load the script...`が出ないこと)と、
// 図が実際に描かれることを確かめる。
// 読めない場合の代替は、`viewer-static.min.js`(Apache-2.0)をこのアプリの
// ファイルとして同梱し、バンドルする資産としてimportすること(未実装)。

import React, { useEffect, useRef, useState } from "react";
import {
  buildGraphViewerConfig,
  DRAWIO_VIEWER_INTEGRITY,
  DRAWIO_VIEWER_SCRIPT_URL,
} from "../lib/drawioViewerPin";

type GraphViewerGlobal = {
  processElements: () => void;
};

declare global {
  interface Window {
    // `DRAWIO_VIEWER_SCRIPT_URL`のスクリプトが読み込み後に設定する。このアプリが
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
 * 固定したビューアのスクリプトを、ページ全体で一度だけ読み込む
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
    script.src = DRAWIO_VIEWER_SCRIPT_URL;
    script.integrity = DRAWIO_VIEWER_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.async = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () =>
      reject(new Error(`failed to load ${DRAWIO_VIEWER_SCRIPT_URL}`)),
    );
    document.head.appendChild(script);
  });
  return viewerScriptPromise;
}

type ViewerState = "loading" | "ready" | "error";

/**
 * draw.ioの図を1つ、埋め込み用の静的ビューアでその場に描く。
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

  // 図の中のクリックは、押された要素を問わず既定の動作を止める。
  // 図のラベルのリンク(`<a href>`)を押しても、ページが遷移しない。
  // 捕捉の段階で止めるので、図の内側の要素のhandlerより先に動く。
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const block = (event: Event) => event.preventDefault();
    container.addEventListener("click", block, { capture: true });
    container.addEventListener("auxclick", block, { capture: true });
    return () => {
      container.removeEventListener("click", block, { capture: true });
      container.removeEventListener("auxclick", block, { capture: true });
    };
  }, []);

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

  const dataMxgraph = buildGraphViewerConfig(xml);

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
