import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api/errors.ts";
import { QueryFailureAlert } from "./QueryFailureAlert.tsx";

const MISMATCH = new ApiFailure({
  kind: "http",
  status: 422,
  detail: 'console_query: "view" must be one of inbox, pipeline',
});

function render(error: unknown): string {
  return renderToStaticMarkup(
    <QueryFailureAlert
      title="更新履歴を取得できませんでした"
      error={error}
      onRetry={() => {}}
    />,
  );
}

describe("QueryFailureAlert", () => {
  test("shows the title", () => {
    expect(render(MISMATCH)).toContain("更新履歴を取得できませんでした");
  });

  test("explains a version mismatch in the main text", () => {
    expect(render(MISMATCH)).toContain("版がずれている可能性");
  });

  test("puts the server text inside a details element", () => {
    expect(render(MISMATCH)).toMatch(
      /<details[^>]*>.*must be one of.*<\/details>/s,
    );
  });

  test("labels the details", () => {
    expect(render(MISMATCH)).toMatch(/<summary[^>]*>詳細<\/summary>/);
  });

  test("replaces hidden characters in the details", () => {
    expect(
      render(new ApiFailure({ kind: "job_failed", message: "a‮b" })),
    ).toContain("a�b");
  });

  test("keeps the server text out of the main text", () => {
    const html = render(MISMATCH);
    expect(html.slice(0, html.indexOf("<details"))).not.toContain(
      "must be one of",
    );
  });

  test("omits the details when the server sent no text", () => {
    expect(render(new ApiFailure({ kind: "network" }))).not.toContain(
      "<details",
    );
  });

  test("shows a retry button", () => {
    expect(render(MISMATCH)).toContain("もう一度取得する");
  });

  test("says the cause is unknown for an unclassified error", () => {
    expect(render(new Error("boom"))).toContain("原因は不明です。");
  });

  test("does not leak the message of an unclassified error", () => {
    expect(render(new Error("boom"))).not.toContain("boom");
  });
});
