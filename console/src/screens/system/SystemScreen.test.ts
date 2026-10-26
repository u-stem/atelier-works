import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
  new URL("./SystemScreen.tsx", import.meta.url),
  "utf8",
);

/** 画面の関数の本体。 */
const BODY = SOURCE.slice(SOURCE.indexOf("export function SystemScreen"));

describe("the order of the fetches", () => {
  test("starts the holds first, since it is the cheapest to read", () => {
    expect(BODY.indexOf("useHolds()")).toBeLessThan(
      BODY.indexOf("useSystemStatus()"),
    );
  });

  test("starts the status before the summary", () => {
    expect(BODY.indexOf("useSystemStatus()")).toBeLessThan(
      BODY.indexOf("useSummary()"),
    );
  });

  test("starts the update history last, which is the heaviest", () => {
    expect(BODY.indexOf("useSummary()")).toBeLessThan(
      BODY.indexOf("useDeployments()"),
    );
  });
});

describe("the place of the band and the tabs", () => {
  test("puts them inside the scroll frame, not before it", () => {
    expect(BODY.indexOf("STICKY_HEADER_CLASS")).toBeGreaterThan(
      BODY.indexOf("className={SCROLL_BODY_CLASS}"),
    );
  });

  test("pins them with the shared class", () => {
    expect(BODY).toMatch(
      /<div\s+\{\.\.\.STICKY_HEADER_PROPS\}\s+className=\{STICKY_HEADER_CLASS\}/,
    );
  });

  test("puts the band and the tabs in the pinned block, before the panels", () => {
    expect(BODY.indexOf("<SummaryBand")).toBeLessThan(
      BODY.indexOf("<TabPanel"),
    );
  });

  test("does not swap the parent by a media query in script", () => {
    expect(SOURCE).not.toContain("useMediaQuery");
  });

  test("gives the band no time of fetch, which the page header shows", () => {
    expect(BODY).not.toContain("updatedAt");
  });
});

describe("the jump from a chip", () => {
  test("runs the jump only after the tab to land on is shown", () => {
    expect(BODY).toMatch(
      /shouldRunJump\(jump, tab\)\) \{\s*jumpToSection\(jump\.id\);/,
    );
  });

  test("switches the tab first when the target is on another tab", () => {
    expect(BODY).toMatch(/needsTabSwitch\(target, tab\)/);
  });

  test("clears the pending jump once it ran", () => {
    expect(BODY).toMatch(/jumpToSection\(jump\.id\);\s*setJump\(null\);/);
  });
});

describe("the host action of the release section", () => {
  test("counts it from the unresolved notices of the summary", () => {
    expect(BODY).toMatch(/<ReleaseSection[^>]*summary=\{summary\}/s);
  });
});

describe("the config tab", () => {
  test("reads the config only after the tab was opened", () => {
    expect(BODY).toMatch(/useConfig\([^)]*visited\.has\("config"\)/);
  });

  test("puts the config in its own panel", () => {
    expect(BODY).toContain('systemPanelAttrs("config", tab)');
  });

  test("draws the config section", () => {
    expect(BODY).toContain("<ConfigSection");
  });

  test("starts the config after the four fetches of the other tabs", () => {
    expect(BODY.indexOf("useDeployments()")).toBeLessThan(
      BODY.indexOf("useConfig("),
    );
  });
});

describe("the worker load note", () => {
  test("says the list of workers cannot be read here and a stop is notified", () => {
    expect(SOURCE).toContain(
      "workerの一覧は、ここでは読めません。止まったときは通知で知らせます。",
    );
  });
});
