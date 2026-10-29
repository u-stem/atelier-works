import { describe, expect, test } from "bun:test";
import {
  BLANK_RUN_MARK_PREFIX,
  blankRunMark,
  countDesignAnomalies,
  type DesignApprovalInput,
  designApprovalBlock,
  END_MARK_PREFIX,
  endMark,
  restoreText,
  SPACE_RUN_MARK_PREFIX,
  spaceRunMark,
  textStats,
  type VisibleSegment,
  visibleText,
} from "./visibleText.ts";

function kinds(text: string): string[] {
  return visibleText(text).map((segment) => segment.kind);
}

function codes(text: string): string[] {
  return visibleText(text).flatMap((segment) =>
    segment.kind === "code" ? [segment.label] : [],
  );
}

function blankRuns(text: string): VisibleSegment[] {
  return visibleText(text).filter((segment) => segment.kind === "blank-run");
}

function spaceRuns(text: string): VisibleSegment[] {
  return visibleText(text).filter((segment) => segment.kind === "space-run");
}

describe("visibleText passes printable characters through", () => {
  test("keeps ordinary text as one plain segment", () => {
    expect(visibleText("# Design\nbody")).toEqual([
      { kind: "plain", source: "# Design" },
      { kind: "line-break", source: "\n" },
      { kind: "plain", source: "body" },
    ]);
  });

  test("keeps Japanese text and U+0020 as plain", () => {
    expect(kinds("設計書 です")).toEqual(["plain"]);
  });

  test("keeps a tab at the start of a line as plain", () => {
    expect(kinds("\t設計書")).toEqual(["plain"]);
  });

  test("keeps a character outside the BMP as plain", () => {
    expect(kinds("a😀b")).toEqual(["plain"]);
  });

  test("returns no segment for an empty text", () => {
    expect(visibleText("")).toEqual([]);
  });

  test("keeps a newline as a line-break segment", () => {
    expect(kinds("a\nb")).toEqual(["plain", "line-break", "plain"]);
  });
});

describe("visibleText notates characters that are not visible", () => {
  test.each([
    ["line separator", " ", "U+2028"],
    ["paragraph separator", " ", "U+2029"],
    ["variation selector", "️", "U+FE0F"],
    ["variation selector supplement", "\u{E0100}", "U+E0100"],
    ["hangul filler", "ㅤ", "U+3164"],
    ["halfwidth hangul filler", "ﾠ", "U+FFA0"],
    ["hangul choseong filler", "ᅟ", "U+115F"],
    ["hangul jungseong filler", "ᅠ", "U+1160"],
    ["braille blank", "⠀", "U+2800"],
    ["combining mark", "́", "U+0301"],
    ["enclosing mark", "⃝", "U+20DD"],
    ["zero width space", "​", "U+200B"],
    ["right to left override", "‮", "U+202E"],
    ["right to left isolate", "⁧", "U+2067"],
    ["no-break space", " ", "U+00A0"],
    ["ideographic space", "　", "U+3000"],
    ["carriage return", "\r", "U+000D"],
    ["escape", "\u001B", "U+001B"],
    ["delete", "\u007F", "U+007F"],
    ["C1 control", "\u0085", "U+0085"],
    ["private use", "", "U+E000"],
    ["unassigned", "͸", "U+0378"],
    ["lone high surrogate", "\uD800", "U+D800"],
    ["lone low surrogate", "\uDFFF", "U+DFFF"],
    ["tag character", "\u{E0041}", "U+E0041"],
  ])("notates the %s", (_name, char, label) => {
    expect(codes(`a${char}b`)).toEqual([label]);
  });

  test("keeps the original character in the notation segment", () => {
    expect(visibleText(" ")).toEqual([
      { kind: "code", source: " ", label: "U+2028" },
    ]);
  });

  test("notates every character of a run of invisible characters", () => {
    expect(codes("a​​​b")).toEqual(["U+200B", "U+200B", "U+200B"]);
  });

  test("tells a carriage return from a newline", () => {
    expect(kinds("a\r\nb")).toEqual(["plain", "code", "line-break", "plain"]);
  });

  test("does not mistake a newline for a carriage return", () => {
    expect(kinds("a\nb")).not.toContain("code");
  });
});

