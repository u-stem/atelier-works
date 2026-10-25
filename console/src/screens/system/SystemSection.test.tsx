import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import {
  freshQuery,
  loadingQuery,
  staleQuery,
} from "../../api/fakeSectionQuery.testing.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { SYSTEM_SKELETONS, SystemSection } from "./SystemSection.tsx";

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

describe("SystemSection while loading", () => {
  test("shows only the frame in the first moment", () => {
    expect(render(loadingQuery<string>())).not.toContain("読み込み中");
  });
});

function sectionIdsIn(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return [...source.matchAll(/id="([a-z-]+-heading)"/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe("SYSTEM_SKELETONS", () => {
  const ids = [
    ...sectionIdsIn("./SystemScreen.tsx"),
    ...sectionIdsIn("./HoldsSection.tsx"),
  ];

  test("finds the sections of the screen", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  test.each(ids)("gives %s a frame sized to its content", (id) => {
    expect(SYSTEM_SKELETONS[id]).toBeDefined();
  });

  test("sizes the worker load card to its eight rows", () => {
    expect(SYSTEM_SKELETONS["worker-load-heading"]?.rowClassName).toContain(
      "h-[25rem]",
    );
  });
});
