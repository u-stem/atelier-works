import { describe, expect, test } from "bun:test";
import { findAncestor, isScrollingOverflow } from "./scrollRoot.ts";

interface Node {
  name: string;
  parentElement: Node | null;
}

function node(name: string, parentElement: Node | null): Node {
  return { name, parentElement };
}

describe("isScrollingOverflow", () => {
  test("accepts auto", () => {
    expect(isScrollingOverflow("auto")).toBe(true);
  });

  test("accepts scroll", () => {
    expect(isScrollingOverflow("scroll")).toBe(true);
  });

  test("rejects visible", () => {
    expect(isScrollingOverflow("visible")).toBe(false);
  });

  test("rejects hidden", () => {
    expect(isScrollingOverflow("hidden")).toBe(false);
  });
});

describe("findAncestor", () => {
  test("returns the nearest ancestor that matches", () => {
    const outer = node("scroll", null);
    const inner = node("scroll", outer);
    const start = node("start", node("plain", inner));

    const found = findAncestor(
      start,
      (candidate) => candidate.name === "scroll",
    );

    expect(found).toBe(inner);
  });

  test("does not test the start element", () => {
    const start = node("scroll", node("plain", null));

    const found = findAncestor(
      start,
      (candidate) => candidate.name === "scroll",
    );

    expect(found).toBeNull();
  });

  test("returns null when no ancestor matches", () => {
    const start = node("start", node("plain", null));

    const found = findAncestor(start, () => false);

    expect(found).toBeNull();
  });
});
