import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cn, FONT_SIZES } from "./cn.ts";

describe("cn", () => {
  test("joins class names and drops falsy values", () => {
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });

  test("lets the later tailwind utility win", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});

const CSS = readFileSync(new URL("../index.css", import.meta.url), "utf8");
// 行間の変数(`--text-body--line-height`)は、ハイフンが2つ続くので拾わない。
const FONT_SIZE_NAMES = [
  ...CSS.matchAll(/--text-([a-z0-9]+(?:-[a-z0-9]+)*):/g),
].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

describe("cn with the theme font sizes", () => {
  test("knows exactly the font sizes that index.css defines", () => {
    expect([...FONT_SIZES].sort()).toEqual([...FONT_SIZE_NAMES].sort());
  });

  test("reads at least one font size from index.css", () => {
    expect(FONT_SIZE_NAMES.length).toBeGreaterThan(0);
  });

  test.each(FONT_SIZE_NAMES)("keeps the text color after text-%s", (name) => {
    expect(cn(`text-${name}`, "text-primary-foreground")).toBe(
      `text-${name} text-primary-foreground`,
    );
  });

  test.each(FONT_SIZE_NAMES)("keeps text-%s after the text color", (name) => {
    expect(cn("text-primary-foreground", `text-${name}`)).toBe(
      `text-primary-foreground text-${name}`,
    );
  });

  test("lets a later font size replace an earlier one", () => {
    expect(cn("text-body", "text-small")).toBe("text-small");
  });

  test("lets a later text color replace an earlier one", () => {
    expect(cn("text-foreground", "text-subtle")).toBe("text-subtle");
  });
});
