// backendの"pipeline"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。
// 表示の対応表と並び順(console/src/lib/)が、backendの状態と種別の値を取りこぼしていないこともここで確かめる。

import { describe, expect, test } from "bun:test";
import { isPipelineRows } from "../../console/src/api/guards/pipeline.ts";
import {
  UNKNOWN_STATUS_LABEL,
  workItemKindLabel,
  workItemStatusLabel,
} from "../../console/src/lib/labels.ts";
import {
  isActiveStatus,
  prLink,
  relatedLinks,
  rowsInScope,
  STATUS_ORDER,
  sortPipelineRows,
  TERMINAL_PIPELINE_STATUSES,
} from "../../console/src/lib/pipelineView.ts";
import { ACTIONABLE_WORK_ITEM_STATUSES } from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const T0 = "2026-10-08T00:00:00.000Z";

const PIPELINE_ROW: SqlRow = {
  work_item_id: "7",
  cycle: 1,
  source: "issue",
  owner: "o",
  repo: "r",
  issue_number: "9",
  issue_url: "https://github.com/o/r/issues/9",
  title: "Fix bug",
  status: "pr_open",
  attempt: "1",
  claimed_by: null,
  flow_job_id: null,
  created_at: new Date(T0),
  updated_at: new Date(T0),
  kind: "issue",
  pr_number: "12",
  fix_round: "2",
  branch: "factory/issue-9-wi-7",
  pr_url: "https://github.com/o/r/pull/12",
};

/** WindmillがscriptのResultをJSONにして返す経路を再現する。 */
async function pipelineAsDelivered(rows: SqlRow[]): Promise<unknown> {
  const result = await runConsoleQuery("pipeline", 500, 90, sqlReturning(rows));
  return JSON.parse(JSON.stringify(result));
}

describe("pipeline contract between console_query and the console guard", () => {
  test("accepts a work item that has a pull request", async () => {
    expect(isPipelineRows(await pipelineAsDelivered([PIPELINE_ROW]))).toBe(
      true,
    );
  });

  test("accepts a work item without an issue, branch or pull request", async () => {
    const delivered = await pipelineAsDelivered([
      {
        ...PIPELINE_ROW,
        issue_number: null,
        issue_url: null,
        title: null,
        branch: null,
        pr_number: null,
        pr_url: null,
      },
    ]);
    expect(isPipelineRows(delivered)).toBe(true);
  });

  test("accepts an empty list", async () => {
    expect(isPipelineRows(await pipelineAsDelivered([]))).toBe(true);
  });

  test("carries a UTC offset on the update time", async () => {
    const delivered = await pipelineAsDelivered([PIPELINE_ROW]);
    expect(JSON.stringify(delivered)).toContain(`"updated_at":"${T0}"`);
  });

  test("keeps the issue link that the console accepts", async () => {
    const delivered = await pipelineAsDelivered([PIPELINE_ROW]);
    const first = isPipelineRows(delivered) ? delivered[0] : undefined;
    expect(first === undefined ? null : relatedLinks(first)[0]?.url).toBe(
      "https://github.com/o/r/issues/9",
    );
  });

  test("keeps the pull request link that the console accepts", async () => {
    const delivered = await pipelineAsDelivered([PIPELINE_ROW]);
    const first = isPipelineRows(delivered) ? delivered[0] : undefined;
    expect(first === undefined ? null : prLink(first.pr_url)?.url).toBe(
      "https://github.com/o/r/pull/12",
    );
  });
});

describe("label tables cover the backend values", () => {
  test.each([...WORK_ITEM_STATUSES])("labels status %s", (status) => {
    expect(workItemStatusLabel(status)).not.toBe(UNKNOWN_STATUS_LABEL);
  });

  test.each([...WORK_ITEM_STATUSES])(
    "orders status %s explicitly",
    (status) => {
      expect(STATUS_ORDER).toContain(status);
    },
  );

  test.each([...WORK_ITEM_KINDS])("labels kind %s", (kind) => {
    expect(workItemKindLabel(kind)).not.toBe("その他");
  });

  test("ranks every status before one that is not known yet", () => {
    const statuses = ["0-unknown", ...WORK_ITEM_STATUSES];
    const rows = statuses.map((status, index) => ({
      work_item_id: index + 1,
      owner: "o",
      repo: "r",
      issue_number: null,
      issue_url: null,
      title: null,
      status,
      attempt: 1,
      kind: "issue",
      pr_number: null,
      fix_round: 0,
      branch: null,
      pr_url: null,
      updated_at: T0,
    }));
    const sorted = sortPipelineRows(rows, { key: "status", direction: "asc" });
    expect(sorted.at(-1)?.status).toBe("0-unknown");
  });
});

describe("the statuses that the console treats as settled", () => {
  test("are the terminal statuses of the backend", () => {
    expect([...TERMINAL_PIPELINE_STATUSES].sort()).toEqual(
      [...TERMINAL_WORK_ITEM_STATUSES].sort(),
    );
  });

  test.each([...WORK_ITEM_STATUSES])(
    "classify %s as active unless it is terminal, not blocked and not approved",
    (status) => {
      const settled =
        TERMINAL_WORK_ITEM_STATUSES.includes(status) &&
        status !== "blocked" &&
        status !== "approved";
      expect(isActiveStatus(status)).toBe(!settled);
    },
  );

  // `implement_enabled`が偽の間、承認された要件定義は`approved`のまま残る。
  // 要対応にもPR待ちにも出ないので、進行中で見えるようにする。
  test("keep approved visible, since it stays while implement is disabled", () => {
    expect(isActiveStatus("approved")).toBe(true);
  });

  test("keep approved out of the actionable statuses of the inbox", () => {
    expect(ACTIONABLE_WORK_ITEM_STATUSES).not.toContain("approved");
  });

  test("keep blocked out of the actionable statuses of the inbox", () => {
    expect(ACTIONABLE_WORK_ITEM_STATUSES).not.toContain("blocked");
  });

  test("treat blocked as active", () => {
    expect(isActiveStatus("blocked")).toBe(true);
  });

  test.each([...ACTIONABLE_WORK_ITEM_STATUSES])(
    "leave the actionable status %s to the inbox",
    (status) => {
      expect(isActiveStatus(status)).toBe(false);
    },
  );

  test("make the pr_open scope the pr_open status", () => {
    const rows = WORK_ITEM_STATUSES.map((status, index) => ({
      work_item_id: index + 1,
      owner: "o",
      repo: "r",
      issue_number: null,
      issue_url: null,
      title: null,
      status,
      attempt: 1,
      kind: "issue",
      pr_number: null,
      fix_round: 0,
      branch: null,
      pr_url: null,
      updated_at: T0,
    }));
    expect(rowsInScope(rows, "pr_open").map((row) => row.status)).toEqual([
      "pr_open",
    ]);
  });
});

describe("the status order of the console", () => {
  test("lists every status of the backend", () => {
    expect([...STATUS_ORDER].sort()).toEqual([...WORK_ITEM_STATUSES].sort());
  });

  test("lists each status once", () => {
    expect(new Set(STATUS_ORDER).size).toBe(STATUS_ORDER.length);
  });
});
