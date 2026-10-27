// 角丸、影、文字の大きさがindex.cssのトークンだけで決まることを確かめる。
// 値の組み合わせの良し悪しは、実機で見て決める。ここでは、トークンの定義と、トークンを迂回する書き方が無いことを見る。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = new URL(".", import.meta.url).pathname;
const CSS = readFileSync(join(SRC_DIR, "index.css"), "utf8");

/**
 * 文字の大きさを画面の単位(px、rem)で直書きしてよいソース。
 * 図は、箱の幅や文字の幅の見積もりを、描く文字の大きさの数値から計算する。
 * 大きさをトークンに替えると、見積もりが実物とずれて文字が箱をはみ出す。
 */
const SIZED_BY_GEOMETRY = ["screens/jobs/FlowGraphDiagram.tsx"];

/** テストを除くソースのパスと中身。 */
function sources(): { path: string; text: string }[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path))
    .map((path) => ({
      path,
      text: readFileSync(join(SRC_DIR, path), "utf8"),
    }));
}

/** `--name: 値;`の値。無ければ空文字。 */
function tokenValue(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(CSS);
  return (match?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/** 文字列リテラルの中身。classの並びはここに書かれる。 */
function literalsOf(text: string): string[] {
  return [...text.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
}

describe("radius tokens", () => {
  test.each(["sm", "md", "lg", "xl", "2xl"])(
    "index.css defines --radius-%s",
    (step) => {
      expect(tokenValue(`--radius-${step}`)).toMatch(/^[0-9.]+rem$/);
    },
  );

  test("the steps grow from sm to 2xl", () => {
    const rems = ["sm", "md", "lg", "xl", "2xl"].map((step) =>
      Number.parseFloat(tokenValue(`--radius-${step}`)),
    );
    expect(rems).toEqual([...rems].sort((a, b) => a - b));
  });
});

describe("shadow tokens", () => {
  test.each(["sm", "md", "raised"])("index.css defines --shadow-%s", (step) => {
    expect(tokenValue(`--shadow-${step}`)).not.toBe("");
  });

  test.each(["sm", "md", "raised"])(
    "--shadow-%s draws its color from --shadow-color",
    (step) => {
      expect(tokenValue(`--shadow-${step}`)).not.toMatch(/#|rgb|oklch|black/);
    },
  );
});

describe("shape classes", () => {
  test("no source writes a radius or a shadow outside the tokens", () => {
    const offenders = sources()
      .filter((file) =>
        literalsOf(file.text).some(
          (literal) =>
            /(^|[\s:])(rounded|shadow)(-[a-z0-9]+)*-\[/.test(literal) ||
            /(^|[\s:])(rounded|shadow)(\s|$)/.test(literal),
        ),
      )
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});

describe("font sizes", () => {
  test("no raw text size outside the tokens", () => {
    const raw =
      /(^|[^\w-])text-(xs|sm|base|lg|xl|[2-9]xl|\[[0-9.]+(px|rem)\])(?![\w-])/;
    const offenders = sources()
      .filter((file) => !SIZED_BY_GEOMETRY.includes(file.path))
      .filter((file) => raw.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
