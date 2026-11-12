import { describe, expect, test } from "bun:test";
import {
  allowlistLine,
  GUIDE_PATH,
  lintRiskRegister,
  REGISTER_PATH,
  type RiskRegisterResult,
} from "../../scripts/lint-risk-register.ts";
import { createTreeReader } from "../../scripts/markdown-tree.ts";

const HEADER =
  "| ID | 残るリスクと、受け入れる理由 | 関連する節 |\n| --- | --- | --- |\n";

function row(
  id: string,
  anchor = id.toLowerCase(),
  cell = "リスクの文。",
): string {
  return `| <a id="${anchor}"></a>${id} | ${cell} | [節](security.md#節) |\n`;
}

const AREAS_HEAD =
  "| 略号 | 領域 | 説明の文書 | 使った最大の番号 |\n| --- | --- | --- | --- |\n";

// 略号の表の最大の番号は、渡さなければ、行と欠番に現れるR-ABの番号の最大を2桁にする。
function register(
  rows: string,
  tail = "",
  max?: string,
  areasOf: (recorded: string) => string = (recorded) =>
    `${AREAS_HEAD}| AB | [領域](#領域) | [節](security.md) | ${recorded} |\n`,
): string {
  const numbers = [...`${rows}${tail}`.matchAll(/R-AB-(\d{2})/g)].map((m) =>
    Number(m[1]),
  );
  const recorded = max ?? String(Math.max(0, ...numbers)).padStart(2, "0");
  return `# 残るリスク\n\n${areasOf(recorded)}\n## 領域\n\n${HEADER}${rows}${tail}`;
}

const GUIDE =
  "# 書き方\n\n## 許可の種類\n\n| 許可の種類 | 意味 |\n| --- | --- |\n| `unverified` | 確かめていない前提 |\n| `pointer` | 表への案内 |\n";

const SECTION = "docs/security.md";

function link(id: string): string {
  return `[${id}](security-risks.md#${id.toLowerCase()})`;
}

// 表と節の文書を、パスから本文への対応で渡す。
function resultOf(
  files: Record<string, string>,
  allowlist: string | undefined = "",
): RiskRegisterResult {
  return lintRiskRegister(
    Object.keys(files).sort(),
    createTreeReader((path) => files[path]),
    allowlist,
  );
}

function problemsOf(
  files: Record<string, string>,
  allowlist: string | undefined = "",
): string[] {
  return [...resultOf(files, allowlist).problems];
}

function hasProblem(files: Record<string, string>, part: string): boolean {
  return problemsOf(files).some((problem) => problem.includes(part));
}

// 表にR-AB-01の行がある文書の組で、節の本文だけを変える。
function withSection(section: string): Record<string, string> {
  return {
    [REGISTER_PATH]: register(row("R-AB-01")),
    [GUIDE_PATH]: GUIDE,
    [SECTION]: section,
  };
}

// 表と案内の文書に、節の文書を足す。
function withRegister(
  registerText: string,
  section: string,
): Record<string, string> {
  return {
    [REGISTER_PATH]: registerText,
    [GUIDE_PATH]: GUIDE,
    [SECTION]: section,
  };
}

function spotCount(section: string): number {
  return resultOf(withSection(section)).spots.length;
}

