import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LoadingGate,
  type LoadingShape,
  LoadingStateView,
  OFFLINE_WAIT_TEXT,
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

  test("tells the user that the fetch waits for the network", () => {
    expect(
      renderToStaticMarkup(
        <LoadingGate phase="paused" shape={SHAPE}>
          <p>内容</p>
        </LoadingGate>,
      ),
    ).toContain(OFFLINE_WAIT_TEXT);
  });

  test("shows no skeleton while the fetch waits for the network", () => {
    expect(
      renderToStaticMarkup(
        <LoadingGate phase="paused" shape={SHAPE}>
          <p>内容</p>
        </LoadingGate>,
      ),
    ).not.toContain('data-slot="skeleton"');
  });
});

describe("OFFLINE_WAIT_TEXT", () => {
  test("says the fetch is waiting because of the connection", () => {
    expect(OFFLINE_WAIT_TEXT).toBe("オフラインのため、取得を待っています");
  });
});