describe("visibleText blank-run", () => {
  test("marks three consecutive empty lines", () => {
    expect(blankRuns("a\n\n\n\nb").map((segment) => segment.source)).toEqual([
      "\n\n\n",
    ]);
  });

  test("leaves two consecutive empty lines alone", () => {
    expect(blankRuns("a\n\n\nb")).toEqual([]);
  });

  test("counts a line of spaces and tabs as an empty line", () => {
    expect(blankRuns("a\n \n\t\n \t\nb")).toHaveLength(1);
  });

  test("keeps the spaces and tabs of every line in the run", () => {
    const [run] = blankRuns("a\n \n\t\n  \t\nb");
    expect(run?.kind === "blank-run" ? run.lines : null).toEqual([
      { spaces: 1, tabs: 0 },
      { spaces: 0, tabs: 1 },
      { spaces: 2, tabs: 1 },
    ]);
  });

  test("treats a run of 401 lines of whitespace as one run", () => {
    expect(blankRuns(`\n${" \n".repeat(400)}`)).toHaveLength(1);
  });

  test("marks a run of lines that hold only a tab", () => {
    expect(blankRuns(`a\n${"\t\n".repeat(5)}b`)).toHaveLength(1);
  });

  test("does not take a line with an invisible character as empty", () => {
    expect(blankRuns("a\n\n​\n\nb")).toEqual([]);
  });

  test("does not take a line with a carriage return as empty", () => {
    expect(blankRuns("a\n\r\n\r\n\r\nb")).toEqual([]);
  });

  test("counts a line of ideographic spaces as an empty line", () => {
    expect(blankRuns(`a\n${"\u3000\n".repeat(5)}b`)).toHaveLength(1);
  });

  test("restores a run of lines of ideographic spaces", () => {
    const text = `a\n${"\u3000\n".repeat(5)}b`;
    expect(restoreText(visibleText(text))).toBe(text);
  });

  test("marks a run at the start of the text", () => {
    expect(blankRuns("\n\n\nabc")).toHaveLength(1);
  });

  test("marks a run at the end of the text", () => {
    expect(blankRuns("abc\n\n\n\n")).toHaveLength(1);
  });

  test("restores the run with the line break before it", () => {
    expect(restoreText(visibleText("a\n\n\n\nb"))).toBe("a\n\n\n\nb");
  });

  test("marks two separate runs separately", () => {
    expect(blankRuns("a\n\n\n\nb\n\n\n\nc")).toHaveLength(2);
  });
});

