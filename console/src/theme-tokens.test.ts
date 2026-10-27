// index.cssの色のトークンが、WCAG AAの基準を保つことを確かめる。
// 文字は4.5:1以上、入力欄の境界は3.5:1以上、フォーカスの輪・図の線・点のような図形は3:1以上とする。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  contrastRatio,
  type LinearRgb,
  mixLinear,
  oklchToLinearRgb,
} from "./lib/contrast.ts";

const CSS = readFileSync(new URL("./index.css", import.meta.url), "utf8");

const TOKENS = new Map<string, readonly [string, string]>();
for (const match of CSS.matchAll(
  /--([a-z-]+):\s*light-dark\(\s*oklch\(([^)]*)\),\s*oklch\(([^)]*)\)\s*\)/g,
)) {
  const [, name, light, dark] = match;
  if (name !== undefined && light !== undefined && dark !== undefined) {
    TOKENS.set(name, [light, dark]);
  }
}

function color(name: string, scheme: 0 | 1): LinearRgb {
  const pair = TOKENS.get(name);
  if (pair === undefined) {
    throw new Error(`token --${name} is not defined in index.css`);
  }
  return oklchToLinearRgb(pair[scheme]);
}

type Pair = {
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
  /** 背景に重ねる薄い色(バッジの背景)。 */
  readonly tint?: string;
  /** `tint`を重ねる割合。省略するとバッジの`BADGE_TINT`になる。 */
  readonly tintAmount?: number;
};

const TEXT_SURFACES = [
  "background",
  "card",
  "popover",
  "sidebar",
  "muted",
  "accent",
  "selected",
  "sidebar-accent",
] as const;
const MEANING_COLORS = [
  "approval",
  "destructive",
  "warning",
  "success",
] as const;
const MEANING_SURFACES = [
  "background",
  "card",
  "sidebar",
  "selected",
  "accent",
] as const;

/** 入力欄の境界の下限。WCAGの3:1に余裕を持たせる。 */
const INPUT_BORDER_MIN = 3.5;

const BADGE_TINT = 0.14;
const BANNER_TINT = 0.07;
/** `Badge`のmuted(`bg-foreground/10`)が背景に重ねる割合。 */
const MUTED_BADGE_TINT = 0.1;

const BADGE_SOURCE = readFileSync(
  new URL("./components/ui/badge.tsx", import.meta.url),
  "utf8",
);

