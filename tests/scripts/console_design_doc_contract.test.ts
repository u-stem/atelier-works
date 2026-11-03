// backendの"design_doc"ビューが、設計書の特定、本文と図の出どころ、秘密値のマスクで守る契約と、
// 変換結果がConsole(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import { isDesignDocRows } from "../../console/src/api/guards/design.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { REQUIREMENTS_BASE_DIR } from "../../f/factory/lib/requirements_template.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

const VALID_DIAGRAM_XML =
  '<mxfile><diagram id="d1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';

const DOC_DIR = `${REQUIREMENTS_BASE_DIR}/o/r/issue-42/wi-7/design/req-2/attempt-1`;

const DRAFT_ROW: SqlRow = {
  id: "21",
  work_item_id: "7",
  owner: "o",
  repo: "r",
  requirement_attempt: 2,
  design_attempt: 1,
  summary: "Summary",
  markdown: "# Design\n\n![flow](flow.drawio)\n",
  diagrams: [{ name: "flow", file: "flow.drawio" }],
  open_questions: ["Which one?"],
  doc_dir: DOC_DIR,
  created_at: new Date("2026-11-01T00:00:00Z"),
  approval_request_id: "31",
  approval_status: "pending",
  is_newest_of_pair: true,
};

/**
 * 問い合わせに束縛された作業項目の番号と設計書の番号で、行を選ぶ偽のクライアント。
 * 実際のSQLの絞り込みと並べ替え(新しい設計書が先、1行だけ)を、束縛の値で真似る。
 * 束縛の順は、作業項目の番号、設計書の番号(無ければnull)である。
 */
function selectingSql(rows: SqlRow[]): SqlClient {
  return (_strings, ...values) => {
    const [workItemId, draftId] = values;
    const picked = rows
      .filter((row) => Number(row.work_item_id) === Number(workItemId))
      .filter((row) => draftId === null || Number(row.id) === Number(draftId))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 1);
    return {
      fetch: () => Promise.resolve(picked),
      execute: () => Promise.resolve(),
    };
  };
}

type ReadLog = {
  readonly paths: string[];
  readonly read: (p: string) => Promise<string>;
};

function diskWith(files: Record<string, string>): ReadLog {
  const paths: string[] = [];
  return {
    paths,
    read: (path) => {
      paths.push(path);
      const content = files[path];
      return content === undefined
        ? Promise.reject(new Error("ENOENT"))
        : Promise.resolve(content);
    },
  };
}

async function designDoc(
  rows: SqlRow[],
  options: { draftId?: number; disk?: ReadLog } = {},
) {
  return await runConsoleQuery(
    "design_doc",
    200,
    30,
    selectingSql(rows),
    7,
    null,
    (options.disk ?? diskWith({})).read,
    null,
    options.draftId,
  );
}

