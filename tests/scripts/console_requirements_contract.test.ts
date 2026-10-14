// backendの"requirements_index"と"requirements_doc"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import {
  isRequirementsDocRows,
  isRequirementsIndexRows,
} from "../../console/src/api/guards/requirements.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { REQUIREMENTS_BASE_DIR } from "../../f/factory/lib/requirements_template.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const INDEX_ROW: SqlRow = {
  work_item_id: "7",
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  status: "awaiting_approval",
  latest_attempt: 2,
  updated_at: new Date("2026-10-08T00:00:00Z"),
};

const VALID_DIAGRAM_XML =
  '<mxfile><diagram id="d1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';

const DOC_ROW: SqlRow = {
  work_item_id: "7",
  attempt: 2,
  summary: "Summary",
  markdown: "# Title",
  diagrams: [],
  open_questions: ["Which one?"],
  doc_dir: null,
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  work_item_status: "awaiting_approval",
};

describe("requirements_index contract", () => {
  test("a converted row passes the Console type guard", async () => {
    const rows = await runConsoleQuery(
      "requirements_index",
      500,
      3650,
      sqlReturning([INDEX_ROW]),
    );
    expect(isRequirementsIndexRows(rows)).toBe(true);
  });

  test("an empty result passes the Console type guard", async () => {
    const rows = await runConsoleQuery(
      "requirements_index",
      500,
      3650,
      sqlReturning([]),
    );
    expect(isRequirementsIndexRows(rows)).toBe(true);
  });
});

describe("requirements_doc contract", () => {
  test("a row read from the database copy passes the Console type guard", async () => {
    const rows = await runConsoleQuery(
      "requirements_doc",
      200,
      30,
      sqlReturning([DOC_ROW]),
      7,
    );
    expect(isRequirementsDocRows(rows)).toBe(true);
  });

  describe("a row read from files", () => {
    async function readFromFiles() {
      return await runConsoleQuery(
        "requirements_doc",
        200,
        30,
        sqlReturning([
          {
            ...DOC_ROW,
            doc_dir: `${REQUIREMENTS_BASE_DIR}/7-2`,
            diagrams: [{ name: "flow", file: "flow.drawio" }],
          },
        ]),
        7,
        2,
        (path) =>
          Promise.resolve(
            path.endsWith(".drawio") ? VALID_DIAGRAM_XML : "# Title",
          ),
      );
    }

    test("passes the Console type guard", async () => {
      expect(isRequirementsDocRows(await readFromFiles())).toBe(true);
    });

    test("carries the diagram read from the file", async () => {
      expect(await readFromFiles()).toMatchObject([
        { doc_dir_source: "file", diagrams: [{ name: "flow" }] },
      ]);
    });
  });

  test("an empty result passes the Console type guard", async () => {
    const rows = await runConsoleQuery(
      "requirements_doc",
      200,
      30,
      sqlReturning([]),
      7,
    );
    expect(isRequirementsDocRows(rows)).toBe(true);
  });
});