describe("visibleText space-run", () => {
  test("marks eight spaces in the middle of a line", () => {
    expect(spaceRuns("a        b").map((segment) => segment.source)).toEqual([
      "        ",
    ]);
  });

  test("leaves seven spaces alone", () => {
    expect(spaceRuns("a       b")).toEqual([]);
  });

  test("counts tabs and spaces together", () => {
    expect(spaceRuns("a \t \t \t \tb")).toHaveLength(1);
  });

  test("leaves the indent at the start of a line alone", () => {
    expect(spaceRuns("a\n            b")).toEqual([]);
  });

  test("marks a long run at the end of a line", () => {
    expect(spaceRuns("a            \nb")).toHaveLength(1);
  });

  test("marks a run that follows a notated character", () => {
    expect(spaceRuns("\u200B        b")).toHaveLength(1);
  });

  test("counts a tab as eight columns in the middle of a line", () => {
    expect(spaceRuns("a\tb")).toHaveLength(1);
  });

  test("marks an indent of 32 spaces at the start of a line", () => {
    expect(spaceRuns(`a\n${" ".repeat(32)}b`)).toHaveLength(1);
  });

  test("leaves an indent of 31 spaces at the start of a line", () => {
    expect(spaceRuns(`a\n${" ".repeat(31)}b`)).toEqual([]);
  });

  test("marks an indent of four tabs at the start of a line", () => {
    expect(spaceRuns("a\n\t\t\t\tb")).toHaveLength(1);
  });

  test("leaves an indent of three tabs at the start of a line", () => {
    expect(spaceRuns("a\n\t\t\tb")).toEqual([]);
  });

  test("marks a run of seven tabs", () => {
    expect(spaceRuns(`a${"\t".repeat(7)}b`)).toHaveLength(1);
  });

  test("keeps one ideographic space as a notation", () => {
    expect(kinds("a\u3000b")).toEqual(["plain", "code", "plain"]);
  });

  test("marks two ideographic spaces in a row in the middle of a line", () => {
    expect(spaceRuns("a\u3000\u3000b")).toHaveLength(1);
  });

  test("marks two no-break spaces in a row in the middle of a line", () => {
    expect(spaceRuns("a\u00A0\u00A0b")).toHaveLength(1);
  });

  test("marks eight ideographic spaces", () => {
    expect(spaceRuns(`a${"\u3000".repeat(8)}b`)).toHaveLength(1);
  });

  test("marks a mix of an ideographic space and seven spaces", () => {
    expect(spaceRuns("a\u3000       b")).toHaveLength(1);
  });

  test("keeps two ideographic spaces of an indent as notations", () => {
    expect(spaceRuns("\u3000\u3000本文")).toEqual([]);
  });

  test("keeps an ideographic space between spaces as a notation", () => {
    expect(codes("a \u3000 b")).toEqual(["U+3000"]);
  });

  test("restores a run that mixes spaces, tabs and ideographic spaces", () => {
    const text = "a \u3000\t\u3000  b";
    expect(restoreText(visibleText(text))).toBe(text);
  });

  test("does not join runs across a line break", () => {
    expect(spaceRuns("a    \n    b")).toEqual([]);
  });

  test("keeps the text before and after the run as plain", () => {
    expect(kinds("a        b")).toEqual(["plain", "space-run", "plain"]);
  });
});

describe("restoreText", () => {
  const MIXED = [
    "# 設計\r\n",
    "本文 次️行ㅤ́\n",
    "\n\n\n\n",
    "表   |        | 値\t\n",
    "\uD800͸ 😀\n",
    "        ",
  ].join("");

  test("restores a text that mixes every kind of segment", () => {
    expect(restoreText(visibleText(MIXED))).toBe(MIXED);
  });

  test("restores a text with a carriage return and a newline apart", () => {
    expect(restoreText(visibleText("a\r\nb\nc\r"))).toBe("a\r\nb\nc\r");
  });

  test("restores an empty text", () => {
    expect(restoreText(visibleText(""))).toBe("");
  });
});

