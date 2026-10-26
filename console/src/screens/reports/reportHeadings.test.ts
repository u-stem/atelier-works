import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** 見出しの要素の開始タグ(`id`で引く)。 */
function headingTag(file: string, id: string): string {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return new RegExp(`<h2[^>]*id="${id}"[^>]*>`, "s").exec(source)?.[0] ?? "";
}

// タブの名前と重なる見出しは、本体に置かない。読み上げの見出しの階層は残すので、視覚的にだけ隠す。
describe("the headings of the report tabs", () => {
  test("hides the heading of the audit reports from the screen", () => {
    expect(headingTag("./AuditReports.tsx", "audit-reports-heading")).toMatch(
      /className="[^"]*sr-only/,
    );
  });

  test("hides the heading of the analytics from the screen", () => {
    expect(headingTag("./AnalyticsReports.tsx", "analytics-heading")).toMatch(
      /className="[^"]*sr-only/,
    );
  });

  test("keeps the heading of the audit reports in the markup for the section label", () => {
    expect(headingTag("./AuditReports.tsx", "audit-reports-heading")).not.toBe(
      "",
    );
  });

  test("keeps the heading of the analytics in the markup for the section label", () => {
    expect(headingTag("./AnalyticsReports.tsx", "analytics-heading")).not.toBe(
      "",
    );
  });
});

// 見出しを隠すと、行に残る要素は期間のボタンだけになる。`justify-between`では左端に寄るので、右端に寄せる。
describe("the period buttons of the analytics", () => {
  test("stay at the right edge once the heading is hidden", () => {
    const source = readFileSync(
      new URL("./AnalyticsReports.tsx", import.meta.url),
      "utf8",
    );
    expect(/<div className="([^"]*)">\s*<fieldset/.exec(source)?.[1]).toContain(
      "ml-auto",
    );
  });
});