describe("lintRiskRegister rows", () => {
  test("accepts a register whose rows are all linked from a section", () => {
    expect(
      problemsOf(
        withSection(`# 節\n\n残るリスクは${link("R-AB-01")}である。\n`),
      ),
    ).toEqual([]);
  });

  test("reports an ID that is not of the form R-<AREA>-<NN>", () => {
    expect(
      hasProblem(
        withRegister(register(row("R-AB-1")), `# 節\n\n${link("R-AB-1")}\n`),
        "malformed ID: R-AB-1",
      ),
    ).toBe(true);
  });

  test("reports an ID numbered 00", () => {
    expect(
      hasProblem(
        withRegister(register(row("R-AB-00")), `# 節\n\n${link("R-AB-00")}\n`),
        "malformed ID: R-AB-00",
      ),
    ).toBe(true);
  });

  test("reports an ID whose area is not in the table of area codes", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01") + row("R-ZZ-01")),
          `# 節\n\n${link("R-AB-01")} ${link("R-ZZ-01")}\n`,
        ),
        "unknown area code: R-ZZ-01",
      ),
    ).toBe(true);
  });

  test("reports an ID that appears in two rows", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01") + row("R-AB-01")),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "repeated ID: R-AB-01",
      ),
    ).toBe(true);
  });

  test("reports a row whose anchor does not match its ID", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01", "r-ab-02")),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "row anchor missing: R-AB-01",
      ),
    ).toBe(true);
  });

  test("reports an ID that no section links to", () => {
    expect(
      hasProblem(
        withSection("# 節\n\n本文。\n"),
        "ID not linked from any section: R-AB-01",
      ),
    ).toBe(true);
  });

  test("reports a link labelled with an ID that points to another row", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01") + row("R-AB-02")),
          `# 節\n\n[R-AB-01](security-risks.md#r-ab-02) ${link("R-AB-02")}\n`,
        ),
        "link does not reach its row: R-AB-01",
      ),
    ).toBe(true);
  });

  test("reports a link inside the register labelled with an ID that points to another row", () => {
    expect(
      hasProblem(
        withRegister(
          register(
            row("R-AB-01") +
              row("R-AB-02", "r-ab-02", "[R-AB-01](#r-ab-02)と同じ。"),
          ),
          `# 節\n\n${link("R-AB-01")} ${link("R-AB-02")}\n`,
        ),
        "link does not reach its row: R-AB-01 (docs/security-risks.md:",
      ),
    ).toBe(true);
  });

  test("accepts a link inside the register that reaches its row", () => {
    expect(
      problemsOf(
        withRegister(
          register(
            row("R-AB-01") +
              row("R-AB-02", "r-ab-02", "[R-AB-01](#r-ab-01)と同じ。"),
          ),
          `# 節\n\n${link("R-AB-01")} ${link("R-AB-02")}\n`,
        ),
      ),
    ).toEqual([]);
  });

  test("does not count a link inside the register as a link from a section", () => {
    expect(
      hasProblem(
        withRegister(
          register(
            row("R-AB-01") +
              row("R-AB-02", "r-ab-02", "[R-AB-01](#r-ab-01)と同じ。"),
          ),
          `# 節\n\n${link("R-AB-02")}\n`,
        ),
        "ID not linked from any section: R-AB-01",
      ),
    ).toBe(true);
  });

  test("accepts a reference-style link to the row anchor", () => {
    expect(
      problemsOf(
        withSection(
          "# 節\n\n残るリスクは[R-AB-01][r]である。\n\n[r]: security-risks.md#r-ab-01\n",
        ),
      ),
    ).toEqual([]);
  });
});

describe("lintRiskRegister recorded maximum", () => {
  test("reports a deleted highest row that the gap list does not name", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01"), "", "02"),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "number skipped without a gap entry: R-AB-02",
      ),
    ).toBe(true);
  });

  test("accepts a deleted highest row that the gap list names", () => {
    expect(
      problemsOf(
        withRegister(
          register(row("R-AB-01"), "\n## 欠番\n\n- R-AB-02\n", "02"),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
      ),
    ).toEqual([]);
  });

  test("reports a number above the recorded maximum of its area", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01") + row("R-AB-02"), "", "01"),
          `# 節\n\n${link("R-AB-01")} ${link("R-AB-02")}\n`,
        ),
        "number above the recorded maximum: R-AB-02",
      ),
    ).toBe(true);
  });

  test("reports an area whose recorded maximum is not a number", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01"), "", "-"),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "malformed recorded maximum: AB",
      ),
    ).toBe(true);
  });

  test("reports a recorded maximum above 99, which no ID can reach", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01"), "", "100"),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "malformed recorded maximum: AB",
      ),
    ).toBe(true);
  });

  test("reports a recorded maximum not written in two digits as in the IDs", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01"), "", "1"),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "malformed recorded maximum: AB",
      ),
    ).toBe(true);
  });

  test("finds the recorded maximum by its header, not by its position", () => {
    const moved = (recorded: string): string =>
      `| 略号 | 使った最大の番号 | 領域 | 説明の文書 |\n| --- | --- | --- | --- |\n| AB | ${recorded} | [領域](#領域) | [節](security.md) |\n`;
    expect(
      problemsOf(
        withRegister(
          register(row("R-AB-01"), "", "01", moved),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
      ),
    ).toEqual([]);
  });
});

