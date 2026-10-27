import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import {
  freshQuery,
  loadingQuery,
  staleQuery,
} from "../../api/fakeSectionQuery.testing.ts";
import type { RequirementsIndexRow } from "../../api/guards/requirements.ts";
import { RequirementsSection } from "./RequirementsSection.tsx";

const NOTICE = "前回取得した値を表示しています";
const NO_ROWS: readonly RequirementsIndexRow[] = [];

describe("RequirementsSection", () => {
  test("says the rows are stale after a failed refetch", () => {
    const query = staleQuery(NO_ROWS, new ApiFailure({ kind: "network" }));
    expect(
      renderToStaticMarkup(<RequirementsSection index={query} />),
    ).toContain(NOTICE);
  });

  test("does not say the rows are stale for a 401", () => {
    const query = staleQuery(NO_ROWS, new ApiFailure({ kind: "unauthorized" }));
    expect(
      renderToStaticMarkup(<RequirementsSection index={query} />),
    ).not.toContain(NOTICE);
  });

  test("does not say the rows are stale without a failure", () => {
    expect(
      renderToStaticMarkup(<RequirementsSection index={freshQuery(NO_ROWS)} />),
    ).not.toContain(NOTICE);
  });
});

describe("RequirementsSection while loading", () => {
  test("shows only the frame in the first moment", () => {
    expect(
      renderToStaticMarkup(
        <RequirementsSection
          index={loadingQuery<readonly RequirementsIndexRow[]>()}
        />,
      ),
    ).not.toContain("読み込み中");
  });

  test("holds the height of the list in the first moment", () => {
    expect(
      renderToStaticMarkup(
        <RequirementsSection
          index={loadingQuery<readonly RequirementsIndexRow[]>()}
        />,
      ),
    ).toContain("sm:h-[5.05rem]");
  });
});

describe("RequirementsSection heading", () => {
  test("leaves out the count that repeats the tab name", () => {
    expect(
      renderToStaticMarkup(<RequirementsSection index={freshQuery(NO_ROWS)} />),
    ).not.toContain("要件定義がある作業項目");
  });

  test("leaves out the lead sentence while the rows load", () => {
    expect(
      renderToStaticMarkup(
        <RequirementsSection
          index={loadingQuery<readonly RequirementsIndexRow[]>()}
        />,
      ),
    ).not.toContain("要件定義がある作業項目");
  });
});
