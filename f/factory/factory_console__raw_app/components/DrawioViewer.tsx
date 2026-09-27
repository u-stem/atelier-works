// Inline draw.io (mxGraph) diagram rendering via diagrams.net's embeddable
// "static viewer" script (https://www.diagrams.net/doc/faq/embed-html-options
// — the `viewer-static.min.js` + `<div class="mxgraph" data-mxgraph='...'>`
// embedding convention). The XML never leaves the browser except to the
// diagrams.net CDN serving that one static script file — the diagram
// content itself is rendered entirely client-side from `data-mxgraph`'s
// JSON, never posted anywhere (see docs/security.md's draw.io note).
//
// The script is loaded at most once per page (module-scope singleton
// Promise) since every diagram on a document page shares the same
// `window.GraphViewer` global — a second `<script>` insertion would just
// re-run the same processElements() sweep redundantly.
//
// CSP / cross-origin script loading has not been runtime-verified in this
// change (no browser available in this environment) — see this component's
// entry in the implementer's final report for what to check when previewing
// the app (`wmill app dev`): whether the script tag is blocked by CSP
// (`Refused to load the script...` in the console) and whether the graph
// actually renders. If it is blocked, vendoring `viewer-static.min.js` under
// this app's own files (Apache-2.0 licensed) and importing it as a bundled
// asset is the fallback (not implemented here).

import React, { useEffect, useRef, useState } from "react";

const VIEWER_SCRIPT_URL = "https://viewer.diagrams.net/js/viewer-static.min.js";

type GraphViewerGlobal = {
  processElements: () => void;
};

declare global {
  interface Window {
    // Set by VIEWER_SCRIPT_URL once loaded — typed `unknown` here since
    // this app doesn't control that script; narrowed by
    // `isGraphViewerGlobal` before use.
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

/** Loads diagrams.net's static-viewer script exactly once for the whole
 * page (module-scope singleton — see this file's module doc comment). */
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

/** Renders one draw.io diagram inline via diagrams.net's embeddable static
 * viewer. `xml` is the raw (uncompressed) mxGraph XML read back from the
 * requirements doc dir by f/factory/steps/console_query.ts's
 * `requirements_doc` view. */
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