describe("countDesignAnomalies", () => {
  test("finds nothing in an ordinary Japanese design", () => {
    expect(
      countDesignAnomalies("# 設計\n\n本文です。\n\n| a | b |\n| - | - |\n")
        .total,
    ).toBe(0);
  });

  test("finds nothing in a code block that is indented", () => {
    expect(countDesignAnomalies("```\n        indented\n```\n").total).toBe(0);
  });

  test("counts invisible characters one by one", () => {
    expect(countDesignAnomalies("a​b c").invisible).toBe(2);
  });

  test("counts a right to left override as an invisible character", () => {
    expect(countDesignAnomalies("a‮b").invisible).toBe(1);
  });

  test("does not count one no-break space", () => {
    expect(countDesignAnomalies("a\u00A0b").total).toBe(0);
  });

  test("does not count one ideographic space", () => {
    expect(countDesignAnomalies("# 設計\u3000書\n").total).toBe(0);
  });

  test("counts two ideographic spaces in a row as a space run", () => {
    expect(countDesignAnomalies("a\u3000\u3000b").spaceRuns).toBe(1);
  });

  test("does not count two ideographic spaces as invisible characters", () => {
    expect(countDesignAnomalies("a\u3000\u3000b").invisible).toBe(0);
  });

  test("counts eight ideographic spaces as one space run", () => {
    expect(countDesignAnomalies(`a${"\u3000".repeat(8)}b`).spaceRuns).toBe(1);
  });

  test("counts a line separator as an invisible character", () => {
    expect(countDesignAnomalies("a\u2028b").invisible).toBe(1);
  });

  test("counts a carriage return as an invisible character", () => {
    expect(countDesignAnomalies("a\r\nb").invisible).toBe(1);
  });

  test("counts an indent of 32 spaces as a space run", () => {
    expect(countDesignAnomalies(`a\n${" ".repeat(32)}b`).spaceRuns).toBe(1);
  });

  test("counts repeated runs of seven tabs", () => {
    const text = `a${"\t".repeat(7)}b\n`.repeat(3);
    expect(countDesignAnomalies(text).spaceRuns).toBe(3);
  });

  test("counts a Hebrew letter as a strong right to left character", () => {
    expect(countDesignAnomalies("aאb").strongRtl).toBe(1);
  });

  test("counts an Arabic letter as a strong right to left character", () => {
    expect(countDesignAnomalies("aابb").strongRtl).toBe(2);
  });

  test("does not count an Arabic-Indic digit as a strong right to left character", () => {
    expect(countDesignAnomalies("a\u0660b").strongRtl).toBe(0);
  });

  test("does not count ornate parentheses in the right to left range", () => {
    expect(countDesignAnomalies("a\uFD3Eb").strongRtl).toBe(0);
  });

  test("counts an Arabic letter mark as an invisible character", () => {
    expect(countDesignAnomalies("a\u061Cb").invisible).toBe(1);
  });

  test("does not count an Arabic letter mark as a strong right to left character", () => {
    expect(countDesignAnomalies("a\u061Cb").strongRtl).toBe(0);
  });

  test("counts a character outside the BMP in the right to left range", () => {
    expect(countDesignAnomalies("a\u{10800}b").strongRtl).toBe(1);
  });

  test("does not count a Latin letter as right to left", () => {
    expect(countDesignAnomalies("abc").strongRtl).toBe(0);
  });

  test("counts a run of blank lines once", () => {
    expect(countDesignAnomalies("a\n \n\n\t\nb").blankRuns).toBe(1);
  });

  test("does not count two blank lines", () => {
    expect(countDesignAnomalies("a\n\n\nb").blankRuns).toBe(0);
  });

  test("counts a run of spaces in a line", () => {
    expect(countDesignAnomalies("a        b").spaceRuns).toBe(1);
  });

  test("does not count the end mark that the text writes itself", () => {
    expect(countDesignAnomalies(`a\n${endMark(3, 20)}\n`).markLookalikes).toBe(
      0,
    );
  });

  test("does not count a sentence that mentions the end mark", () => {
    expect(countDesignAnomalies("画面は全文の終わりの印を出す。").total).toBe(
      0,
    );
  });

  test("counts the blank-run mark that the text writes itself", () => {
    expect(countDesignAnomalies(blankRunMark(5)).markLookalikes).toBe(1);
  });

  test("counts the space-run mark that the text writes itself", () => {
    expect(countDesignAnomalies(spaceRunMark(9)).markLookalikes).toBe(1);
  });

  test("does not count the opening of a mark without a number", () => {
    expect(countDesignAnomalies("[空行").markLookalikes).toBe(0);
  });

  test("does not count a link whose text starts like a mark", () => {
    expect(countDesignAnomalies("[空白の扱い](docs/a.md)").total).toBe(0);
  });

  test("does not count a mark without its closing words", () => {
    expect(countDesignAnomalies("[空行 5]").markLookalikes).toBe(0);
  });

  test("counts a blank-run mark with full-width brackets", () => {
    expect(countDesignAnomalies("［空行 5 行］").markLookalikes).toBe(1);
  });

  test("counts a space-run mark with full-width digits", () => {
    expect(countDesignAnomalies("[空白 １２ 個]").markLookalikes).toBe(1);
  });

  test("counts a mark without spaces", () => {
    expect(countDesignAnomalies("[空行5行]").markLookalikes).toBe(1);
  });

  test("counts two marks in one text", () => {
    expect(
      countDesignAnomalies(`${blankRunMark(3)} ${spaceRunMark(9)}`)
        .markLookalikes,
    ).toBe(2);
  });

  test("adds every count into the total", () => {
    const text = `a\u200B\u05D0\n\n\n\nb        c ${blankRunMark(1)}`;
    expect(countDesignAnomalies(text).total).toBe(5);
  });
});

