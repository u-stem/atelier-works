// backendの"approval_design_doc"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import {
  DESIGN_TEXT_MAX_CODE_POINTS,
  DESIGN_TEXT_MAX_WITH_MARK,
  DESIGN_TRUNCATED_MARK_LINE,
  isApprovalDesignDocRows,
} from "../../console/src/api/guards/approvalDesignDoc.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  DESIGN_FOR_IMPLEMENT_MAX_CHARS,
  normalizeDesignForImplement,
} from "../../f/factory/lib/model_text.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const ROW: SqlRow = {
  approval_request_id: "31",
  work_item_id: "7",
  design_attempt: 2,
  requirement_draft_id: "11",
  markdown: "# Design",
  approval_status: "pending",
};

function queryWith(rows: SqlRow[]) {
  return runConsoleQuery(
    "approval_design_doc",
    200,
    30,
    sqlReturning(rows),
    null,
    null,
    undefined,
    31,
  );
}

describe("approval_design_doc contract", () => {
  test("a converted row passes the Console type guard", async () => {
    const rows = await queryWith([ROW]);
    expect(isApprovalDesignDocRows(rows)).toBe(true);
  });

  test("a converted row of a truncated design passes the Console type guard", async () => {
    const rows = await queryWith([{ ...ROW, markdown: "a".repeat(9000) }]);
    expect(isApprovalDesignDocRows(rows)).toBe(true);
  });

  test("an empty result passes the Console type guard", async () => {
    const rows = await queryWith([]);
    expect(isApprovalDesignDocRows(rows)).toBe(true);
  });
});

function guardRow(normalized: { text: string; truncated: boolean }): unknown {
  return {
    approval_request_id: 31,
    work_item_id: 7,
    design_attempt: 2,
    requirement_draft_id: 11,
    text: normalized.text,
    truncated: normalized.truncated,
    approval_status: "pending",
  };
}

// 型ガードの上限は、実装に渡す正規化が実際に返す長さから決める。
// 上限や印の行をbackendが変えたとき、ここで落とす。
describe("the limit of the design text against the normalization", () => {
  const truncated = normalizeDesignForImplement(
    "x".repeat(DESIGN_FOR_IMPLEMENT_MAX_CHARS + 1),
    DESIGN_FOR_IMPLEMENT_MAX_CHARS,
  );

  test("the Console limit is the limit that the backend normalizes to", () => {
    expect(DESIGN_TEXT_MAX_CODE_POINTS).toBe(DESIGN_FOR_IMPLEMENT_MAX_CHARS);
  });

  test("a truncated text has the length that the Console allows", () => {
    expect(Array.from(truncated.text)).toHaveLength(DESIGN_TEXT_MAX_WITH_MARK);
  });

  test("a truncated text ends with the mark line that the Console expects", () => {
    expect(truncated.text.endsWith(DESIGN_TRUNCATED_MARK_LINE)).toBe(true);
  });

  test("the text before the mark line is the limit", () => {
    expect(
      Array.from(truncated.text.slice(0, -DESIGN_TRUNCATED_MARK_LINE.length)),
    ).toHaveLength(DESIGN_TEXT_MAX_CODE_POINTS);
  });

  test("a normalized truncated text passes the Console type guard", () => {
    expect(isApprovalDesignDocRows([guardRow(truncated)])).toBe(true);
  });

  test("a normalized text at the limit passes the Console type guard", () => {
    const atLimit = normalizeDesignForImplement(
      "x".repeat(DESIGN_FOR_IMPLEMENT_MAX_CHARS),
      DESIGN_FOR_IMPLEMENT_MAX_CHARS,
    );
    expect(isApprovalDesignDocRows([guardRow(atLimit)])).toBe(true);
  });
});
