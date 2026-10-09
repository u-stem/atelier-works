// backendの"summary"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。
// 表示の対応表(console/src/lib/labels.ts)が、backendの値を取りこぼしていないこともここで確かめる。

import { describe, expect, test } from "bun:test";
import { isConsoleSummary } from "../../console/src/api/guards/summary.ts";
import { LEGACY_CONSOLE_PATH } from "../../console/src/app/legacyConsole.ts";
import {
  approvalKindLabel,
  approvalStatusLabel,
  noticeKindLabel,
  UNKNOWN_NOTICE_LABEL,
  UNKNOWN_STATUS_LABEL,
  workItemKindLabel,
  workItemStatusLabel,
} from "../../console/src/lib/labels.ts";
import { buildConsoleUrl } from "../../f/factory/lib/approval_support.ts";
import { NOTICE_SEVERITY } from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  APPROVAL_REQUEST_KINDS,
  APPROVAL_REQUEST_STATUSES,
  ISSUE_PROPOSAL_ORIGINS,
  WORK_ITEM_KINDS,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";
import { runConsoleSummary } from "../../f/factory/steps/console_query.ts";

function sqlReturning(responses: SqlRow[][]): SqlClient {
  let callIndex = 0;
  return () => {
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
}

const T0 = "2026-10-01T00:00:00.000Z";

const APPROVAL_ROW: SqlRow = {
  approval_request_id: "3",
  kind: "requirements",
  status: "pending",
  work_item_id: 1,
  owner: "o",
  repo: "r",
  title: "Add feature",
  issue_number: "42",
  issue_url: "https://github.com/o/r/issues/42",
  pr_number: null,
  requested_at: new Date(T0),
  expires_at: null,
  draft_attempt: 2,
  summary: "要約",
  proposal_title: null,
  created_issue_number: null,
  origin: null,
  total_count: "5",
};

const PROPOSAL_ROW: SqlRow = {
  ...APPROVAL_ROW,
  approval_request_id: 4,
  kind: "issue_proposal",
  status: "approved",
  draft_attempt: null,
  proposal_title: "改善",
  origin: "audit",
};

const FAILURE_ROW: SqlRow = {
  work_item_id: 7,
  kind: "issue",
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  pr_number: null,
  title: "Fix bug",
  status: "failed",
  updated_at: new Date(T0),
  status_note: "claude run failed",
  status_changed_at: new Date(T0),
  job_failure_id: 11,
  flow_path: "f/factory/pipeline",
  job_id: "job-1",
  step: "generate",
  error: "boom",
  occurred_at: new Date(T0),
  total_count: 4,
};

const FAILURE_WITHOUT_RECORD_ROW: SqlRow = {
  ...FAILURE_ROW,
  work_item_id: 8,
  status: "needs_human",
  job_failure_id: null,
  flow_path: null,
  job_id: null,
  step: null,
  error: null,
  occurred_at: null,
  status_note: null,
  status_changed_at: null,
};

const NOTICE_ROW: SqlRow = {
  notice_id: 21,
  kind: "cleanup_db_failed",
  message: "disk full",
  resolved: false,
  created_at: new Date(T0),
  total_count: 3,
};

/** WindmillがscriptのResultをJSONにして返す経路を再現する。 */
async function summaryAsDelivered(responses: SqlRow[][]): Promise<unknown> {
  const summary = await runConsoleSummary(200, sqlReturning(responses));
  return JSON.parse(JSON.stringify(summary));
}

describe("summary contract between console_query and the console guard", () => {
  test("accepts a summary with every list filled", async () => {
    const delivered = await summaryAsDelivered([
      [APPROVAL_ROW, PROPOSAL_ROW],
      [FAILURE_ROW, FAILURE_WITHOUT_RECORD_ROW],
      [NOTICE_ROW],
    ]);
    expect(isConsoleSummary(delivered)).toBe(true);
  });

  test("accepts an empty summary", async () => {
    const delivered = await summaryAsDelivered([[], [], []]);
    expect(isConsoleSummary(delivered)).toBe(true);
  });

  test("rejects a summary whose approval lost a field", async () => {
    const delivered = await summaryAsDelivered([[APPROVAL_ROW], [], []]);
    const damaged = JSON.parse(
      JSON.stringify(delivered, (key, value) =>
        key === "requested_at" ? undefined : value,
      ),
    );
    expect(isConsoleSummary(damaged)).toBe(false);
  });
});

describe("timestamps in the delivered summary", () => {
  test("carry a UTC offset so that the browser reads them as absolute times", async () => {
    const delivered = await summaryAsDelivered([[APPROVAL_ROW], [], []]);
    expect(JSON.stringify(delivered)).toContain(`"requested_at":"${T0}"`);
  });
});

describe("legacy console location", () => {
  test("the console link matches the app path that the backend links to", () => {
    expect(buildConsoleUrl("")).toBe(LEGACY_CONSOLE_PATH);
  });
});

describe("every enumerated backend value passes the console guard", () => {
  test.each([...APPROVAL_REQUEST_KINDS])("approval kind %s", async (kind) => {
    const delivered = await summaryAsDelivered([
      [{ ...APPROVAL_ROW, kind }],
      [],
      [],
    ]);
    expect(isConsoleSummary(delivered)).toBe(true);
  });

  test.each([...APPROVAL_REQUEST_STATUSES])(
    "approval status %s",
    async (status) => {
      const delivered = await summaryAsDelivered([
        [{ ...APPROVAL_ROW, status }],
        [],
        [],
      ]);
      expect(isConsoleSummary(delivered)).toBe(true);
    },
  );

  test.each([...ISSUE_PROPOSAL_ORIGINS])(
    "issue proposal origin %s",
    async (origin) => {
      const delivered = await summaryAsDelivered([
        [{ ...APPROVAL_ROW, kind: "issue_proposal", origin }],
        [],
        [],
      ]);
      expect(isConsoleSummary(delivered)).toBe(true);
    },
  );

  test("an issue proposal without a known origin", async () => {
    const delivered = await summaryAsDelivered([
      [{ ...APPROVAL_ROW, kind: "issue_proposal", origin: "future_origin" }],
      [],
      [],
    ]);
    expect(isConsoleSummary(delivered)).toBe(true);
  });

  test.each(Object.keys(NOTICE_SEVERITY))(
    "notice kind %s with its severity",
    async (kind) => {
      const delivered = await summaryAsDelivered([
        [],
        [],
        [{ ...NOTICE_ROW, kind }],
      ]);
      expect(isConsoleSummary(delivered)).toBe(true);
    },
  );

  test("a notice kind that is not in the severity table", async () => {
    const delivered = await summaryAsDelivered([
      [],
      [],
      [{ ...NOTICE_ROW, kind: "future_kind" }],
    ]);
    expect(isConsoleSummary(delivered)).toBe(true);
  });

  test.each([...WORK_ITEM_STATUSES])(
    "failure of a work item in status %s",
    async (status) => {
      const delivered = await summaryAsDelivered([
        [],
        [{ ...FAILURE_ROW, status }],
        [],
      ]);
      expect(isConsoleSummary(delivered)).toBe(true);
    },
  );

  test.each([...WORK_ITEM_KINDS])(
    "failure of a work item of kind %s",
    async (kind) => {
      const delivered = await summaryAsDelivered([
        [],
        [{ ...FAILURE_ROW, kind }],
        [],
      ]);
      expect(isConsoleSummary(delivered)).toBe(true);
    },
  );
});

describe("label tables cover the backend values", () => {
  test.each([...WORK_ITEM_STATUSES])("labels work item status %s", (status) => {
    expect(workItemStatusLabel(status)).not.toBe(UNKNOWN_STATUS_LABEL);
  });

  test.each([...WORK_ITEM_KINDS])("labels work item kind %s", (kind) => {
    expect(workItemKindLabel(kind)).not.toBe("その他");
  });

  test.each([...APPROVAL_REQUEST_KINDS])("labels approval kind %s", (kind) => {
    expect(approvalKindLabel(kind, null)).not.toBe("承認依頼");
  });

  test.each([...APPROVAL_REQUEST_STATUSES])(
    "labels approval status %s",
    (status) => {
      expect(approvalStatusLabel(status, "issue_proposal")).not.toBe(
        UNKNOWN_STATUS_LABEL,
      );
    },
  );

  test.each(Object.keys(NOTICE_SEVERITY))("labels notice kind %s", (kind) => {
    expect(noticeKindLabel(kind)).not.toBe(UNKNOWN_NOTICE_LABEL);
  });
});