describe("countDesignAnomalies for combining marks", () => {
  test("does not count a voiced sound mark after a hiragana", () => {
    expect(countDesignAnomalies("か\u3099").total).toBe(0);
  });

  test("does not count a semi-voiced sound mark after a katakana", () => {
    expect(countDesignAnomalies("ハ\u309A").total).toBe(0);
  });

  test("keeps the voiced sound mark as a notation", () => {
    expect(codes("か\u3099")).toEqual(["U+3099"]);
  });

  test("does not count a decomposed Japanese sentence", () => {
    expect(countDesignAnomalies("設計か\u3099終わる。ハ\u309Aーツ").total).toBe(
      0,
    );
  });

  test("counts a combining mark at the start of the text", () => {
    expect(countDesignAnomalies("\u3099か").invisible).toBe(1);
  });

  test("counts a combining mark right after a newline", () => {
    expect(countDesignAnomalies("か\n\u3099か").invisible).toBe(1);
  });

  test("counts both marks of a run of two", () => {
    expect(countDesignAnomalies("か\u3099\u3099").invisible).toBe(2);
  });

  test("counts a combining mark after a Latin letter", () => {
    expect(countDesignAnomalies("e\u0301").invisible).toBe(1);
  });

  test("counts a voiced sound mark after a Latin letter", () => {
    expect(countDesignAnomalies("a\u3099").invisible).toBe(1);
  });

  test("counts a voiced sound mark after a kanji", () => {
    expect(countDesignAnomalies("漢\u3099").invisible).toBe(1);
  });

  test("does not count a single combining mark after a kanji", () => {
    expect(countDesignAnomalies("漢\u0301").invisible).toBe(0);
  });

  test("counts a combining mark after a space", () => {
    expect(countDesignAnomalies("か \u3099").invisible).toBe(1);
  });

  test("counts a variation selector after a kanji", () => {
    expect(countDesignAnomalies("漢\uFE0F").invisible).toBe(1);
  });

  test("counts an enclosing mark after a Latin letter", () => {
    expect(countDesignAnomalies("a\u20DD").invisible).toBe(1);
  });

  test("counts both a zero width space and the mark after it", () => {
    expect(countDesignAnomalies("か\u200B\u3099").invisible).toBe(2);
  });
});

