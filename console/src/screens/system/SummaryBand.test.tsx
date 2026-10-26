import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import type { BandLevel, BandRow } from "../../lib/summaryBand.ts";
import { SummaryBand } from "./SummaryBand.tsx";

const NOW = Date.parse("2026-10-26T03:00:00.000Z");
const FETCHED = Date.parse("2026-10-26T02:57:00.000Z");

function row(
  id: BandRow["id"],
  level: BandLevel,
  overrides: Partial<BandRow> = {},
): BandRow {
  return {
    id,
    label: `ラベル ${id}`,
    level,
    text: `結論 ${id}`,
    count: null,
    note: null,
    tab: "status",
    targetId: `${id}-heading`,
    updatedAt: FETCHED,
    ...overrides,
  };
}

function render(rows: BandRow[]): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SummaryBand rows={rows} now={NOW} onJump={() => undefined} />
    </TooltipProvider>,
  );
}

describe("SummaryBand", () => {
  test("is a navigation landmark named by its heading", () => {
    expect(render([row("holds", "normal")])).toMatch(
      /<nav[^>]*aria-labelledby="summary-band-heading"/,
    );
  });

  test("has a heading of the second level", () => {
    expect(render([row("holds", "normal")])).toMatch(
      /<h2 id="summary-band-heading"[^>]*>要約/,
    );
  });

  test("lists one item for each row", () => {
    expect(
      render([row("holds", "normal"), row("audit", "caution")]).match(
        /<li[ >]/g,
      ),
    ).toHaveLength(2);
  });

  test("links each row to its tab", () => {
    expect(render([row("audit", "caution", { tab: "failures" })])).toContain(
      'href="?tab=failures"',
    );
  });

  test("shows the label of the row inside the link", () => {
    expect(render([row("holds", "normal")])).toMatch(
      /<a [^>]*>ラベル holds<\/a>/,
    );
  });

  test("shows the conclusion of the row", () => {
    expect(render([row("holds", "normal")])).toContain("結論 holds");
  });

  test("shows the count of failures in words, never hiding them", () => {
    expect(
      render([
        row("audit", "caution", {
          text: "未解決の失敗が2件あります",
          tab: "failures",
        }),
      ]),
    ).toContain("未解決の失敗が2件あります");
  });

  test.each([
    ["normal", "正常"],
    ["caution", "注意"],
    ["action", "要対応"],
    ["none", "判定なし"],
  ] as const)("names the level %s in words", (level, label) => {
    expect(render([row("holds", level)])).toContain(label);
  });

  test.each(["normal", "caution", "action", "none"] as const)(
    "draws a symbol for the level %s that screen readers skip",
    (level) => {
      expect(render([row("holds", level)])).toMatch(
        /<svg[^>]*aria-hidden="true"/,
      );
    },
  );

  test("colors an action row as a failure", () => {
    expect(render([row("holds", "action")])).toContain("text-failure");
  });

  test("colors a caution row as a warning", () => {
    expect(render([row("holds", "caution")])).toContain("text-warning");
  });

  test("colors a normal row as a success", () => {
    expect(render([row("holds", "normal")])).toContain("text-success");
  });

  test("shows when the row was fetched", () => {
    expect(render([row("holds", "normal")])).toMatch(/<time[^>]*>取得 3分前/);
  });

  test("says so when the row has not been fetched", () => {
    expect(render([row("holds", "none", { updatedAt: 0 })])).toContain(
      "未取得",
    );
  });

  test("shows the note of a row", () => {
    expect(
      render([row("orphan", "none", { note: "200件に達したので" })]),
    ).toContain("200件に達したので");
  });

  test("shows no note without one", () => {
    expect(render([row("orphan", "none")])).not.toContain("200件");
  });

  test("lists the sections that have no row as links", () => {
    expect(render([row("holds", "normal")])).toContain("更新履歴");
  });

  test("links the other sections to the history tab", () => {
    expect(render([row("holds", "normal")])).toContain('href="?tab=history"');
  });

  test("names the list of other sections", () => {
    expect(render([row("holds", "normal")])).toContain("ほかの節");
  });
});
