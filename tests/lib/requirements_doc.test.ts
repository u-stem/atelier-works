import { describe, expect, test } from "bun:test";
import {
  checkDiagramRefs,
  checkDocumentProse,
  checkForbiddenSyntax,
  checkLengths,
  checkQuotes,
  checkRequirementIds,
  checkSections,
  documentRegisterIssues,
  extractH2Headings,
  validateRequirementsDoc,
} from "../../f/factory/lib/requirements_doc.ts";

/**
 * 形式をすべて満たす最小の要件定義書を返す。
 * 11節すべてを持ち、FR・NFR・ACを1件ずつ含み、禁止された記法を使わない。
 * 各テストはこれを1か所だけ変えて使う。
 */
function baseDoc(): string {
  return [
    "# 要件定義: サンプル",
    "",
    "対象: example-org/widgets Issue #1 / 試行: 1",
    "",
    "## 背景・目的",
    "",
    "背景の説明である。",
    "",
    "## スコープ",
    "",
    "### 含むもの",
    "",
    "- 含む項目",
    "",
    "### 含まないもの",
    "",
    "- 含まない項目",
    "",
    "## 用語",
    "",
    "| 用語 | 意味 |",
    "| --- | --- |",
    "| 用語A | 意味A |",
    "",
    "## 利用者と利用シーン",
    "",
    "利用シーンの説明である。",
    "",
    "## 業務要件",
    "",
    "業務要件の説明である。",
    "",
    "## 機能要件",
    "",
    "| ID | 要件 | 優先度 | 根拠 |",
    "| --- | --- | --- | --- |",
    "| FR-001 | 要件その1 | Must | 根拠その1 |",
    "",
    "## 非機能要件",
    "",
    "| ID | 区分 | 要件 |",
    "| --- | --- | --- |",
    "| NFR-001 | 性能 | 要件その1 |",
    "",
    "## 制約・前提",
    "",
    "- 制約その1",
    "",
    "## 受入条件",
    "",
    "| ID | 対象要件 | 条件 |",
    "| --- | --- | --- |",
    "| AC-001 | FR-001 | Given 前提 / When 操作 / Then 結果 |",
    "",
    "## 未決事項",
    "",
    "| 論点 | 仮置き | 影響 |",
    "| --- | --- | --- |",
    "| 論点その1 | 仮置きその1 | 影響その1 |",
    "",
    "## 変更履歴",
    "",
    "| 試行 | 変更内容 |",
    "| --- | --- |",
    "| attempt 1 | 初版 |",
    "",
  ].join("\n");
}

describe("extractH2Headings", () => {
  test("extracts only ## headings, not ### subheadings", () => {
    const headings = extractH2Headings(baseDoc());
    expect(headings).toContain("スコープ");
  });

  test("does not extract ### subheadings", () => {
    const headings = extractH2Headings(baseDoc());
    expect(headings).not.toContain("含むもの");
  });
});

describe("checkSections", () => {
  test("returns no issues for a document with all 11 sections in order", () => {
    expect(checkSections(baseDoc())).toEqual([]);
  });

  test("reports a missing section", () => {
    const missingSection = baseDoc().replace("## 未決事項\n\n", "");
    const issues = checkSections(missingSection);
    expect(issues.some((issue) => issue.includes("未決事項"))).toBe(true);
  });

  test("reports an out-of-order section", () => {
    // 本文はそのままに「## 用語」と「## 利用者と利用シーン」の見出しだけを入れ替え、
    // 順序の違反を起こす。
    const swapped = baseDoc()
      .replace("## 用語", "## __TMP__")
      .replace("## 利用者と利用シーン", "## 用語")
      .replace("## __TMP__", "## 利用者と利用シーン");
    const issues = checkSections(swapped);
    expect(issues.some((issue) => issue.includes("順序"))).toBe(true);
  });
});

