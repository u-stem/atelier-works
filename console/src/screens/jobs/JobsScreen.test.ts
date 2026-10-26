import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
  new URL("./JobsScreen.tsx", import.meta.url),
  "utf8",
);
const BODY = SOURCE.slice(SOURCE.indexOf("export function JobsScreen"));

describe("the fetches of the job list screen", () => {
  test("fetches a tab only after it was opened", () => {
    expect(BODY).toContain("useVisitedTabs(tab)");
  });

  test("never refetches by itself", () => {
    expect(SOURCE).not.toMatch(/refetchInterval: (?!false)/);
  });

  test("refreshes only the tab that is open", () => {
    expect(BODY).toMatch(/tab === "history"/);
  });

  test("reads the holds without polling, for the freezes of the schedules", () => {
    expect(BODY).toContain("refetchInterval: false");
  });

  test("keeps the open tab and the filters in the URL", () => {
    expect(BODY).toContain("useSearchParams()");
  });

  test("checks the script filter against the known scripts", () => {
    expect(BODY).toContain("parseHistoryScript(");
  });

  test("draws the three tabs in panels that stay mounted once opened", () => {
    expect(BODY.match(/<TabPanel/g)).toHaveLength(3);
  });
});