describe("design_doc", () => {
  test("returns the latest draft by id without a draft_id", async () => {
    const rows = await designDoc([
      { ...DRAFT_ROW, id: "21" },
      { ...DRAFT_ROW, id: "22" },
    ]);
    expect(rows).toMatchObject([{ id: 22 }]);
  });

  test("returns the draft of the id", async () => {
    const rows = await designDoc(
      [
        { ...DRAFT_ROW, id: "21" },
        { ...DRAFT_ROW, id: "22" },
      ],
      { draftId: 21 },
    );
    expect(rows).toMatchObject([{ id: 21 }]);
  });

  test("returns nothing for a draft of another work item", async () => {
    const rows = await designDoc([{ ...DRAFT_ROW, work_item_id: "8" }], {
      draftId: 21,
    });
    expect(rows).toEqual([]);
  });

  test("tells two drafts with the same design_attempt apart after a return to requirements", async () => {
    const rows = await designDoc(
      [
        { ...DRAFT_ROW, id: "21", requirement_attempt: 1, design_attempt: 1 },
        { ...DRAFT_ROW, id: "22", requirement_attempt: 2, design_attempt: 1 },
      ],
      { draftId: 21 },
    );
    expect(rows).toMatchObject([{ requirement_attempt: 1, design_attempt: 1 }]);
  });

  test("returns the draft of the pair that is not the newest without its diagrams", async () => {
    const disk = diskWith({ [`${DOC_DIR}/flow.drawio`]: VALID_DIAGRAM_XML });
    const rows = await designDoc([{ ...DRAFT_ROW, is_newest_of_pair: false }], {
      disk,
    });
    expect(rows).toMatchObject([{ diagrams: [], rejected_diagrams: [] }]);
  });

  test("does not read the diagrams of a draft with a newer draft of the same pair", async () => {
    const disk = diskWith({ [`${DOC_DIR}/flow.drawio`]: VALID_DIAGRAM_XML });
    await designDoc([{ ...DRAFT_ROW, is_newest_of_pair: false }], { disk });
    expect(disk.paths).toEqual([]);
  });

  test("masks a token split by U+200B in the markdown", async () => {
    const token = `ghp_${"A".repeat(10)}​${"B".repeat(10)}`;
    const rows = await designDoc([
      { ...DRAFT_ROW, markdown: `# D\n${token}\n` },
    ]);
    expect(rows).toMatchObject([{ markdown: "# D\n***\n" }]);
  });

  test("does not cut the markdown at 8000 code points", async () => {
    const markdown = `# D\n${"a".repeat(9000)}\n`;
    const rows = await designDoc([{ ...DRAFT_ROW, markdown }]);
    expect(rows).toMatchObject([{ markdown }]);
  });

  test("returns the summary and the questions as saved", async () => {
    const rows = await designDoc([
      { ...DRAFT_ROW, summary: "Saved summary", open_questions: ["A?", "B?"] },
    ]);
    expect(rows).toMatchObject([
      { summary: "Saved summary", open_questions: ["A?", "B?"] },
    ]);
  });

  test("reads only the diagrams from the disk", async () => {
    const disk = diskWith({ [`${DOC_DIR}/flow.drawio`]: VALID_DIAGRAM_XML });
    await designDoc([DRAFT_ROW], { disk });
    expect(disk.paths).toEqual([`${DOC_DIR}/flow.drawio`]);
  });

  test("returns the diagram that it read", async () => {
    const disk = diskWith({ [`${DOC_DIR}/flow.drawio`]: VALID_DIAGRAM_XML });
    const rows = await designDoc([DRAFT_ROW], { disk });
    expect(rows).toMatchObject([
      { diagrams: [{ name: "flow", xml: VALID_DIAGRAM_XML }] },
    ]);
  });

  test("puts a diagram that fails validation into rejected_diagrams", async () => {
    const disk = diskWith({ [`${DOC_DIR}/flow.drawio`]: "<not-a-diagram/>" });
    const rows = await designDoc([DRAFT_ROW], { disk });
    expect(rows).toMatchObject([{ diagrams: [], rejected_diagrams: ["flow"] }]);
  });

  test("drops a diagram of a doc dir outside the base dir", async () => {
    const outside = "/var/lib/other/design/req-2/attempt-1";
    const disk = diskWith({ [`${outside}/flow.drawio`]: VALID_DIAGRAM_XML });
    const rows = await designDoc([{ ...DRAFT_ROW, doc_dir: outside }], {
      disk,
    });
    expect(rows).toMatchObject([{ diagrams: [], rejected_diagrams: [] }]);
  });

  test("does not read a doc dir that climbs out of the base dir", async () => {
    const disk = diskWith({});
    await designDoc(
      [{ ...DRAFT_ROW, doc_dir: `${REQUIREMENTS_BASE_DIR}/../claude/x` }],
      { disk },
    );
    expect(disk.paths).toEqual([]);
  });

  test("drops an unreadable diagram", async () => {
    const rows = await designDoc([DRAFT_ROW], { disk: diskWith({}) });
    expect(rows).toMatchObject([{ diagrams: [], rejected_diagrams: [] }]);
  });

  test("drops the diagrams of a draft without a doc dir", async () => {
    const rows = await designDoc([{ ...DRAFT_ROW, doc_dir: null }]);
    expect(rows).toMatchObject([{ diagrams: [], rejected_diagrams: [] }]);
  });

  test("does not read a diagram whose file name is malformed", async () => {
    const disk = diskWith({});
    await designDoc(
      [{ ...DRAFT_ROW, diagrams: [{ name: "flow", file: "../flow.drawio" }] }],
      { disk },
    );
    expect(disk.paths).toEqual([]);
  });

  test("returns owner, repo and approval_request_id", async () => {
    const rows = await designDoc([DRAFT_ROW]);
    expect(rows).toMatchObject([
      { owner: "o", repo: "r", approval_request_id: 31 },
    ]);
  });

  test("returns a null approval_request_id without a request", async () => {
    const rows = await designDoc([
      { ...DRAFT_ROW, approval_request_id: null, approval_status: null },
    ]);
    expect(rows).toMatchObject([
      { approval_request_id: null, approval_status: null },
    ]);
  });

  for (const invalid of [0, -1, 1.5, Number.NaN]) {
    test(`returns nothing for a draft_id that is not a positive integer (${String(invalid)})`, async () => {
      const rows = await designDoc([DRAFT_ROW], { draftId: invalid });
      expect(rows).toEqual([]);
    });
  }

  test("requires a work_item_id", async () => {
    await expect(
      runConsoleQuery("design_doc", 200, 30, selectingSql([])),
    ).rejects.toThrow('"work_item_id" is required');
  });
});

describe("design_doc contract", () => {
  test("a converted row passes the Console type guard", async () => {
    const disk = diskWith({ [`${DOC_DIR}/flow.drawio`]: VALID_DIAGRAM_XML });
    const rows = await designDoc([DRAFT_ROW], { disk });
    expect(isDesignDocRows(rows)).toBe(true);
  });

  test("a converted row without an approval request passes the Console type guard", async () => {
    const rows = await designDoc([
      { ...DRAFT_ROW, approval_request_id: null, approval_status: null },
    ]);
    expect(isDesignDocRows(rows)).toBe(true);
  });

  test("an empty result passes the Console type guard", async () => {
    const rows = await designDoc([]);
    expect(isDesignDocRows(rows)).toBe(true);
  });
});
