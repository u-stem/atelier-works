import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import { freshQuery, staleQuery } from "../../api/fakeSectionQuery.ts";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { PipelineSection } from "./PipelineSection.tsx";

const NOTICE = "前回取得した値を表示しています";
const NO_ROWS: PipelineRow[] = [];

describe("PipelineSection", () => {
  test("says the rows are stale after a failed refetch", () => {
    const query = staleQuery(NO_ROWS, new ApiFailure({ kind: "network" }));
    expect(
      renderToStaticMarkup(<PipelineSection pipeline={query} />),
    ).toContain(NOTICE);
  });

  test("does not say the rows are stale for a 401", () => {
    const query = staleQuery(NO_ROWS, new ApiFailure({ kind: "unauthorized" }));
    expect(
      renderToStaticMarkup(<PipelineSection pipeline={query} />),
    ).not.toContain(NOTICE);
  });

  test("does not say the rows are stale without a failure", () => {
    expect(
      renderToStaticMarkup(<PipelineSection pipeline={freshQuery(NO_ROWS)} />),
    ).not.toContain(NOTICE);
  });
});