describe("lintRiskRegister gaps", () => {
  test("reports a missing number that the gap list does not name", () => {
    expect(
      hasProblem(
        withRegister(register(row("R-AB-02")), `# 節\n\n${link("R-AB-02")}\n`),
        "number skipped without a gap entry: R-AB-01",
      ),
    ).toBe(true);
  });

  test("accepts a missing number that the gap list names", () => {
    expect(
      problemsOf(
        withRegister(
          register(row("R-AB-02"), "\n## 欠番\n\n- R-AB-01\n"),
          `# 節\n\n${link("R-AB-02")}\n`,
        ),
      ),
    ).toEqual([]);
  });

  test("reports a gap entry that is still a row", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01"), "\n## 欠番\n\n- R-AB-01\n"),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "gap entry is a row: R-AB-01",
      ),
    ).toBe(true);
  });

  test("reports a gap entry listed twice", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-02"), "\n## 欠番\n\n- R-AB-01\n- R-AB-01\n"),
          `# 節\n\n${link("R-AB-02")}\n`,
        ),
        "repeated gap entry: R-AB-01",
      ),
    ).toBe(true);
  });

  test("reports a gap entry numbered 00", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01"), "\n## 欠番\n\n- R-AB-00\n"),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "malformed gap entry: R-AB-00",
      ),
    ).toBe(true);
  });

  test("reports a gap entry whose area is not in the table of area codes", () => {
    expect(
      hasProblem(
        withRegister(
          register(row("R-AB-01"), "\n## 欠番\n\n- R-ZZ-01\n"),
          `# 節\n\n${link("R-AB-01")}\n`,
        ),
        "unknown area code: R-ZZ-01",
      ),
    ).toBe(true);
  });
});