describe("marks", () => {
  test("writes the blank-run mark with the line count", () => {
    expect(blankRunMark(5)).toBe("[空行 5 行]");
  });

  test("writes the space-run mark with the count", () => {
    expect(spaceRunMark(12)).toBe("[空白 12 個]");
  });

  test("writes the end mark with the line and code point counts", () => {
    expect(endMark(3, 20)).toBe("全文の終わり(3 行、20 コードポイント)");
  });

  test("starts the blank-run mark with its prefix", () => {
    expect(blankRunMark(5).startsWith(BLANK_RUN_MARK_PREFIX)).toBe(true);
  });

  test("starts the space-run mark with its prefix", () => {
    expect(spaceRunMark(5).startsWith(SPACE_RUN_MARK_PREFIX)).toBe(true);
  });

  test("starts the end mark with its prefix", () => {
    expect(endMark(1, 1).startsWith(END_MARK_PREFIX)).toBe(true);
  });

  test("keeps the three prefixes apart", () => {
    expect(
      new Set([BLANK_RUN_MARK_PREFIX, SPACE_RUN_MARK_PREFIX, END_MARK_PREFIX])
        .size,
    ).toBe(3);
  });
});

describe("textStats", () => {
  test("counts the lines of a text without a final newline", () => {
    expect(textStats("a\nb\nc").lines).toBe(3);
  });

  test("does not count the empty part after a final newline", () => {
    expect(textStats("a\nb\n").lines).toBe(2);
  });

  test("counts no line in an empty text", () => {
    expect(textStats("").lines).toBe(0);
  });

  test("counts code points, not UTF-16 units", () => {
    expect(textStats("a😀日").codePoints).toBe(3);
  });
});

const READY: DesignApprovalInput = {
  approvalRequestId: 31,
  snapshot: "ready",
  doc: {
    isPending: false,
    isError: false,
    data: {
      approval_request_id: 31,
      text: "# 設計\n\n本文です。\n",
      truncated: false,
      approval_status: "pending",
    },
  },
  workItemStatus: "awaiting_design_approval",
};

function withDoc(
  patch: Partial<NonNullable<DesignApprovalInput["doc"]["data"]>>,
): DesignApprovalInput {
  const data = READY.doc.data;
  return {
    ...READY,
    doc: {
      ...READY.doc,
      data: data === null || data === undefined ? data : { ...data, ...patch },
    },
  };
}

