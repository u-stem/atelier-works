import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildDrawioFrameHtml,
  buildFrameCsp,
} from "../../f/factory/factory_console__raw_app/lib/drawioFrameHtml.ts";
import {
  DRAWIO_FRAME_SCRIPT,
  DRAWIO_FRAME_SCRIPT_INTEGRITY,
  FRAME_MAX_XML_LENGTH,
} from "../../f/factory/factory_console__raw_app/lib/drawioFrameScript.ts";
import {
  DRAWIO_VIEWER_INTEGRITY,
  DRAWIO_VIEWER_SCRIPT_URL,
} from "../../f/factory/factory_console__raw_app/lib/drawioViewerPin.ts";

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("drawio frame script hash", () => {
  test("matches the sha256 of the receiver script", () => {
    const digest = createHash("sha256")
      .update(DRAWIO_FRAME_SCRIPT, "utf8")
      .digest("base64");
    expect(DRAWIO_FRAME_SCRIPT_INTEGRITY).toBe(`sha256-${digest}`);
  });

  test("does not contain a script end tag", () => {
    expect(DRAWIO_FRAME_SCRIPT.toLowerCase()).not.toContain("</script");
  });

  test("uses the same size limit as the parent", () => {
    expect(FRAME_MAX_XML_LENGTH).toBe(256 * 1024);
  });
});

describe("buildDrawioFrameHtml", () => {
  const html = buildDrawioFrameHtml();

  test("embeds exactly one inline script, the receiver script", () => {
    expect(inlineScripts(html)).toEqual([DRAWIO_FRAME_SCRIPT]);
  });

  test("loads the viewer from the pinned URL with SRI and anonymous CORS", () => {
    expect(html).toContain(
      `<script src="${DRAWIO_VIEWER_SCRIPT_URL}" integrity="${DRAWIO_VIEWER_INTEGRITY}" crossorigin="anonymous"></script>`,
    );
  });

  test("has no other script element", () => {
    expect(html.match(/<script/g)?.length).toBe(2);
  });

  test("puts the CSP meta tag before every script", () => {
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("<script"),
    );
  });

  test("carries the CSP in a meta tag", () => {
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${buildFrameCsp()}">`,
    );
  });

  test("is the same string every time", () => {
    expect(buildDrawioFrameHtml()).toBe(html);
  });

  test("starts the viewer before the receiver script", () => {
    expect(html.indexOf(DRAWIO_VIEWER_SCRIPT_URL)).toBeLessThan(
      html.indexOf(DRAWIO_FRAME_SCRIPT),
    );
  });
});

describe("buildFrameCsp", () => {
  const directives = buildFrameCsp().split("; ");

  test("denies everything by default", () => {
    expect(directives).toContain("default-src 'none'");
  });

  test("allows only the receiver script hash and the pinned viewer URL as scripts", () => {
    expect(directives).toContain(
      `script-src '${DRAWIO_FRAME_SCRIPT_INTEGRITY}' ${DRAWIO_VIEWER_SCRIPT_URL}`,
    );
  });

  test("denies connections", () => {
    expect(directives).toContain("connect-src 'none'");
  });

  test("allows images only as data URLs", () => {
    expect(directives).toContain("img-src data:");
  });

  test("allows fonts only as data URLs", () => {
    expect(directives).toContain("font-src data:");
  });

  test("denies a base URL", () => {
    expect(directives).toContain("base-uri 'none'");
  });

  test("denies form submission", () => {
    expect(directives).toContain("form-action 'none'");
  });

  test("does not allow eval", () => {
    expect(buildFrameCsp()).not.toContain("unsafe-eval");
  });

  test("does not allow inline scripts without the hash", () => {
    expect(buildFrameCsp()).not.toContain("script-src 'unsafe-inline'");
  });
});

type Listener = (event: unknown) => void;
type PostedMessage = { message: unknown; target: unknown };

type FakeElement = {
  className: string;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  querySelector: (selector: string) => unknown;
};

/**
 * 受け口のスクリプトを、偽のwindow・document・ビューアで実行する。
 * `new Function`の引数に渡した名前が、スクリプトから見えるグローバルになる。
 */
