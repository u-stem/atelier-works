import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import { freshQuery, staleQuery } from "../../api/fakeSectionQuery.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { SystemSection } from "./SystemSection.tsx";

function render(query: SectionQuery<string>): string {
  return renderToStaticMarkup(
    <SystemSection
      id="x-heading"
      title="節"
      description="説明"
      query={query}
      loginHint="ログインしてください"
    >
      {(data) => <p>{data}</p>}
    </SystemSection>,
  );
}

describe("SystemSection", () => {
  test("shows the previous values", () => {
    expect(
      render(staleQuery("前の値", new ApiFailure({ kind: "network" }))),
    ).toContain("前の値");
  });

  test("says the values are stale after a failed refetch", () => {
    expect(
      render(staleQuery("前の値", new ApiFailure({ kind: "network" }))),
    ).toContain("前回取得した値を表示しています");
  });

  test("does not say the values are stale for a 401", () => {
    expect(
      render(staleQuery("前の値", new ApiFailure({ kind: "unauthorized" }))),
    ).not.toContain("前回取得した値を表示しています");
  });

  test("does not say the values are stale without a failure", () => {
    expect(render(freshQuery("前の値"))).not.toContain(
      "前回取得した値を表示しています",
    );
  });
});