describe("designApprovalBlock", () => {
  test("lets a clean design through", () => {
    expect(designApprovalBlock(READY)).toBeNull();
  });

  test("stops while the intake issue is loading", () => {
    expect(designApprovalBlock({ ...READY, snapshot: "loading" })).toBe(
      "取り込み時点のIssueを読み込み中です。表示されるまで承認できません。",
    );
  });

  test("stops when the intake issue failed to load", () => {
    expect(designApprovalBlock({ ...READY, snapshot: "failed" })).toBe(
      "取り込み時点のIssueを取得できていません。取得し直して内容を確かめるまで承認できません。",
    );
  });

  test("stops when the work item has no intake issue", () => {
    expect(designApprovalBlock({ ...READY, snapshot: "empty" })).toBe(
      "この作業項目に、取り込み時点のIssueがありません。確かめる内容が無いため、承認できません。",
    );
  });

  test("stops while the design is loading", () => {
    expect(
      designApprovalBlock({
        ...READY,
        doc: { isPending: true, isError: false, data: undefined },
      }),
    ).toBe("設計書を読み込み中です。表示されるまで承認できません。");
  });

  test("stops when the design failed to load", () => {
    expect(
      designApprovalBlock({
        ...READY,
        doc: { isPending: false, isError: true, data: undefined },
      }),
    ).toBe(
      "設計書を取得できていません。取得し直して内容を確かめるまで承認できません。",
    );
  });

  test("stops when the design is not found", () => {
    expect(
      designApprovalBlock({
        ...READY,
        doc: { isPending: false, isError: false, data: null },
      }),
    ).toBe(
      "この依頼の設計書が見つかりません。内容を確かめられないため、承認できません。",
    );
  });

  test("stops when the design belongs to another request", () => {
    expect(designApprovalBlock(withDoc({ approval_request_id: 32 }))).toBe(
      "表示している設計書が、承認する依頼のものと違います。承認できません。",
    );
  });

  test("stops when the work item status is missing", () => {
    expect(designApprovalBlock({ ...READY, workItemStatus: undefined })).toBe(
      "作業項目の状態を確かめられないため、承認できません。",
    );
  });

  test("stops when the work item status is null", () => {
    expect(designApprovalBlock({ ...READY, workItemStatus: null })).toBe(
      "作業項目の状態を確かめられないため、承認できません。",
    );
  });

  test("stops when the work item is not waiting for the design approval", () => {
    expect(
      designApprovalBlock({ ...READY, workItemStatus: "implementing" }),
    ).toBe("作業項目が設計の承認待ちではないため、承認できません。");
  });

  test("stops when the approval request is not pending", () => {
    expect(designApprovalBlock(withDoc({ approval_status: "approved" }))).toBe(
      "この承認依頼は承認待ちではないため、承認できません。",
    );
  });

  test("stops when the approval status is one that is not known", () => {
    expect(designApprovalBlock(withDoc({ approval_status: "cancelled" }))).toBe(
      "この承認依頼は承認待ちではないため、承認できません。",
    );
  });

  test("stops when the design was truncated", () => {
    expect(designApprovalBlock(withDoc({ truncated: true }))).toBe(
      "設計書が長さの上限で切られていて、全文を確かめられないため、承認できません。",
    );
  });

  const ANOMALY_MESSAGE =
    "実装に渡る全文に、見えない文字か見えにくい並びがあります。却下を勧めます。";

  test.each([
    ["a zero width space", "a​b"],
    ["a line separator", "a b"],
    ["a strong right to left character", "aאb"],
    ["blank lines", "a\n\n\n\nb"],
    ["lines of spaces", `a\n${" \n".repeat(5)}b`],
    ["a long run of spaces", "a        b"],
    ["a copy of the blank-run mark", `a\n${blankRunMark(9)}`],
    ["a copy of the space-run mark", `a ${spaceRunMark(9)}`],
    ["eight ideographic spaces", `a${"\u3000".repeat(8)}b`],
    ["two no-break spaces in a row", "a\u00A0\u00A0b"],
    ["an indent of 32 spaces", `a\n${" ".repeat(32)}b`],
    ["repeated runs of seven tabs", `a${"\t".repeat(7)}b\n`.repeat(3)],
    ["a combining mark after a Latin letter", "e\u0301"],
  ])("stops a design with %s", (_name, text) => {
    expect(designApprovalBlock(withDoc({ text }))).toBe(ANOMALY_MESSAGE);
  });

  test.each([
    ["one ideographic space in a title", "# 設計\u3000書\n"],
    ["one no-break space", "a\u00A0b"],
    ["a decomposed voiced sound mark", "か\u3099"],
    ["a sentence that mentions the end mark", "画面は全文の終わりの印を出す。"],
    ["a link that starts like a mark", "[空白の扱い](docs/a.md)"],
    ["an indent of 31 spaces", `a\n${" ".repeat(31)}b`],
    ["two ideographic spaces of an indent", "\u3000\u3000本文です。"],
  ])("lets a design with %s through", (_name, text) => {
    expect(designApprovalBlock(withDoc({ text }))).toBeNull();
  });

  test("documents that two empty lines between single characters are not stopped", () => {
    const text = "x\n \n \n".repeat(200);
    expect(designApprovalBlock(withDoc({ text }))).toBeNull();
  });

  test("stops a design that is truncated before it looks for anomalies", () => {
    expect(designApprovalBlock(withDoc({ truncated: true, text: "a​b" }))).toBe(
      "設計書が長さの上限で切られていて、全文を確かめられないため、承認できません。",
    );
  });

  test("reports the intake issue before the design", () => {
    expect(
      designApprovalBlock({
        ...READY,
        snapshot: "loading",
        doc: { isPending: true, isError: false, data: undefined },
      }),
    ).toBe(
      "取り込み時点のIssueを読み込み中です。表示されるまで承認できません。",
    );
  });
});