describe("checkRequirementIds", () => {
  test("returns no issues for well-formed, fully-referenced IDs", () => {
    expect(checkRequirementIds(baseDoc())).toEqual([]);
  });

  test("reports a duplicate ID", () => {
    const duplicated = baseDoc().replace(
      "| FR-001 | 要件その1 | Must | 根拠その1 |",
      [
        "| FR-001 | 要件その1 | Must | 根拠その1 |",
        "| FR-001 | 要件その2 | Should | 根拠その2 |",
      ].join("\n"),
    );
    const issues = checkRequirementIds(duplicated);
    expect(issues.some((issue) => issue.includes("重複"))).toBe(true);
  });

  test("reports a gap in sequential numbering", () => {
    // 文字列全体を置換せず、FRの行とそれを参照するACをまとめて付け替える。
    // 表の整合を保ち、検出される問題を番号の欠けだけにするため。
    const gapped = baseDoc()
      .replace(
        "| FR-001 | 要件その1 | Must | 根拠その1 |",
        "| FR-002 | 要件その1 | Must | 根拠その1 |",
      )
      .replace(
        "| AC-001 | FR-001 | Given 前提 / When 操作 / Then 結果 |",
        "| AC-001 | FR-002 | Given 前提 / When 操作 / Then 結果 |",
      );
    const issues = checkRequirementIds(gapped);
    expect(issues).toEqual([
      "FRのIDが連番になっていません(001番が欠番の可能性があります)",
    ]);
  });

  test("reports an acceptance criterion whose target FR doesn't exist", () => {
    const danglingRef = baseDoc().replace(
      "| AC-001 | FR-001 | Given 前提 / When 操作 / Then 結果 |",
      "| AC-001 | FR-999 | Given 前提 / When 操作 / Then 結果 |",
    );
    const issues = checkRequirementIds(danglingRef);
    expect(issues.some((issue) => issue.includes("存在しません"))).toBe(true);
  });

  test("reports a functional requirement with no acceptance criterion", () => {
    const noAc = baseDoc().replace(
      "| AC-001 | FR-001 | Given 前提 / When 操作 / Then 結果 |\n",
      "",
    );
    const issues = checkRequirementIds(noAc);
    expect(issues.some((issue) => issue.includes("受入条件がありません"))).toBe(
      true,
    );
  });

  test("reports zero functional requirements", () => {
    const noFr = baseDoc().replace(
      "| FR-001 | 要件その1 | Must | 根拠その1 |\n",
      "",
    );
    const issues = checkRequirementIds(noFr);
    expect(
      issues.some((issue) => issue.includes("機能要件が1件もありません")),
    ).toBe(true);
  });

  test("reports zero acceptance criteria", () => {
    const noAc = baseDoc().replace(
      "| AC-001 | FR-001 | Given 前提 / When 操作 / Then 結果 |\n",
      "",
    );
    const issues = checkRequirementIds(noAc);
    expect(
      issues.some((issue) => issue.includes("受入条件が1件もありません")),
    ).toBe(true);
  });
});

describe("checkForbiddenSyntax", () => {
  test("returns no issues for a document with no forbidden syntax", () => {
    expect(checkForbiddenSyntax(baseDoc())).toEqual([]);
  });

  test("reports a code fence", () => {
    const withFence = baseDoc().replace(
      "背景の説明である。",
      "```\nconst x = 1;\n```",
    );
    const issues = checkForbiddenSyntax(withFence);
    expect(issues.some((issue) => issue.includes("コードフェンス"))).toBe(true);
  });

  test("reports bold markup", () => {
    const withBold = baseDoc().replace(
      "背景の説明である。",
      "**強調された**説明である。",
    );
    const issues = checkForbiddenSyntax(withBold);
    expect(issues.some((issue) => issue.includes("太字"))).toBe(true);
  });

  test("reports an emoji", () => {
    const withEmoji = baseDoc().replace(
      "背景の説明である。",
      "背景の説明である 🎉",
    );
    const issues = checkForbiddenSyntax(withEmoji);
    expect(issues.some((issue) => issue.includes("絵文字"))).toBe(true);
  });

  test("reports an unfilled placeholder", () => {
    const withPlaceholder = baseDoc().replace(
      "背景の説明である。",
      "<背景を書く>",
    );
    const issues = checkForbiddenSyntax(withPlaceholder);
    expect(issues.some((issue) => issue.includes("プレースホルダ"))).toBe(true);
  });

  test("reports a disallowed alert kind", () => {
    const withTipAlert = baseDoc().replace(
      "背景の説明である。",
      "> [!TIP]\n背景の説明である。",
    );
    const issues = checkForbiddenSyntax(withTipAlert);
    expect(issues.some((issue) => issue.includes("アラート種別"))).toBe(true);
  });

  test("does not report a markdown autolink", () => {
    const withAutolink = baseDoc().replace(
      "背景の説明である。",
      "詳細は<https://example.com>を参照する。",
    );
    expect(checkForbiddenSyntax(withAutolink)).toEqual([]);
  });
});

