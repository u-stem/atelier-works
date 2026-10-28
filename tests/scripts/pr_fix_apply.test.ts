// `pr_fix_apply.ts`が使う`pr_workflow_support.ts`の`composeCommitMessage`と
// `isFixClaudeOutput`のテスト。
// あわせて、`pr_fix_apply.ts`が渡す`requirements`が`lib/prompts.ts`の
// `fixPrompt`に届き、要件との整合を確かめる節が有効になることを、
// `main()`と同じ呼び方で確かめる。

import { describe, expect, test } from "bun:test";
import { fixPrompt } from "../../f/factory/lib/prompts.ts";
import type { RequirementDraft } from "../../f/factory/lib/types.ts";
import {
  composeCommitMessage,
  isCiFixClaudeOutput,
  isFixClaudeOutput,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("composeCommitMessage", () => {
  test("removes half-width spaces between ASCII and Japanese in the subject", () => {
    expect(
      composeCommitMessage("docs: README に farewell の使用例を追記", null),
    ).toBe("docs: READMEにfarewellの使用例を追記");
  });

  test("removes half-width spaces between ASCII and Japanese in the body", () => {
    expect(composeCommitMessage("fix: subject", "- README に 1 行追加")).toBe(
      "fix: subject\n\n- READMEに1行追加",
    );
  });

  test("leaves inline code in the body untouched", () => {
    expect(
      composeCommitMessage("fix: subject", "- `greet(name, options)` を追加"),
    ).toBe("fix: subject\n\n- `greet(name, options)`を追加");
  });

  test("returns just the subject when body is null", () => {
    expect(composeCommitMessage("fix: nullチェックを追加", null)).toBe(
      "fix: nullチェックを追加",
    );
  });

  test("joins subject and body with a blank line when body is present", () => {
    expect(
      composeCommitMessage("fix: subject", "- detail one\n- detail two"),
    ).toBe("fix: subject\n\n- detail one\n- detail two");
  });
});

const VALID_OUTPUT = {
  outcome: "done",
  summary: "fixed it",
  commit_subject: "fix: address review feedback",
  commit_body: null,
  replies: [{ review_comment_id: 1, body: "done", decision: "fixed" }],
  blocked_reason: null,
};

describe("isFixClaudeOutput", () => {
  test("accepts a well-formed done output", () => {
    expect(isFixClaudeOutput(VALID_OUTPUT)).toBe(true);
  });

  test("rejects an invalid outcome", () => {
    expect(isFixClaudeOutput({ ...VALID_OUTPUT, outcome: "wontfix" })).toBe(
      false,
    );
  });

  test("accepts a blocked outcome with a blocked_reason", () => {
    const output = {
      ...VALID_OUTPUT,
      outcome: "blocked",
      blocked_reason: "unsafe",
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a reply missing review_comment_id", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ body: "done", decision: "fixed" }],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  // `decision`は`renderFixReply`の最終行(「対応: <sha>」か「対応: 見送り」)を決める。
  // 欠けた返信は、暗黙の既定値で受け入れず、検査で弾く。
  test("rejects a reply missing decision", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ review_comment_id: 1, body: "done" }],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("accepts a reply with decision fixed", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ review_comment_id: 1, body: "done", decision: "fixed" }],
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("accepts a reply with decision skipped", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ review_comment_id: 1, body: "done", decision: "skipped" }],
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a reply with an invalid decision value", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ review_comment_id: 1, body: "done", decision: "wontfix" }],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  // 妥当だがこのPRの範囲外の指摘には、`decision`を"propose_issue"にし、
  // Issueの案のタイトルと本文を付ける。
  test("accepts a propose_issue reply with a well-formed issue_proposal", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "この指摘は別Issueとして起票します",
          decision: "propose_issue",
          issue_proposal: {
            title: "共有ヘルパーへ抽出する",
            body: "背景\n提案",
          },
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a propose_issue reply with issue_proposal null", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "この指摘は別Issueとして起票します",
          decision: "propose_issue",
          issue_proposal: null,
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a propose_issue reply missing issue_proposal entirely", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "この指摘は別Issueとして起票します",
          decision: "propose_issue",
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a propose_issue reply whose issue_proposal is missing body", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "この指摘は別Issueとして起票します",
          decision: "propose_issue",
          issue_proposal: { title: "共有ヘルパーへ抽出する" },
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a fixed reply that also carries a non-null issue_proposal", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "done",
          decision: "fixed",
          issue_proposal: { title: "t", body: "b" },
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a non-string, non-null blocked_reason", () => {
    const output = { ...VALID_OUTPUT, blocked_reason: 42 };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  // `commit_subject`と`commit_body`はClaudeが直接提案するため、件名の形は検査側で強制する。
  // 上限はgitの件名行の慣習に合わせた72コードポイント。
  // プロンプトとスキルでは50字程度を目安に求めており、72は検査が強制する外側の上限である。
  test("accepts a commit_subject at exactly the 72 code point limit", () => {
    const output = {
      ...VALID_OUTPUT,
      commit_subject: `fix: ${"a".repeat(67)}`,
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a commit_subject longer than 72 code points", () => {
    const output = {
      ...VALID_OUTPUT,
      commit_subject: `fix: ${"a".repeat(68)}`,
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a commit_subject ending with an ellipsis", () => {
    const output = { ...VALID_OUTPUT, commit_subject: "fix: something…" };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a commit_subject containing a newline", () => {
    const output = {
      ...VALID_OUTPUT,
      commit_subject: "fix: line one\nline two",
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  // 件名が空でよいのは、コミットするものが無い"done"以外の結果だけである。
  // `VALID_OUTPUT`の`outcome`は"done"なので、"blocked"に置き換えて確かめる。
  // "done"で件名が空だと、`pr_fix_finish.ts`が使う`composeCommitMessage`が
  // 件名行の空いたコミットを作り、最初の空でない行がCo-Authored-By/Generated-Byの
  // トレーラーになってしまう。
  test("accepts an empty commit_subject for a non-done outcome (nothing to commit)", () => {
    const output = {
      ...VALID_OUTPUT,
      outcome: "blocked",
      blocked_reason: "unsafe",
      commit_subject: "",
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects an empty commit_subject when outcome is done", () => {
    const output = { ...VALID_OUTPUT, commit_subject: "" };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a whitespace-only commit_subject when outcome is done", () => {
    const output = { ...VALID_OUTPUT, commit_subject: "   " };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("accepts a non-null commit_body", () => {
    const output = {
      ...VALID_OUTPUT,
      commit_body: "- detail one\n- detail two",
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a non-string, non-null commit_body", () => {
    const output = { ...VALID_OUTPUT, commit_body: 42 };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects an output missing commit_subject", () => {
    const { commit_subject: _omit, ...output } = VALID_OUTPUT;
    expect(isFixClaudeOutput(output)).toBe(false);
  });
});

const FAKE_PR = {
  owner: "acme",
  repo: "widgets",
  number: 1,
  title: "t",
  body: "b",
  url: "https://github.com/acme/widgets/pull/1",
  head_sha: "abc1234",
  base_ref: "main",
};

const FAKE_REQUIREMENTS: RequirementDraft = {
  id: 1,
  work_item_id: 9,
  attempt: 1,
  summary: "s",
  markdown: "the button must be blue",
  diagrams: [],
  open_questions: [],
  doc_dir: null,
  doc_hash: null,
  created_at: new Date("2026-01-01"),
};

describe("fixPrompt requirements wiring", () => {
  // `pr_fix_apply.ts`が渡す`requirements`で、
  // `fixPrompt`の要件との整合の節が有効になることを確かめる。
  // `requirements`は、`parent_work_item_id`から`latestDraft`で引いたもの、
  // または人が作ったPRなら`Closes #N`でつながるIssueの承認済みの草案である。
  test("includes the approved requirements text when requirements is non-null", () => {
    const prompt = fixPrompt({
      pr: FAKE_PR,
      reviews: [],
      comments: [],
      requirements: FAKE_REQUIREMENTS,
      checkFailures: [],
    });
    expect(prompt).toContain("the button must be blue");
  });

  test("omits the requirements-alignment section when requirements is null", () => {
    const prompt = fixPrompt({
      pr: FAKE_PR,
      reviews: [],
      comments: [],
      requirements: null,
      checkFailures: [],
    });
    expect(prompt).not.toContain("Approved requirements");
  });
});

describe("isCiFixClaudeOutput", () => {
  const CI_OUTPUT = { ...VALID_OUTPUT, replies: [] };

  test("accepts a done output without replies", () => {
    expect(isCiFixClaudeOutput(CI_OUTPUT)).toBe(true);
  });

  test("accepts a blocked output without replies", () => {
    expect(
      isCiFixClaudeOutput({
        ...CI_OUTPUT,
        outcome: "blocked",
        blocked_reason: "unsafe",
      }),
    ).toBe(true);
  });

  test("rejects an output that carries a reply", () => {
    expect(isCiFixClaudeOutput(VALID_OUTPUT)).toBe(false);
  });

  test("rejects a requirements gap", () => {
    expect(
      isCiFixClaudeOutput({
        ...CI_OUTPUT,
        outcome: "requirements_gap",
        blocked_reason: "gap",
      }),
    ).toBe(false);
  });

  test("rejects an output that is not a fix output", () => {
    expect(isCiFixClaudeOutput({ outcome: "done", replies: [] })).toBe(false);
  });

  test("rejects a design gap", () => {
    expect(
      isCiFixClaudeOutput({
        ...CI_OUTPUT,
        outcome: "design_gap",
        blocked_reason: "gap",
      }),
    ).toBe(false);
  });
});

const DESIGN_GAP_OUTPUT = {
  outcome: "design_gap",
  summary: "設計書のままでは受入条件2を満たせません。",
  commit_subject: "",
  commit_body: null,
  replies: [],
  blocked_reason: "設計書の関数Aは、受入条件2の入力を扱えません。",
};

describe("isFixClaudeOutput with a design_gap outcome", () => {
  test("accepts it when a design was handed over", () => {
    expect(isFixClaudeOutput(DESIGN_GAP_OUTPUT, true)).toBe(true);
  });

  test("rejects it when no design was handed over", () => {
    expect(isFixClaudeOutput(DESIGN_GAP_OUTPUT, false)).toBe(false);
  });

  test("rejects it when the design flag is left out", () => {
    expect(isFixClaudeOutput(DESIGN_GAP_OUTPUT)).toBe(false);
  });

  test("rejects it without a report", () => {
    expect(
      isFixClaudeOutput({ ...DESIGN_GAP_OUTPUT, blocked_reason: null }, true),
    ).toBe(false);
  });

  test("rejects it with an empty report", () => {
    expect(
      isFixClaudeOutput({ ...DESIGN_GAP_OUTPUT, blocked_reason: "" }, true),
    ).toBe(false);
  });

  test("rejects it with a report of blanks only", () => {
    expect(
      isFixClaudeOutput({ ...DESIGN_GAP_OUTPUT, blocked_reason: " \n " }, true),
    ).toBe(false);
  });

  test("rejects it with a reply, so that a proposal is not lost silently", () => {
    expect(
      isFixClaudeOutput(
        {
          ...DESIGN_GAP_OUTPUT,
          replies: [{ review_comment_id: 1, body: "x", decision: "skipped" }],
        },
        true,
      ),
    ).toBe(false);
  });
});

describe("isFixClaudeOutput with a design handed over", () => {
  test("still accepts a done output", () => {
    expect(isFixClaudeOutput(VALID_OUTPUT, true)).toBe(true);
  });

  test("still accepts a blocked output", () => {
    expect(
      isFixClaudeOutput(
        { ...VALID_OUTPUT, outcome: "blocked", blocked_reason: "unsafe" },
        true,
      ),
    ).toBe(true);
  });

  test("still accepts a requirements gap", () => {
    expect(
      isFixClaudeOutput(
        { ...VALID_OUTPUT, outcome: "requirements_gap", blocked_reason: "gap" },
        true,
      ),
    ).toBe(true);
  });
});

describe("isFixClaudeOutput without a design", () => {
  test.each([
    ["done", VALID_OUTPUT],
    ["blocked", { ...VALID_OUTPUT, outcome: "blocked", blocked_reason: "x" }],
    [
      "requirements_gap",
      { ...VALID_OUTPUT, outcome: "requirements_gap", blocked_reason: "x" },
    ],
  ])("accepts a %s output as before", (_name, output) => {
    expect(isFixClaudeOutput(output, false)).toBe(true);
  });
});

/** コメントを除いたソース。コメントに書いた文字列を、結線として数えないため。 */
async function stepSource(name: string): Promise<string> {
  const text = await Bun.file(
    new URL(`../../f/factory/steps/${name}`, import.meta.url),
  ).text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
}

// `main`はWindmillの変数とDBを直接使うので、結線はソースの文面で固定する。
// 整形や変数名の変更で落ちたときは、結線が変わっていないかを確かめてから文面を直す。
describe("the wiring of the design in pr_fix_apply", () => {
  test("loads the design with the setting of the design stage as it is", async () => {
    expect(await stepSource("pr_fix_apply.ts")).toMatch(
      /loadParentDesignForFix\(.*?\{ designEnabled: config\.design_enabled,/,
    );
  });

  test("loads the design only for a review round", async () => {
    expect(await stepSource("pr_fix_apply.ts")).toMatch(
      /reviewRound: ci_check_id === null && conflict_check_id === null,/,
    );
  });

  test("loads the design of the parent of the work item", async () => {
    expect(await stepSource("pr_fix_apply.ts")).toMatch(
      /parentWorkItemId: parent_work_item_id,/,
    );
  });

  test("hands the design to fixPrompt next to the requirements", async () => {
    expect(await stepSource("pr_fix_apply.ts")).toMatch(
      /requirements, design, checkFailures: \[\],/,
    );
  });

  test("asks for the schema with design_gap only when a design was handed over", async () => {
    expect(await stepSource("pr_fix_apply.ts")).toMatch(
      /jsonSchema: design === null \? FIX_SCHEMA : FIX_SCHEMA_WITH_DESIGN_GAP,/,
    );
  });

  test("checks the output with the presence of the design", async () => {
    expect(await stepSource("pr_fix_apply.ts")).toMatch(
      /isFixClaudeOutput\(value, design !== null\)/,
    );
  });

  test("loads the design once", async () => {
    expect(
      (await stepSource("pr_fix_apply.ts")).split("loadParentDesignForFix(")
        .length - 1,
    ).toBe(1);
  });
});