function runFrameScript(options: {
  withViewer?: boolean;
  withStencils?: boolean;
  renderSvg?: boolean;
  processThrows?: boolean;
  graphMethods?: string[];
}) {
  const parent = {};
  const posted: PostedMessage[] = [];
  const parentPost = (message: unknown, target: unknown) => {
    posted.push({ message, target });
  };
  Object.assign(parent, { postMessage: parentPost });
  const listeners: Record<string, { fn: Listener; capture: unknown }[]> = {};
  const documentListeners: Record<
    string,
    { fn: Listener; capture: unknown }[]
  > = {};
  const initialChildren: FakeElement[] = [];
  const diagram = {
    textContent: "initial",
    offsetHeight: 0,
    children: initialChildren,
    appendChild(element: FakeElement) {
      this.children.push(element);
    },
  };
  const fakeWindow = {
    parent,
    open: () => "opened",
    addEventListener(type: string, fn: Listener, capture?: unknown) {
      listeners[type] = [...(listeners[type] ?? []), { fn, capture }];
    },
  };
  const fakeDocument = {
    getElementById: (id: string) => (id === "diagram" ? diagram : null),
    createElement: (): FakeElement => ({
      className: "",
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      querySelector: () => (options.renderSvg === false ? null : {}),
    }),
    addEventListener(type: string, fn: Listener, capture?: unknown) {
      documentListeners[type] = [
        ...(documentListeners[type] ?? []),
        { fn, capture },
      ];
    },
  };

  const calls = { openLink: 0, loadStencilSet: 0, process: 0 };
  const graph = function Graph() {};
  graph.prototype.openLink = () => {
    calls.openLink += 1;
  };
  for (const name of options.graphMethods ?? []) {
    graph.prototype[name] = () => {
      calls.openLink += 1;
    };
  }
  const stencils = {
    dynamicLoading: true,
    allowEval: true,
    loadStencilSet: () => {
      calls.loadStencilSet += 1;
    },
  };
  const viewer = {
    processElements: () => {
      calls.process += 1;
      if (options.processThrows) throw new Error("secret detail");
    },
  };
  let resizeCallback: (() => void) | null = null;
  class FakeResizeObserver {
    constructor(callback: () => void) {
      resizeCallback = callback;
    }
    observe() {}
  }

  const run = new Function(
    "window",
    "document",
    "Graph",
    "GraphViewer",
    "mxStencilRegistry",
    "ResizeObserver",
    DRAWIO_FRAME_SCRIPT,
  );
  run(
    fakeWindow,
    fakeDocument,
    graph,
    options.withViewer === false ? undefined : viewer,
    options.withStencils === false ? undefined : stencils,
    FakeResizeObserver,
  );

  function send(source: unknown, data: unknown) {
    for (const { fn } of listeners.message ?? []) fn({ source, data });
  }

  return {
    parent,
    posted,
    calls,
    graph,
    stencils,
    diagram,
    fakeWindow,
    documentListeners,
    send,
    resize: () => resizeCallback?.(),
  };
}

