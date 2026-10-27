import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LoadingBody,
  LoadingGate,
  type LoadingShape,
  LoadingStateView,
  loadingDisplayOf,
  SkeletonListCard,
  SkeletonSection,
} from "./LoadingState.tsx";

const SHAPE: LoadingShape = { rows: 3, rowClassName: "h-12 rounded-md" };

function count(markup: string, token: string): number {
  return markup.split(token).length - 1;
}

describe("LoadingStateView", () => {
  test("announces loading when visible", () => {
    expect(
      renderToStaticMarkup(<LoadingStateView visible shape={SHAPE} />),
    ).toContain('role="status"');
  });

  test("says loading in text when visible", () => {
    expect(
      renderToStaticMarkup(<LoadingStateView visible shape={SHAPE} />),
    ).toContain("読み込み中");
  });

  test("draws one skeleton per row when visible", () => {
    expect(
      count(
        renderToStaticMarkup(<LoadingStateView visible shape={SHAPE} />),
        'data-slot="skeleton"',
      ),
    ).toBe(3);
  });

  test("does not announce loading while still hidden", () => {
    expect(
      renderToStaticMarkup(<LoadingStateView visible={false} shape={SHAPE} />),
    ).not.toContain('role="status"');
  });

  test("keeps the frame height while hidden", () => {
    expect(
      count(
        renderToStaticMarkup(
          <LoadingStateView visible={false} shape={SHAPE} />,
        ),
        "h-12",
      ),
    ).toBe(3);
  });

  test("hides the frame blocks from the eye while hidden", () => {
    expect(
      renderToStaticMarkup(<LoadingStateView visible={false} shape={SHAPE} />),
    ).toContain("invisible");
  });

  test("shows the skeleton blocks when visible", () => {
    expect(
      renderToStaticMarkup(<LoadingStateView visible shape={SHAPE} />),
    ).not.toContain("invisible");
  });

  test("uses the gap of the shape", () => {
    expect(
      renderToStaticMarkup(
        <LoadingStateView
          visible
          shape={{ ...SHAPE, gapClassName: "gap-1" }}
        />,
      ),
    ).toContain("gap-1");
  });
});

describe("LoadingGate", () => {
  test("shows the content once loaded", () => {
    expect(
      renderToStaticMarkup(
        <LoadingGate phase="loaded" shape={SHAPE}>
          <p>内容</p>
        </LoadingGate>,
      ),
    ).toContain("内容");
  });

  test("shows the content on a failure so the caller can explain it", () => {
    expect(
      renderToStaticMarkup(
        <LoadingGate phase="failed" shape={SHAPE}>
          <p>失敗の説明</p>
        </LoadingGate>,
      ),
    ).toContain("失敗の説明");
  });

  test("shows only the frame in the first moment of loading", () => {
    expect(
      renderToStaticMarkup(
        <LoadingGate phase="loading" shape={SHAPE}>
          <p>内容</p>
        </LoadingGate>,
      ),
    ).not.toContain("内容");
  });

  test("holds the frame height in the first moment of loading", () => {
    expect(
      count(
        renderToStaticMarkup(
          <LoadingGate phase="loading" shape={SHAPE}>
            <p>内容</p>
          </LoadingGate>,
        ),
        "h-12",
      ),
    ).toBe(3);
  });

  test("does not say loading in the first moment of loading", () => {
    expect(
      renderToStaticMarkup(
        <LoadingGate phase="loading" shape={SHAPE}>
          <p>内容</p>
        </LoadingGate>,
      ),
    ).not.toContain("読み込み中");
  });
});

