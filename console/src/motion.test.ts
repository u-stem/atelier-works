// 動きの決まりを確かめる。長さとイージングはindex.cssのトークンで共有し、
// 動きを減らす設定は全要素の1つの規則が受ける。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRANSITION_COLORS,
  TRANSITION_TRANSFORM,
  TRANSITION_WIDTH,
} from "./lib/motionClasses.ts";

const SRC_DIR = new URL(".", import.meta.url).pathname;
const CSS = readFileSync(join(SRC_DIR, "index.css"), "utf8");

/** テストを除くソースのパスと中身。 */
function sources(): { path: string; text: string }[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path))
    .map((path) => ({
      path,
      text: readFileSync(join(SRC_DIR, path), "utf8"),
    }));
}

/** 動きを減らす設定の規則の中身。 */
function reducedMotionRule(): string {
  const start = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  if (start < 0) {
    throw new Error("no reduced motion rule in index.css");
  }
  return CSS.slice(start, CSS.indexOf("\n}\n", start));
}

describe("reduced motion", () => {
  test("no component sets motion-reduce or motion-safe", () => {
    const offenders = sources()
      .filter((file) => /motion-(reduce|safe):/.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("index.css applies the rule to every element and pseudo-element", () => {
    expect(reducedMotionRule()).toContain("*,\n  *::before,\n  *::after");
  });

  test.each([
    "transition-duration: 0.01ms !important",
    "transition-delay: 0s !important",
    "animation-duration: 0.01ms !important",
    "animation-delay: 0s !important",
    "animation-iteration-count: 1 !important",
    "scroll-behavior: auto !important",
  ])("index.css declares %s in the one rule", (declaration) => {
    expect(reducedMotionRule()).toContain(declaration);
  });
});

describe("motion tokens", () => {
  test.each(["--duration-fast", "--duration-moderate", "--ease-standard"])(
    "index.css defines %s",
    (name) => {
      expect(CSS).toMatch(new RegExp(`${name}:\\s*[^;]+;`));
    },
  );

  test("no source uses a raw duration", () => {
    const offenders = sources()
      .filter((file) => /(^|[\s"'`:])duration-\d/.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test.each([
    ["colors", TRANSITION_COLORS],
    ["transform", TRANSITION_TRANSFORM],
    ["width", TRANSITION_WIDTH],
  ])("the %s transition reads the duration and ease tokens", (_name, value) => {
    expect(value).toMatch(/duration-\(--duration-[a-z]+\) ease-standard$/);
  });
});
