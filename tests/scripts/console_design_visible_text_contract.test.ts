// 設計の承認画面が全文を描くときに、見えない文字を表記に置き換えることを、全コードポイントで確かめる。
// 期待する集合は、`visibleText`の述語ではなく、backendの`INVISIBLE_PATTERN`と`isAllowedCharacter`に、
// 空白の分類(Zs、Zl、Zp)と`\r`、私用領域、未割当、孤立サロゲートを足して作る。
// 漏れ(見えないのに素通り)と余計な置き換え(見えるのに表記)の両方を調べる。
// 固定の一覧では新しい分類の漏れに気づけないので、0からU+10FFFFまでをすべて調べる。
// `safeText`は通さない。通すと、U+2028などがU+FFFDに、`\r\n`が`\n`に変わり、実装に渡る文字と一致しない。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  countDesignAnomalies,
  designApprovalBlock,
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

/** 表記にしても、単独では件数に数えない空白。U+0020は表記にしない。 */
const SPACE_SEPARATOR = /^\p{Zs}$/u;

/**
 * 右から左へ書く文字体系の、文字・数字・句読点・記号(`\p{L}\p{N}\p{P}\p{S}`)。
 * `visibleText`の範囲の表とは別に、Unicodeの文字体系から作る。
 * 数える側に1つも漏れないことを、表の写しでなく、この集合で確かめる。
 * 結合文字や書式文字などは、表記の分類が数えるので、ここに含めない。
 */
const RTL_SCRIPT_CHARACTER =
  /^(?=[\p{L}\p{N}\p{P}\p{S}])[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]$/u;

/** 左から右へ書く、広く使われる文字体系の文字・数字・句読点・記号。数えてはならない。 */
const LTR_SCRIPT_CHARACTER =
  /^(?=[\p{L}\p{N}\p{P}\p{S}])[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u;

/** 濁点と半濁点(NFDの形)。 */
const KANA_SOUND_MARKS = ["\u3099", "\u309A"];

function codePointString(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

function expectedNotated(char: string): boolean {
  if (char === "\r") return true;
  if (INVISIBLE_PATTERN.test(char)) return true;
  if (!isAllowedCharacter(char)) return true;
  return char !== " " && EXTRA_NOTATION.test(char);
}

/**
 * 件数に数えるか。表記になる文字のうち、U+0020以外の空白は、単独では数えない。
 * 基底がラテン文字の`a`なので、濁点と半濁点も数える。
 */
function expectedInvisible(char: string): boolean {
  return expectedNotated(char) && !SPACE_SEPARATOR.test(char);
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
  readonly rtlOnLtrCharacter: number[];
  readonly invisibleWrong: number[];
  readonly kanaSoundMarkCounted: number[];
  readonly kanaOtherMarkNotCounted: number[];
  readonly rtlScriptCount: number;
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
  const rtlOnLtrCharacter: number[] = [];
  const invisibleWrong: number[] = [];
  const kanaSoundMarkCounted: number[] = [];
  const kanaOtherMarkNotCounted: number[] = [];
  let rtlScriptCount = 0;
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
    const anomalies = countDesignAnomalies(text);
    const rtl = anomalies.strongRtl;
    if (RTL_SCRIPT_CHARACTER.test(char)) {
      rtlScriptCount += 1;
      if (rtl !== 1) rtlMissed.push(codePoint);
    }
    if (LTR_SCRIPT_CHARACTER.test(char) && rtl !== 0) {
      rtlOnLtrCharacter.push(codePoint);
    }
    if (anomalies.invisible !== (expectedInvisible(char) ? 1 : 0)) {
      invisibleWrong.push(codePoint);
    }
    if (KANA.test(char)) {
      for (const mark of KANA_SOUND_MARKS) {
        if (countDesignAnomalies(`${char}${mark}`).invisible !== 0) {
          kanaSoundMarkCounted.push(codePoint);
        }
      }
    }
    if (
      countDesignAnomalies(`か${char}b`).invisible !==
      (expectedInvisible(char) && !KANA_SOUND_MARKS.includes(char) ? 1 : 0)
    ) {
      kanaOtherMarkNotCounted.push(codePoint);
    }
  }
  cachedScan = {
    missed,
    extra,
    wrongSource,
    wrongLabel,
    notRestored,
    notatedCount,
    rtlMissed,
    rtlOnLtrCharacter,
    invisibleWrong,
    kanaSoundMarkCounted,
    kanaOtherMarkNotCounted,
    rtlScriptCount,
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

describe("invisible characters across all code points", () => {
  test("counts a notated character once and a spacing separator not at all", () => {
    expect(scan().invisibleWrong.map(hex)).toEqual([]);
  });

  test("does not count a sound mark that follows any kana", () => {
    expect(scan().kanaSoundMarkCounted.map(hex)).toEqual([]);
  });

  test("counts every notated character after a kana except a sound mark", () => {
    expect(scan().kanaOtherMarkNotCounted.map(hex)).toEqual([]);
  });
});

describe("strong right to left characters across all code points", () => {
  test("counts every character of the right to left scripts", () => {
    expect(scan().rtlMissed.map(hex)).toEqual([]);
  });

  test("the scan sees the characters of the right to left scripts at all", () => {
    expect(scan().rtlScriptCount).toBeGreaterThan(1000);
  });

  test("counts no character of a left to right script", () => {
    expect(scan().rtlOnLtrCharacter.map(hex)).toEqual([]);
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

const TEMPLATE_PATH = resolve(
  import.meta.dir,
  "../../.claude/skills/factory-design/template.md",
);

/** 設計書の本文を、承認を送れる状態の画面に渡したときの、承認を止める理由。 */
function blockOf(text: string): string | null {
  return designApprovalBlock({
    approvalRequestId: 1,
    snapshot: "ready",
    doc: {
      isPending: false,
      isError: false,
      data: {
        approval_request_id: 1,
        text,
        truncated: false,
        approval_status: "pending",
      },
    },
    workItemStatus: "awaiting_design_approval",
  });
}

describe("the design template that the design stage fills in", () => {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const titled = template.replace("<Issueタイトル>", "画面　設計");

  test("is not stopped as it is", () => {
    expect(
      blockOf(normalizeDesignForImplement(template, 8000).text),
    ).toBeNull();
  });

  test("is not stopped when the title holds an ideographic space", () => {
    expect(blockOf(normalizeDesignForImplement(titled, 8000).text)).toBeNull();
  });

  test("really holds the ideographic space in the title it checks", () => {
    expect(normalizeDesignForImplement(titled, 8000).text).toContain("　");
  });
});