const PAIRS: Pair[] = [
  ...TEXT_SURFACES.flatMap((bg): Pair[] => [
    { fg: "foreground", bg, min: 4.5 },
    { fg: "muted-foreground", bg, min: 4.5 },
    { fg: "subtle-foreground", bg, min: 4.5 },
  ]),
  { fg: "selected-foreground", bg: "selected", min: 4.5 },
  { fg: "primary-foreground", bg: "primary", min: 4.5 },
  ...(["background", "card", "sidebar", "selected"] as const).map(
    (bg): Pair => ({ fg: "primary", bg, min: 4.5 }),
  ),
  ...MEANING_COLORS.flatMap((fg): Pair[] => [
    ...MEANING_SURFACES.map((bg): Pair => ({ fg, bg, min: 4.5 })),
    { fg, bg: "card", min: 4.5, tint: fg },
    { fg, bg: "background", min: 4.5, tint: fg },
  ]),
  // 面の上に載せる、意味の色のバッジ(背景に意味の色を薄く重ねる)。
  ...MEANING_COLORS.flatMap((fg): Pair[] =>
    (["selected", "accent"] as const).map(
      (bg): Pair => ({ fg, bg, min: 4.5, tint: fg }),
    ),
  ),
  // 面の上に載せる、灰色のバッジ(背景に主の文字色を薄く重ねる)。
  ...(["background", "card", "selected", "accent"] as const).map(
    (bg): Pair => ({
      fg: "foreground",
      bg,
      min: 4.5,
      tint: "foreground",
      tintAmount: MUTED_BADGE_TINT,
    }),
  ),
  // AuthBannerの帯(warningを`BANNER_TINT`で重ねた面)の上の文字。
  ...(["foreground", "muted-foreground"] as const).map(
    (fg): Pair => ({
      fg,
      bg: "background",
      min: 4.5,
      tint: "warning",
      tintAmount: BANNER_TINT,
    }),
  ),
  { fg: "destructive-foreground", bg: "destructive", min: 4.5 },
  { fg: "warning-foreground", bg: "warning", min: 4.5 },
  { fg: "success-foreground", bg: "success", min: 4.5 },
  { fg: "input", bg: "background", min: INPUT_BORDER_MIN },
  { fg: "input", bg: "card", min: INPUT_BORDER_MIN },
  { fg: "input", bg: "popover", min: INPUT_BORDER_MIN },
  // 図の箱の線とスクロールバーの色。入力欄の枠とは別に、元の値を保つ。
  { fg: "edge", bg: "background", min: 3 },
  { fg: "edge", bg: "card", min: 3 },
  { fg: "ring", bg: "background", min: 3 },
  { fg: "ring", bg: "card", min: 3 },
  { fg: "ring", bg: "sidebar", min: 3 },
  { fg: "primary", bg: "sidebar", min: 3 },
  // 選択中の切り替え(期間、種類、テーマ)の枠線は、トラック(muted)の上に載る。
  // 選択中の面(selected)はトラックとの明るさの差が小さいので、藍の枠線が未選択との違いを担う。
  // 面(card、selected)の上は、上の4.5の検査に含まれる。
  { fg: "primary", bg: "muted", min: 3 },
  ...MEANING_SURFACES.map((bg): Pair => ({ fg: "notice-mark", bg, min: 3 })),
];

// 「X-foreground」は、対になる「X」の面に載せる文字色である。
// PAIRSへの書き漏らしを防ぐため、定義されたすべての組を検査する。
const FOREGROUND_PAIRS: Pair[] = [...TOKENS.keys()].flatMap((name): Pair[] => {
  const base = name.slice(0, -"-foreground".length);
  return name.endsWith("-foreground") && TOKENS.has(base)
    ? [{ fg: name, bg: base, min: 4.5 }]
    : [];
});

describe("theme tokens", () => {
  test("keeps the muted badge background at the tint the pairs assume", () => {
    expect(BADGE_SOURCE).toContain(
      'muted: "border-transparent bg-foreground/10 text-foreground"',
    );
  });

  test("the input border is at least 3.5:1 in both themes", () => {
    const ratios = ([0, 1] as const).flatMap((slot) =>
      (["background", "card", "popover"] as const).map((surface) =>
        contrastRatio(color("input", slot), color(surface, slot)),
      ),
    );
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(3.5);
  });

  test("defines the tokens that the pairs use", () => {
    expect(TOKENS.size).toBeGreaterThan(30);
  });

  test("finds the foreground pairs in index.css", () => {
    expect(FOREGROUND_PAIRS.length).toBeGreaterThanOrEqual(10);
  });

  for (const [scheme, slot] of [
    ["light", 0],
    ["dark", 1],
  ] as const) {
    describe(`${scheme} foreground pairs`, () => {
      test.each(FOREGROUND_PAIRS)("$fg on $bg keeps its contrast", (pair) => {
        expect(
          contrastRatio(color(pair.fg, slot), color(pair.bg, slot)),
        ).toBeGreaterThanOrEqual(pair.min);
      });
    });
  }

  for (const [index, scheme] of (["light", "dark"] as const).entries()) {
    const slot = index === 0 ? 0 : 1;
    describe(scheme, () => {
      test.each(PAIRS)("$fg on $bg (tint $tint) keeps its contrast", (pair) => {
        const base = color(pair.bg, slot);
        const background =
          pair.tint === undefined
            ? base
            : mixLinear(
                base,
                color(pair.tint, slot),
                pair.tintAmount ?? BADGE_TINT,
              );
        expect(
          contrastRatio(color(pair.fg, slot), background),
        ).toBeGreaterThanOrEqual(pair.min);
      });
    });
  }
});
