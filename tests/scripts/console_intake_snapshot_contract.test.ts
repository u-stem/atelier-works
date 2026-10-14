// backendの"intake_snapshot"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import { isIntakeSnapshotRows } from "../../console/src/api/guards/intakeSnapshot.ts";
import { displayableIssueText } from "../../console/src/lib/intakeText.ts";
import { countHiddenCharacters } from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const ROW: SqlRow = {
  work_item_id: "7",
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  body: "Original body",
  refreshed: false,
};

describe("intake_snapshot contract", () => {
  test("a converted row passes the Console type guard", async () => {
    const rows = await runConsoleQuery(
      "intake_snapshot",
      200,
      30,
      sqlReturning([ROW]),
      7,
    );
    expect(isIntakeSnapshotRows(rows)).toBe(true);
  });

  test("an empty result passes the Console type guard", async () => {
    const rows = await runConsoleQuery(
      "intake_snapshot",
      200,
      30,
      sqlReturning([]),
      7,
    );
    expect(isIntakeSnapshotRows(rows)).toBe(true);
  });
});

// backendが切った後ろの部分で数える文字と、Consoleが代替文字に置き換える文字は、同じ分類でなければならない。
// 食い違うと、警告が出ないまま承認者に見えない文字が通る。
const SAMPLES = [
  "a\u200Bb",
  "a\u200Eb",
  "a\u202Eb",
  "a\u2066b",
  "a\u2028b",
  "a\uFEFFb",
  "a\uFE0Fb",
  "a\u{E0100}b",
  "a\u{E0041}b",
  "a\u0007b",
  "a\u007Fb",
  "a\u0085b",
  "plain text",
  "日本語 and 😀",
  "tab\tand\nnewline",
];

describe("hidden character classification", () => {
  test.each(SAMPLES)("backend and Console agree on %j", (sample) => {
    expect(countHiddenCharacters(sample) > 0).toBe(
      displayableIssueText(sample).replaced,
    );
  });
});
