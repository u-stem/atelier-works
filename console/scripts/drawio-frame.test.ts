import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

// public/assets/drawio-frame-*.jsは、ビルドを通らない素のJavaScriptである。
// ブラウザの代わりに、window・document・ResizeObserver・GraphViewerのスタブを付けて評価し、
// 受け取ったメッセージごとの振る舞いを確かめる。
const PUBLIC_ASSETS = join(import.meta.dir, "../public/assets");
const frameName = readdirSync(PUBLIC_ASSETS).find((name) =>
  name.startsWith("drawio-frame-"),
);
const SCRIPT = readFileSync(join(PUBLIC_ASSETS, frameName ?? ""), "utf8");

const MAX_XML_LENGTH = 256 * 1024;
const VIEWER_MISSING_TEXT = "ビューアが読み込まれていません";
const RENDER_FAILED_TEXT = "図を表示できません";

type Listener = (event: Record<string, unknown>) => void;

type Options = {
  readonly viewer?: "missing" | "ok" | "throws";
  readonly svg?: boolean;
  readonly noDiagram?: boolean;
};

function createFrame(options: Options = {}) {
  const sent: unknown[] = [];
  const listeners: Record<string, Listener[]> = {};
  const resizeCallbacks: (() => void)[] = [];
  const attributes: Record<string, string> = {};
  const counts = { processElements: 0, originalOpenLink: 0 };
  const parent = {
    postMessage: (message: unknown) => {
      sent.push(message);
    },
  };
  const addListener = (type: string, listener: Listener) => {
    listeners[type] = [...(listeners[type] ?? []), listener];
  };
  const element = {
    className: "",
    setAttribute: (key: string, value: string) => {
      attributes[key] = value;
    },
    querySelector: () => (options.svg === false ? null : {}),
  };
  const diagram = {
    textContent: "",
    offsetHeight: 120.4,
    appendChild: () => {},
  };
  class FakeResizeObserver {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback);
    }
    observe() {}
  }
  const graphPrototype = {
    openLink: () => {
      counts.originalOpenLink += 1;
    },
  };
  const context: Record<string, unknown> = {
    window: { parent, addEventListener: addListener },
    document: {
      getElementById: () => (options.noDiagram === true ? null : diagram),
      createElement: () => element,
      addEventListener: addListener,
    },
    ResizeObserver: FakeResizeObserver,
    Graph: { prototype: graphPrototype },
  };
  if (options.viewer !== "missing") {
    context.GraphViewer = {
      processElements: () => {
        counts.processElements += 1;
        if (options.viewer === "throws") {
          throw new Error("boom");
        }
      },
    };
  }
  runInNewContext(SCRIPT, context);
  const dispatch = (type: string, event: Record<string, unknown>) => {
    for (const listener of listeners[type] ?? []) {
      listener(event);
    }
  };
  return {
    parent,
    sent,
    attributes,
    counts,
    diagram,
    graphPrototype,
    listeners,
    resizeCallbacks,
    send: (source: unknown, data: unknown) =>
      dispatch("message", { source, data }),
    dispatch,
  };
}

const XML = "<mxGraphModel/>";

describe("drawio-frame script: accepting render messages", () => {
  test("renders a render message from the parent window", () => {
    const frame = createFrame();
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.counts.processElements).toBe(1);
  });

  test("passes the xml to the viewer through data-mxgraph", () => {
    const frame = createFrame();
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(JSON.parse(frame.attributes["data-mxgraph"] ?? "{}").xml).toBe(XML);
  });

  test("disables the lightbox in the viewer config", () => {
    const frame = createFrame();
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(JSON.parse(frame.attributes["data-mxgraph"] ?? "{}").lightbox).toBe(
      false,
    );
  });

  test("does not report an error for a normal render", () => {
    const frame = createFrame();
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.sent).toEqual([]);
  });

  test("renders only the first render message", () => {
    const frame = createFrame();
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.counts.processElements).toBe(1);
  });
});