describe("checkQuotes", () => {
  test("reports an empty quote line", () => {
    const markdown = ["> 本文", ">", "続き"].join("\n");
    const issues = checkQuotes(markdown);
    expect(issues.some((issue) => issue.includes("空の引用行"))).toBe(true);
  });

  test("reports an alert heading with no body", () => {
    const markdown = ["> [!NOTE]", "引用ではない行"].join("\n");
    const issues = checkQuotes(markdown);
    expect(issues.some((issue) => issue.includes("本文のないアラート"))).toBe(
      true,
    );
  });
});

describe("checkLengths", () => {
  test("returns no issues for a document within all limits", () => {
    expect(checkLengths(baseDoc())).toEqual([]);
  });

  test("reports a line exceeding MAX_LINE_CHARS", () => {
    const longLine = baseDoc().replace("背景の説明である。", "あ".repeat(201));
    const issues = checkLengths(longLine);
    expect(issues.some((issue) => issue.includes("200文字"))).toBe(true);
  });

  test("reports a paragraph exceeding MAX_SENTENCES_PER_PARAGRAPH", () => {
    const longParagraph = baseDoc().replace(
      "背景の説明である。",
      "一文目である。二文目である。三文目である。四文目である。",
    );
    const issues = checkLengths(longParagraph);
    expect(issues.some((issue) => issue.includes("文数"))).toBe(true);
  });
});

describe("checkDiagramRefs", () => {
  test("returns no issues when the reference and file match", () => {
    const withDiagram = baseDoc().replace(
      "利用シーンの説明である。",
      "利用シーンの説明である。\n\n![usage-scene](usage-scene.drawio)",
    );
    expect(checkDiagramRefs(withDiagram, ["usage-scene.drawio"])).toEqual([]);
  });

  test("reports a reference with no matching file", () => {
    const withDiagram = baseDoc().replace(
      "利用シーンの説明である。",
      "利用シーンの説明である。\n\n![usage-scene](usage-scene.drawio)",
    );
    const issues = checkDiagramRefs(withDiagram, []);
    expect(
      issues.some((issue) => issue.includes("対応するファイルがありません")),
    ).toBe(true);
  });

  test("reports too many diagrams", () => {
    const withDiagrams = baseDoc().replace(
      "利用シーンの説明である。",
      [
        "利用シーンの説明である。",
        "",
        "![diagram-a](diagram-a.drawio)",
        "![diagram-b](diagram-b.drawio)",
        "![diagram-c](diagram-c.drawio)",
        "![diagram-d](diagram-d.drawio)",
      ].join("\n"),
    );
    const issues = checkDiagramRefs(withDiagrams, [
      "diagram-a.drawio",
      "diagram-b.drawio",
      "diagram-c.drawio",
      "diagram-d.drawio",
    ]);
    expect(issues.some((issue) => issue.includes("上限"))).toBe(true);
  });
});

describe("validateRequirementsDoc", () => {
  test("returns ok:true for a fully filled-in requirements document", async () => {
    const markdown = await Bun.file(
      `${import.meta.dir}/../fixtures/requirements/valid.md`,
    ).text();
    const result = validateRequirementsDoc(markdown, [
      "reservation-flow.drawio",
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("checkDocumentProse", () => {
  test("does not block on a polite ending because the register is only logged", () => {
    const issues = checkDocumentProse("背景を説明します。");

    expect(issues).toEqual([]);
  });

  test("reports inline code in a heading", () => {
    const issues = checkDocumentProse("### `foo`の扱い");

    expect(issues).toHaveLength(1);
  });

  test("does not repeat the emoji issue that checkForbiddenSyntax reports", () => {
    const issues = checkDocumentProse("完了した。\u{1F389}");

    expect(issues).toEqual([]);
  });
});

describe("documentRegisterIssues", () => {
  test("reports a polite ending in a requirements document", () => {
    const issues = documentRegisterIssues("背景を説明します。");

    expect(issues).toHaveLength(1);
  });

  test("does not report inline code in a heading, which checkDocumentProse blocks on", () => {
    const issues = documentRegisterIssues("### `foo`の扱い");

    expect(issues).toEqual([]);
  });
});
