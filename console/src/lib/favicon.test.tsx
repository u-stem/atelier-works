import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandMark } from "../components/BrandMark.tsx";
import { oklchToLinearRgb } from "./contrast.ts";
import { faviconHref, type IconLink, installFaviconIn } from "./favicon.ts";

const CSS = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const MAIN = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const DATA_PREFIX = "data:image/svg+xml,";

/** 文書の代わりに、足された`<link>`を集める。 */
function installed(): IconLink[] {
  const appended: IconLink[] = [];
  installFaviconIn({
    createElement: () => ({ rel: "", type: "", href: "" }),
    head: {
      append: (link) => {
        appended.push(link);
      },
    },
  });
  return appended;
}

/** `index.css`の`--name`のライトの色を、`#rrggbb`にする。 */
function lightHex(name: string): string {
  const light = new RegExp(
    `--${name}:\\s*light-dark\\(\\s*oklch\\(([^)]*)\\)`,
  ).exec(CSS)?.[1];
  return `#${oklchToLinearRgb(light ?? "")
    .map(channelHex)
    .join("")}`;
}

function decodedSvg(): string {
  return decodeURIComponent(faviconHref().slice(DATA_PREFIX.length));
}

/** 図形の要素ごとに、位置と大きさの属性だけを取り出す。色と透明度は除く。 */
function geometryOf(svg: string): string[] {
  return [...svg.matchAll(/<(rect|circle)\b([^>]*)>/g)].map((element) => {
    const attributes = [...(element[2] ?? "").matchAll(/\b([a-z]+)="([^"]*)"/g)]
      .filter(([, name]) =>
        ["x", "y", "width", "height", "rx", "cx", "cy", "r"].includes(
          name ?? "",
        ),
      )
      .map(([, name, value]) => `${name}=${value}`);
    return `${element[1]} ${attributes.join(" ")}`;
  });
}

/** sRGBの0〜1を、2桁の16進にする。 */
function channelHex(linear: number): string {
  const encoded =
    linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255)
    .toString(16)
    .padStart(2, "0");
}

describe("favicon", () => {
  test("the head carries a data URI icon", () => {
    expect(installed()[0]?.href.startsWith(DATA_PREFIX)).toBe(true);
  });

  test("the link is an SVG icon", () => {
    expect(installed()[0]).toMatchObject({
      rel: "icon",
      type: "image/svg+xml",
    });
  });

  test("adds exactly one link", () => {
    expect(installed()).toHaveLength(1);
  });

  test("the SVG draws the same shapes as BrandMark", () => {
    expect(geometryOf(decodedSvg())).toEqual(
      geometryOf(renderToStaticMarkup(<BrandMark />)),
    );
  });

  test("the SVG refers to no variable and no outside file", () => {
    const withoutNamespace = decodedSvg().replace(
      'xmlns="http://www.w3.org/2000/svg"',
      "",
    );
    expect(withoutNamespace).not.toMatch(/https?:|var\(|url\(|<image|<script/);
  });

  test("the tile is drawn in the light primary color", () => {
    expect(decodedSvg()).toContain(`fill="${lightHex("primary")}"`);
  });

  test("the bars and the dot are drawn in the light primary-foreground color", () => {
    expect(decodedSvg()).toContain(`fill="${lightHex("primary-foreground")}"`);
  });

  test("main.tsx installs the icon into the document", () => {
    expect(MAIN).toContain("installFaviconIn(document)");
  });
});
