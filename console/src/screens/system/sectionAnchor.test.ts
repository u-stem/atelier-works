import { describe, expect, test } from "bun:test";
import { sectionDomId } from "../../lib/systemSections.ts";
import {
  ANCHOR_FOCUS_CLASS,
  focusAttrs,
  highlightAttrs,
} from "./sectionAnchor.ts";

describe("focusAttrs", () => {
  test("gives the id that the arrival looks for", () => {
    expect(focusAttrs("holds").id).toBe(sectionDomId("holds"));
  });

  test("makes the element focusable by script, but not by the Tab key", () => {
    expect(focusAttrs("holds").tabIndex).toBe(-1);
  });
});

describe("highlightAttrs", () => {
  test("marks the element as an anchor", () => {
    expect(highlightAttrs("holds", null)["data-section-anchor"]).toBe("");
  });

  test("marks the highlighted section", () => {
    expect(highlightAttrs("holds", "holds")["data-highlighted"]).toBe("");
  });

  test("does not mark a section while another is highlighted", () => {
    expect(highlightAttrs("holds", "stop-all")["data-highlighted"]).toBe(
      undefined,
    );
  });

  test("does not mark a section while none is highlighted", () => {
    expect(highlightAttrs("holds", null)["data-highlighted"]).toBe(undefined);
  });
});

describe("ANCHOR_FOCUS_CLASS", () => {
  test("shows a ring only for a keyboard focus, as the headings do", () => {
    expect(ANCHOR_FOCUS_CLASS).toContain("focus-visible:ring-2");
  });

  test("hides the default outline", () => {
    expect(ANCHOR_FOCUS_CLASS).toContain("outline-none");
  });
});
