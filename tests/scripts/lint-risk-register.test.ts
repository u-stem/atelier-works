import { describe, expect, test } from "bun:test";
import {
  countUnregisteredRisks,
  lintRiskRegister,
  REGISTER_PATH,
} from "../../scripts/lint-risk-register.ts";

// 表と節の文書を、パスから本文への対応で渡す。
function docsOf(files: Record<string, string>): {
  docs: string[];
  read: (path: string) => string | undefined;
} {
  return { docs: Object.keys(files).sort(), read: (path) => files[path] };
}

const HEADER =
  "| ID | 残るリスクと、受け入れる理由 | 関連する節 |\n| --- | --- | --- |\n";

function row(id: string, anchor = id.toLowerCase()): string {
  return `| <a id="${anchor}"></a>${id} | リスクの文。 | [節](security.md#節) |\n`;
}

function register(rows: string, tail = ""): string {
  return `# 残るリスク\n\n## 領域\n\n${HEADER}${rows}${tail}`;
}

const SECTION = "docs/security.md";

function link(id: string): string {
  return `[${id}](security-risks.md#${id.toLowerCase()})`;
}

function problemsOf(files: Record<string, string>, expected = 0): string[] {
  const { docs, read } = docsOf(files);
  return lintRiskRegister(docs, read, expected);
}

describe("lintRiskRegister", () => {
  test("accepts a register whose rows are all linked from a section", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-01")),
        [SECTION]: `# 節\n\n残るリスクは${link("R-AB-01")}である。\n`,
      }),
    ).toEqual([]);
  });

  test("reports an ID that is not of the form R-<AREA>-<NN>", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-1")),
        [SECTION]: `# 節\n\n${link("R-AB-1")}\n`,
      }).some((p) => p.includes("malformed ID: R-AB-1")),
    ).toBe(true);
  });

  test("reports an ID that appears in two rows", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-01") + row("R-AB-01")),
        [SECTION]: `# 節\n\n${link("R-AB-01")}\n`,
      }).some((p) => p.includes("repeated ID: R-AB-01")),
    ).toBe(true);
  });

  test("reports a row whose anchor does not match its ID", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-01", "r-ab-02")),
        [SECTION]: `# 節\n\n${link("R-AB-01")}\n`,
      }).some((p) => p.includes("row anchor missing: R-AB-01")),
    ).toBe(true);
  });

  test("reports an ID that no section links to", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-01")),
        [SECTION]: "# 節\n\n本文。\n",
      }).some((p) => p.includes("ID not linked from any section: R-AB-01")),
    ).toBe(true);
  });

  test("reports a link labelled with an ID that points to another row", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-01") + row("R-AB-02")),
        [SECTION]: `# 節\n\n[R-AB-01](security-risks.md#r-ab-02) ${link("R-AB-02")}\n`,
      }).some((p) => p.includes("link does not reach its row: R-AB-01")),
    ).toBe(true);
  });

  test("counts a reference-style link to the row anchor as a link", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-01")),
        [SECTION]:
          "# 節\n\n残るリスクは[R-AB-01][r]である。\n\n[r]: security-risks.md#r-ab-01\n",
      }),
    ).toEqual([]);
  });

  test("reports a missing number that the gap list does not name", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-02")),
        [SECTION]: `# 節\n\n${link("R-AB-02")}\n`,
      }).some((p) => p.includes("number skipped without a gap entry: R-AB-01")),
    ).toBe(true);
  });

  test("accepts a missing number that the gap list names", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-02"), "\n## 欠番\n\n- R-AB-01\n"),
        [SECTION]: `# 節\n\n${link("R-AB-02")}\n`,
      }),
    ).toEqual([]);
  });

  test("reports a gap entry that is still a row", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(row("R-AB-01"), "\n## 欠番\n\n- R-AB-01\n"),
        [SECTION]: `# 節\n\n${link("R-AB-01")}\n`,
      }).some((p) => p.includes("gap entry is a row: R-AB-01")),
    ).toBe(true);
  });

  test("reports a forbidden placeholder word in the register", () => {
    expect(
      problemsOf({
        [REGISTER_PATH]: register(
          row("R-AB-01").replace("リスクの文。", "元の文に無い"),
        ),
        [SECTION]: `# 節\n\n${link("R-AB-01")}\n`,
      }).some((p) => p.includes("forbidden word: 元の文に無い")),
    ).toBe(true);
  });

  test("reports when the count of unregistered residual risks differs from the expected number", () => {
    expect(
      problemsOf(
        {
          [REGISTER_PATH]: register(row("R-AB-01")),
          [SECTION]: `# 節\n\n${link("R-AB-01")}\n\n残るリスクとして、何かが起きうる。\n`,
        },
        0,
      ).some((p) => p.includes("unregistered residual risks: 1, expected 0")),
    ).toBe(true);
  });
});

describe("countUnregisteredRisks", () => {
  function count(section: string): number {
    const { docs, read } = docsOf({
      [REGISTER_PATH]: register(row("R-AB-01")),
      [SECTION]: section,
    });
    return countUnregisteredRisks(docs, read);
  }

  test("counts a paragraph that mentions a residual risk without a row link", () => {
    expect(count("# 節\n\n残るリスクとして、何かが起きうる。\n")).toBe(1);
  });

  test("does not count a paragraph that links to a row", () => {
    expect(count(`# 節\n\n残るリスクは${link("R-AB-01")}である。\n`)).toBe(0);
  });

  test("does not count a link with an ID label that misses the row anchor", () => {
    expect(
      count("# 節\n\n残るリスクは[R-AB-01](security-risks.md#領域)である。\n"),
    ).toBe(1);
  });

  test("counts each item without a row link under an introducing sentence", () => {
    expect(
      count(
        `# 節\n\n残るリスクは次のとおりである。\n\n- ${link("R-AB-01")}\n- 確かめていない点。\n- まだ見ていない点。\n`,
      ),
    ).toBe(2);
  });

  test("counts items under a residual-risk heading", () => {
    expect(count("# 節\n\n## 残るリスク\n\n- 1つ目。\n- 2つ目。\n")).toBe(2);
  });

  test("stops counting items at a sub-heading below a residual-risk heading", () => {
    expect(
      count("# 節\n\n## 残るリスク\n\n- 1つ目。\n\n### 別の話\n\n- 説明。\n"),
    ).toBe(1);
  });

  test("counts a nested list as part of its top-level item", () => {
    expect(
      count(
        "# 節\n\n残るリスクは次のとおりである。\n\n- 親の項目。\n  - 子の項目。\n",
      ),
    ).toBe(1);
  });
});