describe("loadingDisplayOf", () => {
  test("shows the content when loaded and not lingering", () => {
    expect(loadingDisplayOf("loaded", false)).toBe("content");
  });

  test("shows the content on a failure so the caller can explain it", () => {
    expect(loadingDisplayOf("failed", false)).toBe("content");
  });

  test("holds the frame while loading and the delay has not passed", () => {
    expect(loadingDisplayOf("loading", false)).toBe("frame");
  });

  test("shows the skeleton while loading after the delay", () => {
    expect(loadingDisplayOf("loading", true)).toBe("skeleton");
  });

  test("keeps the skeleton while lingering after the data arrived", () => {
    expect(loadingDisplayOf("loaded", true)).toBe("skeleton");
  });

  test("drops the skeleton at once when lingering is off and the data arrived", () => {
    expect(loadingDisplayOf("loaded", true, false)).toBe("content");
  });

  test("drops the skeleton at once when lingering is off and the fetch failed", () => {
    expect(loadingDisplayOf("failed", true, false)).toBe("content");
  });

  test("still shows the skeleton while loading when lingering is off", () => {
    expect(loadingDisplayOf("loading", true, false)).toBe("skeleton");
  });

  test("keeps the skeleton while lingering after a failure", () => {
    expect(loadingDisplayOf("failed", true)).toBe("skeleton");
  });
});

const NODE_SHAPE: LoadingShape = {
  node: <p>画面の形</p>,
  className: "min-h-40",
};

describe("LoadingStateView with a screen shape", () => {
  test("draws the given node", () => {
    expect(
      renderToStaticMarkup(<LoadingStateView visible shape={NODE_SHAPE} />),
    ).toContain("画面の形");
  });

  test("uses the given class on the frame", () => {
    expect(
      renderToStaticMarkup(<LoadingStateView visible shape={NODE_SHAPE} />),
    ).toContain("min-h-40");
  });

  test("announces loading when visible", () => {
    expect(
      renderToStaticMarkup(<LoadingStateView visible shape={NODE_SHAPE} />),
    ).toContain('role="status"');
  });

  test("keeps the node but hides it while still waiting", () => {
    expect(
      renderToStaticMarkup(
        <LoadingStateView visible={false} shape={NODE_SHAPE} />,
      ),
    ).toContain("invisible");
  });

  test("does not announce loading while still waiting", () => {
    expect(
      renderToStaticMarkup(
        <LoadingStateView visible={false} shape={NODE_SHAPE} />,
      ),
    ).not.toContain("読み込み中");
  });
});

describe("LoadingBody", () => {
  test("draws nothing for the content", () => {
    expect(
      renderToStaticMarkup(<LoadingBody display="content" shape={SHAPE} />),
    ).toBe("");
  });

  test("announces loading for the skeleton", () => {
    expect(
      renderToStaticMarkup(<LoadingBody display="skeleton" shape={SHAPE} />),
    ).toContain("読み込み中");
  });

  test("keeps the frame silent", () => {
    expect(
      renderToStaticMarkup(<LoadingBody display="frame" shape={SHAPE} />),
    ).not.toContain("読み込み中");
  });
});

describe("SkeletonListCard", () => {
  const html = renderToStaticMarkup(
    <SkeletonListCard
      rows={3}
      rowClassName="h-[4.625rem]"
      className="max-w-4xl"
    />,
  );

  test("draws a bordered card", () => {
    expect(html).toContain(
      "overflow-hidden rounded-xl border border-border bg-card",
    );
  });

  test("draws the requested number of rows", () => {
    expect(count(html, "h-[4.625rem]")).toBe(3);
  });

  test("passes the card class on", () => {
    expect(html).toContain("max-w-4xl");
  });

  test("draws no line under the last row", () => {
    expect(html).toContain("last:border-b-0");
  });

  test("hides the skeleton from the reading order", () => {
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("SkeletonSection", () => {
  const html = renderToStaticMarkup(<SkeletonSection block="h-[5.7rem]" />);

  test("draws the heading row as tall as a heading of the real screen", () => {
    expect(html).toContain("h-[1.7rem]");
  });

  test("draws the block with the given height", () => {
    expect(html).toContain("h-[5.7rem]");
  });

  test("keeps the 12px gap between the heading and the block", () => {
    expect(html).toContain("flex flex-col gap-3");
  });
});