describe("the receiver script", () => {
  test("turns Graph.prototype.openLink into a no-op", () => {
    const frame = runFrameScript({});
    frame.graph.prototype.openLink("https://example.com");
    expect(frame.calls.openLink).toBe(0);
  });

  test("turns labelLinkClicked into a no-op when it exists", () => {
    const frame = runFrameScript({ graphMethods: ["labelLinkClicked"] });
    frame.graph.prototype.labelLinkClicked();
    expect(frame.calls.openLink).toBe(0);
  });

  test("turns customLinkClicked into a no-op when it exists", () => {
    const frame = runFrameScript({ graphMethods: ["customLinkClicked"] });
    frame.graph.prototype.customLinkClicked();
    expect(frame.calls.openLink).toBe(0);
  });

  test("does not add labelLinkClicked when the viewer has none", () => {
    const frame = runFrameScript({});
    expect("labelLinkClicked" in frame.graph.prototype).toBe(false);
  });

  test("stops dynamic stencil loading", () => {
    const frame = runFrameScript({});
    expect(frame.stencils.dynamicLoading).toBe(false);
  });

  test("stops stencil evaluation", () => {
    const frame = runFrameScript({});
    expect(frame.stencils.allowEval).toBe(false);
  });

  test("turns loadStencilSet into a no-op", () => {
    const frame = runFrameScript({});
    frame.stencils.loadStencilSet();
    expect(frame.calls.loadStencilSet).toBe(0);
  });

  test("runs when the viewer has no stencil registry", () => {
    const frame = runFrameScript({ withStencils: false });
    expect(frame.documentListeners.click?.length).toBe(1);
  });

  test("makes window.open return nothing", () => {
    const frame = runFrameScript({});
    expect(frame.fakeWindow.open()).toBeNull();
  });

  test.each(["click", "auxclick", "submit"])(
    "cancels the default action of %s in the capture phase",
    (type) => {
      const frame = runFrameScript({});
      let prevented = false;
      const entry = frame.documentListeners[type]?.[0];
      entry?.fn({ preventDefault: () => (prevented = true) });
      expect([prevented, entry?.capture]).toEqual([true, true]);
    },
  );

  test("ignores a message that does not come from the parent", () => {
    const frame = runFrameScript({});
    frame.send({}, { type: "drawio:render", xml: "<mxfile/>" });
    expect(frame.calls.process).toBe(0);
  });

  test("ignores a message of another type", () => {
    const frame = runFrameScript({});
    frame.send(frame.parent, { type: "other", xml: "<mxfile/>" });
    expect(frame.calls.process).toBe(0);
  });

  test("ignores a message whose xml is not a string", () => {
    const frame = runFrameScript({});
    frame.send(frame.parent, { type: "drawio:render", xml: 1 });
    expect(frame.calls.process).toBe(0);
  });

  test("renders a message from the parent", () => {
    const frame = runFrameScript({});
    frame.send(frame.parent, { type: "drawio:render", xml: "<mxfile/>" });
    expect(frame.calls.process).toBe(1);
  });

  test("renders only once", () => {
    const frame = runFrameScript({});
    frame.send(frame.parent, { type: "drawio:render", xml: "<mxfile/>" });
    frame.send(frame.parent, { type: "drawio:render", xml: "<mxfile/>" });
    expect(frame.calls.process).toBe(1);
  });

  test("passes the xml to the viewer with the lightbox, navigation and toolbar off", () => {
    const frame = runFrameScript({});
    frame.send(frame.parent, { type: "drawio:render", xml: "<mxfile/>" });
    const config = JSON.parse(
      frame.diagram.children[0]?.attributes["data-mxgraph"] ?? "{}",
    );
    expect(config).toEqual({
      xml: "<mxfile/>",
      lightbox: false,
      nav: false,
      resize: true,
      "auto-fit": true,
    });
  });

  test("reports viewer_missing when the viewer is not loaded", () => {
    const frame = runFrameScript({ withViewer: false });
    frame.send(frame.parent, { type: "drawio:render", xml: "<mxfile/>" });
    expect(frame.posted).toEqual([
      {
        message: { type: "drawio:error", reason: "viewer_missing" },
        target: "*",
      },
    ]);
  });

  test("reports too_large for an xml over the limit", () => {
    const frame = runFrameScript({});
    frame.send(frame.parent, {
      type: "drawio:render",
      xml: "x".repeat(FRAME_MAX_XML_LENGTH + 1),
    });
    expect(frame.posted[0]?.message).toEqual({
      type: "drawio:error",
      reason: "too_large",
    });
  });

  test("reports render_failed without the exception text", () => {
    const frame = runFrameScript({ processThrows: true });
    frame.send(frame.parent, { type: "drawio:render", xml: "<mxfile/>" });
    expect(JSON.stringify(frame.posted)).not.toContain("secret detail");
  });

  test("reports render_failed when the viewer draws no svg", () => {
    const frame = runFrameScript({ renderSvg: false });
    frame.send(frame.parent, { type: "drawio:render", xml: "<mxfile/>" });
    expect(frame.posted[0]?.message).toEqual({
      type: "drawio:error",
      reason: "render_failed",
    });
  });

  test("sends the height to the parent when the diagram resizes", () => {
    const frame = runFrameScript({});
    frame.diagram.offsetHeight = 123.2;
    frame.resize();
    expect(frame.posted).toEqual([
      { message: { type: "drawio:height", height: 124 }, target: "*" },
    ]);
  });
});