describe("drawio-frame script: ignoring messages", () => {
  test("ignores a message from a window other than the parent", () => {
    const frame = createFrame();
    frame.send({}, { type: "drawio:render", xml: XML });
    expect(frame.counts.processElements).toBe(0);
  });

  test("ignores a message without a source", () => {
    const frame = createFrame();
    frame.send(undefined, { type: "drawio:render", xml: XML });
    expect(frame.counts.processElements).toBe(0);
  });

  test("ignores a message of another type", () => {
    const frame = createFrame();
    frame.send(frame.parent, { type: "drawio:height", xml: XML });
    expect(frame.counts.processElements).toBe(0);
  });

  test("ignores data that is not an object", () => {
    const frame = createFrame();
    frame.send(frame.parent, "drawio:render");
    expect(frame.counts.processElements).toBe(0);
  });

  test("ignores null data", () => {
    const frame = createFrame();
    frame.send(frame.parent, null);
    expect(frame.counts.processElements).toBe(0);
  });

  test("ignores an xml that is not a string", () => {
    const frame = createFrame();
    frame.send(frame.parent, { type: "drawio:render", xml: { length: 1 } });
    expect(frame.counts.processElements).toBe(0);
  });

  test("still renders after ignoring a message from another window", () => {
    const frame = createFrame();
    frame.send({}, { type: "drawio:render", xml: XML });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.counts.processElements).toBe(1);
  });
});

describe("drawio-frame script: failures are reported", () => {
  test("does not render an xml over the limit", () => {
    const frame = createFrame();
    frame.send(frame.parent, {
      type: "drawio:render",
      xml: "a".repeat(MAX_XML_LENGTH + 1),
    });
    expect(frame.counts.processElements).toBe(0);
  });

  test("reports too_large for an xml over the limit", () => {
    const frame = createFrame();
    frame.send(frame.parent, {
      type: "drawio:render",
      xml: "a".repeat(MAX_XML_LENGTH + 1),
    });
    expect(frame.sent).toEqual([{ type: "drawio:error", reason: "too_large" }]);
  });

  test("renders an xml of exactly the limit", () => {
    const frame = createFrame();
    frame.send(frame.parent, {
      type: "drawio:render",
      xml: "a".repeat(MAX_XML_LENGTH),
    });
    expect(frame.counts.processElements).toBe(1);
  });

  test("reports viewer_missing when the viewer is not loaded", () => {
    const frame = createFrame({ viewer: "missing" });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.sent).toEqual([
      { type: "drawio:error", reason: "viewer_missing" },
    ]);
  });

  test("shows a fixed sentence when the viewer is not loaded", () => {
    const frame = createFrame({ viewer: "missing" });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.diagram.textContent).toBe(VIEWER_MISSING_TEXT);
  });

  test("reports render_failed when processElements throws", () => {
    const frame = createFrame({ viewer: "throws" });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.sent).toEqual([
      { type: "drawio:error", reason: "render_failed" },
    ]);
  });

  test("shows a fixed sentence when processElements throws", () => {
    const frame = createFrame({ viewer: "throws" });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.diagram.textContent).toBe(RENDER_FAILED_TEXT);
  });

  test("does not put the exception message into the page", () => {
    const frame = createFrame({ viewer: "throws" });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.diagram.textContent).not.toContain("boom");
  });

  test("reports render_failed when the viewer draws nothing", () => {
    const frame = createFrame({ svg: false });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.sent).toEqual([
      { type: "drawio:error", reason: "render_failed" },
    ]);
  });

  test("does not render again after a failure", () => {
    const frame = createFrame({ viewer: "throws" });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    frame.send(frame.parent, { type: "drawio:render", xml: XML });
    expect(frame.counts.processElements).toBe(1);
  });
});

describe("drawio-frame script: height", () => {
  test("reports the measured height rounded up", () => {
    const frame = createFrame();
    for (const callback of frame.resizeCallbacks) {
      callback();
    }
    expect(frame.sent).toEqual([{ type: "drawio:height", height: 121 }]);
  });
});

describe("drawio-frame script: links", () => {
  test("cancels a click on a plain element", () => {
    const frame = createFrame();
    let prevented = false;
    frame.dispatch("click", {
      target: {},
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });

  test("cancels a click inside a link", () => {
    const frame = createFrame();
    let prevented = false;
    frame.dispatch("click", {
      target: { closest: () => ({}) },
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });

  test("cancels a middle click", () => {
    const frame = createFrame();
    let prevented = false;
    frame.dispatch("auxclick", {
      target: {},
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });

  test("does not open a link through the viewer", () => {
    const frame = createFrame();
    frame.graphPrototype.openLink();
    expect(frame.counts.originalOpenLink).toBe(0);
  });
});

describe("drawio-frame script: without the diagram element", () => {
  test("does nothing", () => {
    const frame = createFrame({ noDiagram: true });
    expect(Object.keys(frame.listeners)).toEqual([]);
  });
});
