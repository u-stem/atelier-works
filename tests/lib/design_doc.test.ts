import { describe, expect, test } from "bun:test";
import {
  checkDesignIds,
  validateDesignDoc,
} from "../../f/factory/lib/design_doc.ts";
import { DESIGN_SECTIONS } from "../../f/factory/lib/design_template.ts";

const VALID_DOC = `# 設計: 例の機能

対象: acme/widgets Issue #1 / 要件の試行: 1 / 設計の試行: 1

## 方針

既存の保存処理を拡張し、新しい表を1つ足す。
読み出しは最新の行を採る。

## 構成要素と境界

| 構成要素 | 責務 | 境界 |
| --- | --- | --- |
| 保存処理 | 下書きを保存する | リースを持つ実行だけが書く |

## データの流れ

要件定義を読み、設計書を作って保存する。

![data-flow](data-flow.drawio)

## インターフェース

| 名前 | 入力 | 出力 |
| --- | --- | --- |
| 保存 | 作業項目の識別子 | 下書きの識別子 |

## エラーと境界条件

| 条件 | 扱い |
| --- | --- |
| リースを失った | 何も書かずに終える |

## テスト方針

| 観点 | 方法 |
| --- | --- |
| 保存 | 単体テスト |

## 要件との対応表

| ID | 対象要件 | 設計の対応 |
| --- | --- | --- |
| DS-001 | FR-001 | 保存処理が下書きを保存する |
| DS-002 | FR-002 | 読み出しが最新の行を返す |

## 未決事項

| 論点 | 仮置き | 影響 |
| --- | --- | --- |
| 保持期間 | 無期限 | 容量が増える |

## 変更履歴

| 試行 | 変更内容 |
| --- | --- |
| attempt 1 | 初版 |
`;

const FILES = ["data-flow.drawio"];

function issuesOf(markdown: string, files: readonly string[] = FILES) {
  const result = validateDesignDoc(markdown, files);
  return result.ok ? [] : result.issues;
}

function mentions(issues: readonly string[], text: string): boolean {
  return issues.some((issue) => issue.includes(text));
}

describe("validateDesignDoc", () => {
  test("accepts a complete document", () => {
    expect(validateDesignDoc(VALID_DOC, FILES)).toEqual({ ok: true });
  });

  test("the sample document has exactly the sections of the template", () => {
    expect(
      [...VALID_DOC.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ).toEqual([...DESIGN_SECTIONS]);
  });

  test("reports a missing section", () => {
    const doc = VALID_DOC.replace("## テスト方針", "## 別の章");
    expect(mentions(issuesOf(doc), "章が見つかりません: 「テスト方針」")).toBe(
      true,
    );
  });

  test("reports a section that the template does not have", () => {
    const doc = `${VALID_DOC}\n## 付録\n\n該当なし\n`;
    expect(mentions(issuesOf(doc), "規定にない章があります: 「付録」")).toBe(
      true,
    );
  });

  test("reports sections out of order", () => {
    const doc = VALID_DOC.replace("## 方針", "## TMP")
      .replace("## 構成要素と境界", "## 方針")
      .replace("## TMP", "## 構成要素と境界");
    expect(mentions(issuesOf(doc), "章の順序が規定と一致しません")).toBe(true);
  });

  test("reports a design ID of the wrong form", () => {
    const doc = VALID_DOC.replace("DS-002", "D-2");
    expect(mentions(issuesOf(doc), "IDの形式が不正です: 「D-2」")).toBe(true);
  });

  test("reports a duplicated design ID", () => {
    const doc = VALID_DOC.replace("DS-002", "DS-001");
    expect(mentions(issuesOf(doc), "IDが重複しています: 「DS-001」")).toBe(
      true,
    );
  });

  test("reports a gap in the design IDs", () => {
    const doc = VALID_DOC.replace("DS-002", "DS-003");
    expect(mentions(issuesOf(doc), "DSのIDが連番になっていません")).toBe(true);
  });

  test("reports a correspondence table without rows", () => {
    const doc = VALID_DOC.replace(/\| DS-00\d \|.*\n/g, "");
    expect(mentions(issuesOf(doc), "要件との対応が1件もありません")).toBe(true);
  });

  test("reports a code fence", () => {
    const doc = VALID_DOC.replace("読み出しは最新の行を採る。", "```\nx\n```");
    expect(mentions(issuesOf(doc), "コードフェンス")).toBe(true);
  });

  test("reports bold text", () => {
    const doc = VALID_DOC.replace("新しい表を1つ足す", "**新しい表**を1つ足す");
    expect(mentions(issuesOf(doc), "太字記法")).toBe(true);
  });

  test("reports an unfilled placeholder", () => {
    const doc = VALID_DOC.replace("保存処理が下書きを保存する", "<設計の対応>");
    expect(mentions(issuesOf(doc), "プレースホルダ")).toBe(true);
  });

  test("reports a line that is longer than 200 characters", () => {
    const doc = VALID_DOC.replace(
      "読み出しは最新の行を採る。",
      `${"あ".repeat(201)}。`,
    );
    expect(mentions(issuesOf(doc), "200文字を超えています")).toBe(true);
  });

  test("reports a document that is longer than 8000 characters", () => {
    const filler = Array.from({ length: 60 }, () => `- ${"い".repeat(150)}`);
    const doc = VALID_DOC.replace(
      "読み出しは最新の行を採る。",
      filler.join("\n"),
    );
    expect(mentions(issuesOf(doc), "8000文字を超えています")).toBe(true);
  });

  test("reports a paragraph of more than three sentences", () => {
    const doc = VALID_DOC.replace(
      "読み出しは最新の行を採る。",
      "一つ目。二つ目。三つ目。四つ目。",
    );
    expect(mentions(issuesOf(doc), "文数が3文を超えています")).toBe(true);
  });

  test("reports a heading with code notation", () => {
    const doc = VALID_DOC.replace("## 方針", "## `方針`");
    expect(mentions(issuesOf(doc), "見出しにコード表記があります")).toBe(true);
  });

  test("reports a reference to a diagram that has no file", () => {
    expect(
      mentions(
        issuesOf(VALID_DOC, []),
        "本文が参照する図「data-flow」に対応するファイルがありません",
      ),
    ).toBe(true);
  });

  test("reports a diagram file that the document does not refer to", () => {
    expect(
      mentions(
        issuesOf(VALID_DOC, [...FILES, "unused.drawio"]),
        "図ファイル「unused.drawio」が本文から参照されていません",
      ),
    ).toBe(true);
  });

  test("reports more than three diagrams", () => {
    const names = ["a-1", "a-2", "a-3", "a-4"];
    const refs = names.map((name) => `![${name}](${name}.drawio)`).join("\n\n");
    const doc = VALID_DOC.replace("![data-flow](data-flow.drawio)", refs);
    expect(
      mentions(
        issuesOf(
          doc,
          names.map((name) => `${name}.drawio`),
        ),
        "図の数が上限(3枚)を超えています",
      ),
    ).toBe(true);
  });
});

describe("checkDesignIds", () => {
  test("accepts sequential IDs", () => {
    expect(checkDesignIds(VALID_DOC)).toEqual([]);
  });

  test("starts the sequence at DS-001", () => {
    const doc = VALID_DOC.replace("DS-001", "DS-003").replace(
      "DS-002",
      "DS-002",
    );
    expect(checkDesignIds(doc).length).toBeGreaterThan(0);
  });
});
