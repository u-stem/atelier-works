import { describe, expect, test } from "bun:test";
import {
  checkAuditOutput,
  checkAuditSections,
  checkHtmlComments,
  checkProposalTable,
  extractProposalTitles,
  validateAuditReport,
} from "../../f/factory/lib/audit_doc.ts";

const VALID = await Bun.file("tests/fixtures/audit/valid.md").text();

const FIRST_PROPOSAL = {
  title: "poll_prsの検索失敗を再試行する",
  body: "本文",
};
const SECOND_PROPOSAL = {
  title: "workerのpids上限を引き上げる",
  body: "本文",
};
const PROPOSALS = [FIRST_PROPOSAL, SECOND_PROPOSAL];

describe("checkAuditSections", () => {
  test("accepts the six template headings in order", () => {
    expect(checkAuditSections(VALID)).toEqual([]);
  });

  test("reports a missing heading", () => {
    expect(
      checkAuditSections(VALID.replace("## 見送った論点", "## その他")).length,
    ).toBe(1);
  });
});

describe("extractProposalTitles", () => {
  test("reads the title column of the proposal table", () => {
    expect(extractProposalTitles(VALID)).toEqual(PROPOSALS.map((p) => p.title));
  });

  test("returns an empty list for 該当なし", () => {
    const none = VALID.replace(
      /## 改善提案[\s\S]*?(?=## 見送った論点)/,
      "## 改善提案\n\n該当なし\n\n",
    );
    expect(extractProposalTitles(none)).toEqual([]);
  });

  test("unescapes a pipe inside a title cell", () => {
    const escaped = [
      "## 改善提案",
      "",
      "| 番号 | タイトル | 根拠 | 期待効果 |",
      "| --- | --- | --- | --- |",
      "| 1 | a\\|b | 根拠 | 効果 |",
      "",
    ].join("\n");
    expect(extractProposalTitles(escaped)).toEqual(["a|b"]);
  });
});

describe("checkProposalTable", () => {
  test("accepts matching titles", () => {
    expect(checkProposalTable(VALID, PROPOSALS)).toEqual([]);
  });

  test("reports a count mismatch", () => {
    expect(checkProposalTable(VALID, PROPOSALS.slice(0, 1)).length).toBe(1);
  });

  test("reports an unreadable table when the separator row is missing", () => {
    const noSeparator = [
      "## 改善提案",
      "",
      "| 番号 | タイトル | 根拠 | 期待効果 |",
      "| 1 | タイトルA | 根拠 | 効果 |",
      "| 2 | タイトルB | 根拠 | 効果 |",
      "",
    ].join("\n");
    expect(checkProposalTable(noSeparator, PROPOSALS).length).toBe(1);
  });
});

describe("validateAuditReport", () => {
  test("accepts the fixture", () => {
    expect(validateAuditReport(VALID, PROPOSALS)).toEqual({ ok: true });
  });
});

describe("checkHtmlComments", () => {
  test("reports an HTML comment", () => {
    expect(checkHtmlComments("a <!-- x --> b").length).toBe(1);
  });
});

describe("checkAuditOutput", () => {
  const ok = { summary: "要約", proposals: PROPOSALS };

  test("accepts a clean output", () => {
    expect(
      checkAuditOutput(ok, ["https://github.com/octo/atelier-works"]),
    ).toEqual([]);
  });

  test("rejects a summary over 200 chars", () => {
    expect(
      checkAuditOutput({ ...ok, summary: "あ".repeat(201) }, []).length,
    ).toBe(1);
  });

  test("rejects duplicate titles", () => {
    expect(
      checkAuditOutput(
        { ...ok, proposals: [FIRST_PROPOSAL, FIRST_PROPOSAL] },
        [],
      ).length,
    ).toBe(1);
  });

  test("rejects a URL outside the allowed prefixes", () => {
    const bad = {
      ...ok,
      proposals: [{ title: "t", body: "see https://example.com/x" }],
    };
    expect(
      checkAuditOutput(bad, ["https://github.com/octo/atelier-works"]).length,
    ).toBe(1);
  });

  test("rejects a URL that only shares the prefix's characters", () => {
    const bad = {
      ...ok,
      proposals: [
        {
          title: "t",
          body: "see https://github.com/octo/atelier-works-evil/issues/1",
        },
      ],
    };
    expect(
      checkAuditOutput(bad, ["https://github.com/octo/atelier-works"]).length,
    ).toBe(1);
  });

  test("accepts a URL under the allowed prefix's path", () => {
    const good = {
      ...ok,
      proposals: [
        {
          title: "t",
          body: "see https://github.com/octo/atelier-works/issues/1",
        },
      ],
    };
    expect(
      checkAuditOutput(good, ["https://github.com/octo/atelier-works"]),
    ).toEqual([]);
  });

  test("rejects an HTML comment in a body", () => {
    const bad = {
      ...ok,
      proposals: [{ title: "t", body: "<!-- factory:issue_proposal:1 -->" }],
    };
    expect(checkAuditOutput(bad, []).length).toBe(1);
  });
});