describe("lintRiskRegister allowlist", () => {
  const files = withSection(
    `# 節\n\n${link("R-AB-01")}\n\n残るリスクとして、何かが起きうる。\n`,
  );

  function spotLine(kind = "unverified"): string {
    const [spot] = resultOf(files).spots;
    if (spot === undefined) throw new Error("no spot");
    return allowlistLine(spot, kind);
  }

  test("reports a missing allowlist as one problem", () => {
    const missing = lintRiskRegister(
      Object.keys(files).sort(),
      createTreeReader((path) => files[path]),
      undefined,
    );
    expect(missing.problems).toEqual([
      "docs/security-risks.md: [risk] allowlist not found: scripts/lint-risk-register-allowlist.txt",
    ]);
  });

  test("reports an allowlist line whose kind is not in the guide", () => {
    expect(
      problemsOf(files, `${spotLine("bogus")}\n`).some((p) =>
        p.includes("unknown allowlist kind: bogus"),
      ),
    ).toBe(true);
  });

  test("accepts any kind that the guide lists", () => {
    expect(problemsOf(files, `${spotLine("pointer")}\n`)).toEqual([]);
  });

  test("reports an allowlist line without a kind as malformed", () => {
    const [path, key] = spotLine().split(" ");
    expect(
      problemsOf(files, `${path} ${key}\n`).some((p) =>
        p.includes("malformed allowlist line"),
      ),
    ).toBe(true);
  });

  test("reports a guide without the table of allowlist kinds", () => {
    expect(
      problemsOf({ ...files, [GUIDE_PATH]: "# 書き方\n" }, "").some((p) =>
        p.includes("allowlist kinds not found"),
      ),
    ).toBe(true);
  });

  test("reports a residual risk without a row link that the allowlist does not name", () => {
    expect(
      problemsOf(files).some((p) =>
        p.includes("unregistered residual risk: docs/security.md:5"),
      ),
    ).toBe(true);
  });

  test("tells first to add a row, and to use the allowlist only for what is not an accepted risk", () => {
    expect(
      problemsOf(files).find((p) => p.includes("unregistered")) ?? "",
    ).toMatch(
      /add a row .* link to it by ID .* only when .* not an accepted risk/,
    );
  });

  test("accepts a residual risk that the allowlist names", () => {
    expect(problemsOf(files, `${spotLine()}\n`)).toEqual([]);
  });

  test("reports an allowlist entry whose spot is gone", () => {
    expect(
      problemsOf(
        withSection(`# 節\n\n${link("R-AB-01")}\n`),
        `${spotLine()}\n`,
      ).some((p) => p.includes("allowlist entry not found: docs/security.md")),
    ).toBe(true);
  });

  test("reads the allowlist entry by its text, not by its line", () => {
    const moved = withSection(
      `# 節\n\n前の段落。\n\n${link("R-AB-01")}\n\n残るリスクとして、何かが起きうる。\n`,
    );
    expect(problemsOf(moved, `${spotLine()}\n`)).toEqual([]);
  });

  test("ignores comment lines and blank lines in the allowlist", () => {
    expect(problemsOf(files, `# 説明\n\n${spotLine()}\n`)).toEqual([]);
  });

  test("reports a second spot with the same text when the allowlist names it once", () => {
    const twice = withSection(
      `# 節\n\n${link("R-AB-01")}\n\n残るリスクとして、何かが起きうる。\n\n残るリスクとして、何かが起きうる。\n`,
    );
    expect(
      problemsOf(twice, `${spotLine()}\n`).some((p) =>
        p.includes("unregistered residual risk"),
      ),
    ).toBe(true);
  });
});

