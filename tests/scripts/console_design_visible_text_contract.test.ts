// 設計の承認画面が全文を描くときに、見えない文字を表記に置き換えることを、全コードポイントで確かめる。
// 期待する集合は、`visibleText`の述語ではなく、backendの`INVISIBLE_PATTERN`と`isAllowedCharacter`に、
// 空白の分類(Zs、Zl、Zp)と`\r`、私用領域、未割当、孤立サロゲートを足して作る。
// 漏れ(見えないのに素通り)と余計な置き換え(見えるのに表記)の両方を調べる。
// 固定の一覧では新しい分類の漏れに気づけないので、0からU+10FFFFまでをすべて調べる。
// `safeText`は通さない。通すと、U+2028などがU+FFFDに、`\r\n`が`\n`に変わり、実装に渡る文字と一致しない。

import { describe, expect, test } from "bun:test";
import {
  countDesignAnomalies,
  restoreText,
  visibleText,
} from "../../console/src/lib/visibleText.ts";
import {
  INVISIBLE_PATTERN,
  isAllowedCharacter,
  normalizeDesignForImplement,
} from "../../f/factory/lib/model_text.ts";

const MAX_CODE_POINT = 0x10ffff;

/** 表記の対象に足す分類。U+0020は素通りなので、判定で除く。 */
const EXTRA_NOTATION = /^[\p{Zs}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]$/u;

/** 強い右から左の文字として数える範囲(UAX#9の既定のRとALの範囲)。 */
const STRONG_RTL_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x10800, 0x10fff],
  [0x1e800, 0x1efff],
];

