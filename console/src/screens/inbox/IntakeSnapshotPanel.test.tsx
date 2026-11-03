import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import type { IntakeSnapshot } from "../../api/guards/intakeSnapshot.ts";
import {
  IntakeSnapshotView,
  type IntakeSnapshotViewState,
  tailWarning,
} from "./IntakeSnapshotPanel.tsx";

const SNAPSHOT: IntakeSnapshot = {
  work_item_id: 7,
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  body: "Original body",
  body_truncated: false,
  body_tail_html_comments: 0,
  body_tail_hidden_chars: 0,
  refreshed: false,
};

const NOTICE =
  "プレビューは、生のHTML(コメントを含む)、リンク参照定義、画像を描かず、見えない文字を置き換えずに描くことがあります。承認の対象は原文です。";

function render(
  state: IntakeSnapshotViewState,
  mode?: "preview" | "text",
): string {
  return renderToStaticMarkup(
    mode === undefined ? (
      <IntakeSnapshotView state={state} />
    ) : (
      <IntakeSnapshotView state={state} mode={mode} />
    ),
  );
}

function loaded(overrides: Partial<IntakeSnapshot> = {}): string {
  return render({
    status: "loaded",
    snapshot: { ...SNAPSHOT, ...overrides },
  });
}

describe("IntakeSnapshotView", () => {
  test("shows the title and body", () => {
    expect(loaded()).toContain("Original body");
  });

  test("escapes markup in the body instead of rendering it", () => {
    expect(loaded({ body: "<img src=x onerror=alert(1)>" })).toContain(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  test("shows no warning for ordinary content", () => {
    expect(loaded()).not.toContain("不可視の文字を含みます");
  });

  test("warns about invisible characters", () => {
    expect(loaded({ body: "a\u200Bb" })).toContain("不可視の文字を含みます");
  });

  test("warns about invisible characters in the title", () => {
    expect(loaded({ title: "a\u202Eb" })).toContain("不可視の文字を含みます");
  });

  test("replaces invisible characters with the replacement character", () => {
    expect(loaded({ body: "a\u200Bb" })).toContain("a\uFFFDb");
  });

  test("says when the body was cut", () => {
    expect(loaded({ body_truncated: true })).toContain(
      "本文が長いため、先頭だけを表示しています",
    );
  });

  test("says that GitHub may hide content when the body was cut", () => {
    expect(loaded({ body_truncated: true })).toContain(
      "GitHubの画面では見えない内容",
    );
  });

  test("warns about comments in the part that was cut", () => {
    expect(
      loaded({ body_truncated: true, body_tail_html_comments: 2 }),
    ).toContain("HTMLのコメント(&lt;!--)が2個");
  });

  test("warns about hidden characters in the part that was cut", () => {
    expect(
      loaded({ body_truncated: true, body_tail_hidden_chars: 3 }),
    ).toContain("画面に出せない文字が3個");
  });

  test("shows a note for an empty body", () => {
    expect(loaded({ body: "" })).toContain("(本文は空です)");
  });

  test("warns prominently when the content was refreshed", () => {
    expect(loaded({ refreshed: true })).toContain(
      "取り込み後に書き換えられたIssueの内容です",
    );
  });

  test("does not warn about a refresh when the content was not refreshed", () => {
    expect(loaded()).not.toContain("取り込み後に書き換えられたIssueの内容です");
  });

  test("shows the failure and a retry button", () => {
    const html = render({
      status: "error",
      error: new ApiFailure({ kind: "network" }),
      onRetry: () => {},
    });
    expect(html).toContain("取り込み時点のIssueを取得できませんでした");
  });

  test("shows the failure message", () => {
    const html = render({
      status: "error",
      error: new ApiFailure({ kind: "unauthorized" }),
      onRetry: () => {},
    });
    expect(html).toContain("ログインの有効期限が切れました。");
  });

  test("shows a loading state once the delay has passed", () => {
    expect(render({ status: "loading", display: "skeleton" })).toContain(
      "読み込み中",
    );
  });

  test("shows only the frame in the first moment of loading", () => {
    expect(render({ status: "loading", display: "frame" })).not.toContain(
      "読み込み中",
    );
  });

  test("says when there is no snapshot", () => {
    expect(render({ status: "empty" })).toContain(
      "取り込み時点のIssueはありません",
    );
  });
});

function preview(overrides: Partial<IntakeSnapshot> = {}): string {
  return renderToStaticMarkup(
    <IntakeSnapshotView
      state={{ status: "loaded", snapshot: { ...SNAPSHOT, ...overrides } }}
      mode="preview"
    />,
  );
}

/** 描いた`<pre>`の中身を、エスケープを戻して取り出す。 */
function preText(html: string): string {
  const inner = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "";
  return inner
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("IntakeSnapshotView in the source mode", () => {
  test("starts as the source", () => {
    expect(loaded()).not.toContain("data-preview");
  });

  test("starts with the pre", () => {
    expect(loaded()).toContain("<pre");
  });

  test("does not show the notice in the source", () => {
    expect(loaded()).not.toContain(NOTICE);
  });

  test("restores the body from the pre without markdown", () => {
    const body = "a <!-- c --> **b**\n| x | y |";
    expect(preText(loaded({ body }))).toBe(body);
  });

  test("does not make the body bold in the source", () => {
    expect(loaded({ body: "**b**" })).not.toContain("<strong>");
  });

  test("shows the switch that the screen passes", () => {
    const html = renderToStaticMarkup(
      <IntakeSnapshotView
        state={{ status: "loaded", snapshot: SNAPSHOT }}
        modeSwitch={<span>switch-slot</span>}
      />,
    );
    expect(html).toContain("switch-slot");
  });

  test("does not show the switch while the snapshot is missing", () => {
    const html = renderToStaticMarkup(
      <IntakeSnapshotView
        state={{ status: "empty" }}
        modeSwitch={<span>switch-slot</span>}
      />,
    );
    expect(html).not.toContain("switch-slot");
  });
});

describe("IntakeSnapshotView in the preview mode", () => {
  test("marks the preview", () => {
    expect(preview()).toContain("data-preview");
  });

  test("shows the notice in the preview", () => {
    expect(preview()).toContain(NOTICE);
  });

  test("draws the body as markdown", () => {
    expect(preview({ body: "**b**" })).toContain("<strong>b</strong>");
  });

  test("does not draw the pre in the preview", () => {
    expect(preview()).not.toContain("<pre");
  });

  test("does not render raw html in the preview", () => {
    expect(preview({ body: "<img src=x onerror=alert(1)>" })).not.toContain(
      "<img",
    );
  });

  test("does not render the text after an unclosed comment in the preview", () => {
    expect(preview({ body: "before\n<!-- unclosed\nsecret" })).not.toContain(
      "secret",
    );
  });

  test("does not link another repository in the preview", () => {
    expect(
      preview({ body: "[x](https://github.com/other/repo/issues/1)" }),
    ).not.toContain('href="https://github.com/other');
  });

  test("links an issue of the same repository in the preview", () => {
    expect(preview({ body: "[x](https://github.com/o/r/issues/1)" })).toContain(
      'href="https://github.com/o/r/issues/1"',
    );
  });

  test("does not render an unsafe link definition", () => {
    expect(
      preview({ body: "[r]: javascript:alert(1)\n\n[x][r]" }),
    ).not.toContain("javascript:");
  });

  test("does not render an image of the console api", () => {
    expect(preview({ body: "![x](/api/secret)" })).not.toContain("<img");
  });

  test("replaces hidden characters in the preview", () => {
    expect(preview({ body: "a\u200Bb" })).toContain("a\uFFFDb");
  });

  test("says that the body is empty in the preview", () => {
    expect(preview({ body: "" })).toContain("(本文は空です)");
  });

  test("keeps the refresh warning in the preview", () => {
    expect(preview({ refreshed: true })).toContain(
      "取り込み後に書き換えられたIssueの内容です",
    );
  });

  test("keeps the hidden character warning in the preview", () => {
    expect(preview({ body: "a\u200Bb" })).toContain("不可視の文字を含みます");
  });

  test("keeps the truncation warning in the preview", () => {
    expect(preview({ body_truncated: true })).toContain(
      "本文が長いため、先頭だけを表示しています",
    );
  });

  test("keeps the warning about the cut part in the preview", () => {
    expect(
      preview({ body_truncated: true, body_tail_html_comments: 2 }),
    ).toContain("HTMLのコメント(&lt;!--)が2個");
  });

  test("keeps the title as plain text in the preview", () => {
    expect(preview({ title: "**Add**" })).toContain("**Add**");
  });
});

describe("tailWarning", () => {
  test("is null when nothing is hidden in the cut part", () => {
    expect(tailWarning(SNAPSHOT)).toBeNull();
  });

  test("names both counts", () => {
    expect(
      tailWarning({
        ...SNAPSHOT,
        body_tail_html_comments: 1,
        body_tail_hidden_chars: 2,
      }),
    ).toBe(
      "表示していない後ろの部分に、HTMLのコメント(<!--)が1個と画面に出せない文字が2個あります。",
    );
  });
});