describe("lintRiskRegister spots", () => {
  test("finds a paragraph that mentions a residual risk without a row link", () => {
    expect(spotCount("# 節\n\n残るリスクとして、何かが起きうる。\n")).toBe(1);
  });

  test("does not find a paragraph that links to a row", () => {
    expect(spotCount(`# 節\n\n残るリスクは${link("R-AB-01")}である。\n`)).toBe(
      0,
    );
  });

  test("finds a paragraph whose ID label misses the row anchor", () => {
    expect(
      spotCount(
        "# 節\n\n残るリスクは[R-AB-01](security-risks.md#領域)である。\n",
      ),
    ).toBe(1);
  });

  test("finds a paragraph that accepts a risk without the residual-risk word", () => {
    expect(spotCount("# 節\n\nこの経路は、受け入れたリスクとする。\n")).toBe(1);
  });

  test("finds a paragraph that ends with an acceptance word", () => {
    expect(spotCount("# 節\n\n止めすぎは受け入れる。\n")).toBe(1);
  });

  test("finds each item without a row link under an introducing sentence", () => {
    expect(
      spotCount(
        `# 節\n\n残るリスクは次のとおりである。\n\n- ${link("R-AB-01")}\n- 確かめていない点。\n- まだ見ていない点。\n`,
      ),
    ).toBe(2);
  });

  test("finds both an introducing sentence with an acceptance word and each item without a row link", () => {
    expect(
      spotCount(
        "# 節\n\n次の2つの挙動は、受け入れている。\n\n- 1つ目。\n- 2つ目。\n",
      ),
    ).toBe(3);
  });

  test("does not find an item that links to a row under an introducing sentence with an acceptance word", () => {
    expect(
      spotCount(
        `# 節\n\n次の挙動は、受け入れている。\n\n- ${link("R-AB-01")}にあたる。\n`,
      ),
    ).toBe(1);
  });

  test("finds a sentence that names an ID without a link", () => {
    expect(
      spotCount(
        `# 節\n\n残るリスクは${link("R-AB-01")}である。\nR-AB-01と同じ止めすぎは受け入れる。\n`,
      ),
    ).toBe(1);
  });

  test("finds a sentence of an item that names an ID without a link", () => {
    expect(
      spotCount(
        `# 節\n\n残るリスクは次のとおりである。\n\n- ${link("R-AB-01")}にあたる。\n  R-AB-01と同じ止めすぎは受け入れる。\n`,
      ),
    ).toBe(1);
  });

  test("does not read a sentence that ends with がある as introducing a list", () => {
    expect(
      spotCount("# 節\n\n残るリスクがある。\n\n- 1つ目。\n- 2つ目。\n"),
    ).toBe(1);
  });

  test("reads 以下の as introducing a list", () => {
    expect(
      spotCount(
        "# 節\n\n残るリスクは以下のとおりである。\n\n- 1つ目。\n- 2つ目。\n",
      ),
    ).toBe(2);
  });

  test("finds an acceptance in another sentence of a paragraph that links to a row", () => {
    expect(
      spotCount(
        `# 節\n\n残るリスクは${link("R-AB-01")}である。\n止めすぎは受け入れる。\n`,
      ),
    ).toBe(1);
  });

  test("does not find the acceptance in the sentence that holds the row link", () => {
    expect(
      spotCount(`# 節\n\nこの形は、${link("R-AB-01")}として受け入れる。\n`),
    ).toBe(0);
  });

  test("finds an acceptance in another sentence of an item that links to a row", () => {
    expect(
      spotCount(
        `# 節\n\n残るリスクは次のとおりである。\n\n- ${link("R-AB-01")}にあたる。\n  止めすぎは受け入れる。\n`,
      ),
    ).toBe(1);
  });

  test("uses the first of two definitions with the same label", () => {
    expect(
      spotCount(
        "# 節\n\n残るリスクは[R-AB-01][r]である。\n\n[r]: security-risks.md#r-ab-01\n[r]: security-risks.md#領域\n",
      ),
    ).toBe(0);
  });

  test("reads the introducing sentence at the end of a paragraph of several lines", () => {
    expect(
      spotCount(
        "# 節\n\n前の文である。\n残るリスクは次のとおりである。\n\n- 1つ目。\n- 2つ目。\n",
      ),
    ).toBe(2);
  });

  test("does not read an earlier sentence of a paragraph as the introducing sentence", () => {
    expect(
      spotCount(
        "# 節\n\n残るリスクは次のとおりである。\n後の文である。\n\n- 1つ目。\n- 2つ目。\n",
      ),
    ).toBe(1);
  });

  test("finds an introducing paragraph whose earlier sentence holds a residual risk", () => {
    expect(
      spotCount(
        `# 節\n\n残るリスクとして、何かが起きうる。\n残るリスクは次のとおりである。\n\n- ${link("R-AB-01")}\n`,
      ),
    ).toBe(1);
  });

  test("finds items under a residual-risk heading", () => {
    expect(spotCount("# 節\n\n## 残るリスク\n\n- 1つ目。\n- 2つ目。\n")).toBe(
      2,
    );
  });

  test("stops reading items at a sub-heading below a residual-risk heading", () => {
    expect(
      spotCount(
        "# 節\n\n## 残るリスク\n\n- 1つ目。\n\n### 別の話\n\n- 説明。\n",
      ),
    ).toBe(1);
  });

  test("reads a nested list as part of its top-level item", () => {
    expect(
      spotCount(
        "# 節\n\n残るリスクは次のとおりである。\n\n- 親の項目。\n  - 子の項目。\n",
      ),
    ).toBe(1);
  });

  test("does not find a residual risk inside a table", () => {
    expect(
      spotCount(
        "# 節\n\n| a | b |\n| --- | --- |\n| 残るリスクとして、起きうる。 | x |\n",
      ),
    ).toBe(0);
  });
});
