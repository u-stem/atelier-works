import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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

function render(state: IntakeSnapshotViewState): string {
  return renderToStaticMarkup(<IntakeSnapshotView state={state} />);
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
      message: "ログインの有効期限が切れました。",
      onRetry: () => {},
    });
    expect(html).toContain("取り込み時点のIssueを取得できませんでした");
  });

  test("shows the failure message", () => {
    const html = render({
      status: "error",
      message: "ログインの有効期限が切れました。",
      onRetry: () => {},
    });
    expect(html).toContain("ログインの有効期限が切れました。");
  });

  test("shows a loading state", () => {
    expect(render({ status: "loading" })).toContain("読み込み中");
  });

  test("says when there is no snapshot", () => {
    expect(render({ status: "empty" })).toContain(
      "取り込み時点のIssueはありません",
    );
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
