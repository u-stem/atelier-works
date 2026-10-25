import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import {
  freshQuery,
  loadingQuery,
  pausedQuery,
  staleQuery,
} from "../../api/fakeSectionQuery.testing.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { OFFLINE_WAIT_TEXT } from "../../components/LoadingState.tsx";
import { AnalyticsSection } from "./AnalyticsSection.tsx";

const NOTICE = "前回取得した値を表示しています";

function render(query: SectionQuery<string[]>): string {
  return renderToStaticMarkup(
    <AnalyticsSection
      id="x-heading"
      title="区画"
      failureTitle="区画"
      emptyMessage="空です"
      query={query}
    >
      {(rows) => <p>{rows.join(",")}</p>}
    </AnalyticsSection>,
  );
}

describe("AnalyticsSection", () => {
  test("says the rows are stale after a failed refetch", () => {
    expect(
      render(staleQuery(["a"], new ApiFailure({ kind: "network" }))),
    ).toContain(NOTICE);
  });

  test("says the rows are stale when the previous rows were empty", () => {
    expect(
      render(staleQuery<string[]>([], new ApiFailure({ kind: "network" }))),
    ).toContain(NOTICE);
  });

  test("offers a retry when the previous rows were empty", () => {
    expect(
      render(staleQuery<string[]>([], new ApiFailure({ kind: "network" }))),
    ).toContain("もう一度取得する");
  });

  test("keeps the empty message beside the notice", () => {
    expect(
      render(staleQuery<string[]>([], new ApiFailure({ kind: "network" }))),
    ).toContain("空です");
  });

  test("does not say the rows are stale for a 401", () => {
    expect(
      render(staleQuery(["a"], new ApiFailure({ kind: "unauthorized" }))),
    ).not.toContain(NOTICE);
  });

  test("does not say the rows are stale without a failure", () => {
    expect(render(freshQuery(["a"]))).not.toContain(NOTICE);
  });
});

describe("AnalyticsSection while loading", () => {
  test("shows only the frame in the first moment", () => {
    expect(render(loadingQuery<string[]>())).not.toContain("読み込み中");
  });

  test("tells the user that the fetch waits for the network", () => {
    expect(render(pausedQuery<string[]>())).toContain(OFFLINE_WAIT_TEXT);
  });
});
