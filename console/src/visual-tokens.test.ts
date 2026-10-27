// 角丸、影、文字の大きさ、枠の色がindex.cssのトークンだけで決まることを確かめる。
// 値の組み合わせの良し悪しは、実機で見て決める。ここでは、トークンの定義と、トークンを迂回する書き方が無いことを見る。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = new URL(".", import.meta.url).pathname;
const CSS = readFileSync(join(SRC_DIR, "index.css"), "utf8");

/**
 * SVGの`<text>`の文字の大きさを、画面の単位(px)で直書きしてよいソース。
 * 図は、箱の幅や文字の幅の見積もりを、描く文字の大きさの数値から計算する。
 * 大きさをトークンに替えると、見積もりが実物とずれて文字が箱をはみ出す。
 * 同じファイルのHTMLの部分は、対象に残す。
 */
const SVG_TEXT_SIZED_BY_GEOMETRY = ["screens/jobs/FlowGraphDiagram.tsx"];

/** 入力欄の枠の色(`--input`)を使ってよいソース。 */
const INPUT_BORDER_USERS = [
  "components/ui/input.tsx",
  "components/ui/select.tsx",
  "components/ui/textarea.tsx",
];

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

const RAW_TEXT_SIZE =
  /(^|[^\w-])text-(xs|sm|base|lg|xl|[2-9]xl|\[[0-9.]+(px|rem)\])(?![\w-])/;

/** SVGの`<text>`の開始タグを除いたソース。 */
function withoutSvgTextTags(text: string): string {
  return text.replace(/<text\b[^>]*>/g, "");
}

describe("withoutSvgTextTags", () => {
  test("drops the size written on an SVG text element", () => {
    expect(
      RAW_TEXT_SIZE.test(
        withoutSvgTextTags(
          '<text className="fill-subtle text-[10px]">a</text>',
        ),
      ),
    ).toBe(false);
  });

  test("keeps the size written on an HTML element", () => {
    expect(
      RAW_TEXT_SIZE.test(
        withoutSvgTextTags(
          '<text className="text-caption">a</text><p className="text-[11px]">b</p>',
        ),
      ),
    ).toBe(true);
  });
});

describe("radius tokens", () => {
  test.each([
    ["sm", "0.25rem"],
    ["md", "0.375rem"],
    ["lg", "0.5rem"],
    ["xl", "0.75rem"],
    ["2xl", "1rem"],
  ])("index.css defines --radius-%s as %s", (step, value) => {
    expect(tokenValue(`--radius-${step}`)).toBe(value);
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

  test("no source uses a step that the theme does not define", () => {
    const undefinedStep =
      /(^|[\s:])(shadow-(2xs|xs|lg|xl|2xl)|rounded-(xs|3xl|4xl))(\s|$)/;
    const offenders = sources()
      .filter((file) =>
        literalsOf(file.text).some((literal) => undefinedStep.test(literal)),
      )
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});

describe("border colors", () => {
  test("only the form fields use the input border color", () => {
    const offenders = sources()
      .filter((file) => !INPUT_BORDER_USERS.includes(file.path))
      .filter((file) =>
        literalsOf(file.text).some((literal) =>
          /(^|[\s:])[a-z-]+-input(\s|$)/.test(literal),
        ),
      )
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("the scrollbar reads the edge color", () => {
    expect(CSS).toContain("scrollbar-color: var(--edge) transparent");
  });

  test("the edge color is exposed as a utility", () => {
    expect(tokenValue("--color-edge")).toBe("var(--edge)");
  });
});

describe("font sizes", () => {
  test("no raw text size outside the tokens", () => {
    const offenders = sources()
      .filter((file) =>
        RAW_TEXT_SIZE.test(
          SVG_TEXT_SIZED_BY_GEOMETRY.includes(file.path)
            ? withoutSvgTextTags(file.text)
            : file.text,
        ),
      )
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