function codePointString(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

function expectedNotated(char: string): boolean {
  if (char === "\r") return true;
  if (INVISIBLE_PATTERN.test(char)) return true;
  if (!isAllowedCharacter(char)) return true;
  return char !== " " && EXTRA_NOTATION.test(char);
}

function expectedStrongRtl(codePoint: number): boolean {
  return STRONG_RTL_RANGES.some(
    ([from, to]) => codePoint >= from && codePoint <= to,
  );
}

function notatedSources(text: string): string[] {
  return visibleText(text).flatMap((segment) =>
    segment.kind === "code" ? [segment.source] : [],
  );
}

type Scan = {
  readonly missed: number[];
  readonly extra: number[];
  readonly wrongSource: number[];
  readonly wrongLabel: number[];
  readonly notRestored: number[];
  readonly notatedCount: number;
  readonly rtlMissed: number[];
  readonly rtlExtra: number[];
};

function hex(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

let cachedScan: Scan | null = null;

function scan(): Scan {
  if (cachedScan !== null) return cachedScan;
  const missed: number[] = [];
  const extra: number[] = [];
  const wrongSource: number[] = [];
  const wrongLabel: number[] = [];
  const notRestored: number[] = [];
  const rtlMissed: number[] = [];
  const rtlExtra: number[] = [];
  let notatedCount = 0;
  for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint += 1) {
    const char = codePointString(codePoint);
    const text = `a${char}b`;
    const segments = visibleText(text);
    const codes = segments.flatMap((segment) =>
      segment.kind === "code" ? [segment] : [],
    );
    const expected = expectedNotated(char);
    if (expected) notatedCount += 1;
    if (expected && codes.length !== 1) missed.push(codePoint);
    if (!expected && codes.length !== 0) extra.push(codePoint);
    const [only] = codes;
    if (expected && only !== undefined && only.source !== char) {
      wrongSource.push(codePoint);
    }
    if (expected && only !== undefined && only.label !== hex(codePoint)) {
      wrongLabel.push(codePoint);
    }
    if (restoreText(segments) !== text) notRestored.push(codePoint);
    const rtl = countDesignAnomalies(text).strongRtl;
    const wantsRtl = expectedStrongRtl(codePoint);
    if (wantsRtl && rtl !== 1) rtlMissed.push(codePoint);
    if (!wantsRtl && rtl !== 0) rtlExtra.push(codePoint);
  }
  cachedScan = {
    missed,
    extra,
    wrongSource,
    wrongLabel,
    notRestored,
    notatedCount,
    rtlMissed,
    rtlExtra,
  };
  return cachedScan;
}

describe("visibleText across all code points", () => {
  test("notates every character that is not visible", () => {
    expect(scan().missed.map(hex)).toEqual([]);
  });

  test("notates nothing that is visible", () => {
    expect(scan().extra.map(hex)).toEqual([]);
  });

  test("keeps the original character in every notation", () => {
    expect(scan().wrongSource.map(hex)).toEqual([]);
  });

  test("writes the code point in every notation", () => {
    expect(scan().wrongLabel.map(hex)).toEqual([]);
  });

  test("restores the original text for every code point", () => {
    expect(scan().notRestored.map(hex)).toEqual([]);
  });

  test("the scan sees notated characters at all", () => {
    expect(scan().notatedCount).toBeGreaterThan(100000);
  });
});

describe("strong right to left characters across all code points", () => {
  test("counts every character in the fixed ranges", () => {
    expect(scan().rtlMissed.map(hex)).toEqual([]);
  });

  test("counts nothing outside the fixed ranges", () => {
    expect(scan().rtlExtra.map(hex)).toEqual([]);
  });
});

/** 全コードポイントを、正規化に通して返す。区切りの"a"で、前後を分ける。 */
function normalizedAll(): string {
  const parts: string[] = [];
  for (let from = 0; from <= MAX_CODE_POINT; from += 4096) {
    const chunk: string[] = [];
    for (
      let codePoint = from;
      codePoint <= Math.min(from + 4095, MAX_CODE_POINT);
      codePoint += 1
    ) {
      chunk.push(`a${codePointString(codePoint)}b`);
    }
    parts.push(
      normalizeDesignForImplement(chunk.join("\n"), Number.MAX_SAFE_INTEGER)
        .text,
    );
  }
  return parts.join("\n");
}

let cachedNormalized: string | null = null;

function normalized(): string {
  if (cachedNormalized === null) cachedNormalized = normalizedAll();
  return cachedNormalized;
}

describe("the normalized design that the implementation receives", () => {
  test("notates exactly the characters that remain and need a notation", () => {
    const remaining = Array.from(normalized()).filter(expectedNotated);
    expect(notatedSources(normalized())).toEqual(remaining);
  });

  test("restores the normalized text from the segments", () => {
    expect(restoreText(visibleText(normalized()))).toBe(normalized());
  });

  test("keeps characters that the normalization does not remove and that need a notation", () => {
    expect(notatedSources(normalized()).length).toBeGreaterThan(1000);
  });

  test("keeps a carriage return apart from a newline", () => {
    const out = normalizeDesignForImplement("a\r\nb\nc", 8000).text;
    expect(
      visibleText(out).map((segment) => `${segment.kind}:${segment.source}`),
    ).toEqual([
      "plain:a",
      "code:\r",
      "line-break:\n",
      "plain:b",
      "line-break:\n",
      "plain:c",
    ]);
  });
});

describe("runs that push the text out of sight", () => {
  test("marks 401 lines of one space as one blank-run and restores them", () => {
    const text = `\n${" \n".repeat(400)}`;
    expect(
      visibleText(text).filter((segment) => segment.kind === "blank-run"),
    ).toHaveLength(1);
  });

  test("restores 401 lines of one space", () => {
    const text = `\n${" \n".repeat(400)}`;
    expect(restoreText(visibleText(text))).toBe(text);
  });

  test("counts 401 lines of one space as one anomaly", () => {
    expect(countDesignAnomalies(`\n${" \n".repeat(400)}`).blankRuns).toBe(1);
  });

  test("counts a run of lines that hold only a tab as one anomaly", () => {
    expect(countDesignAnomalies(`a\n${"\t\n".repeat(400)}b`).blankRuns).toBe(1);
  });

  test("restores a run of lines that hold only a tab", () => {
    const text = `a\n${"\t\n".repeat(400)}b`;
    expect(restoreText(visibleText(text))).toBe(text);
  });
});

describe("the normalized output of a design that hides text", () => {
  test("keeps the zero width space out of the output", () => {
    const out = normalizeDesignForImplement("a​b", 8000).text;
    expect(countDesignAnomalies(out).invisible).toBe(0);
  });

  test("keeps the hangul filler in the output and counts it", () => {
    const out = normalizeDesignForImplement("aㅤb", 8000).text;
    expect(countDesignAnomalies(out).invisible).toBe(1);
  });
});
