// backendの"summary"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。
// 表示の対応表(console/src/lib/labels.ts)が、backendの値を取りこぼしていないこともここで確かめる。

import { describe, expect, test } from "bun:test";
import { isConsoleSummary } from "../../console/src/api/guards/summary.ts";
import { parseSelection } from "../../console/src/lib/inboxSelection.ts";
import {
  actionableCounts,
  openAuditFailureCount,
  unlistedCounts,
} from "../../console/src/lib/inboxView.ts";
import {
  approvalKindLabel,
  approvalStatusLabel,
  noticeKindLabel,
  UNKNOWN_NOTICE_LABEL,
  UNKNOWN_STATUS_LABEL,
  workItemKindLabel,
  workItemStatusLabel,
} from "../../console/src/lib/labels.ts";
import { legacyDeepLinkTarget } from "../../console/src/lib/legacyDeepLink.ts";
import { parseAttemptParam } from "../../console/src/lib/requirementsView.ts";
import {
  buildApprovalConsoleUrl,
  buildAuditConsoleUrl,
  buildConsoleUrl,
} from "../../f/factory/lib/approval_support.ts";
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
  superseded: false,
  total_count: 4,
  audit_open_count: 0,
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

/** 監査の失敗の行。`superseded`は、後の監査が報告を作ったときに真になる。 */
function auditFailureRow(id: number, superseded: boolean): SqlRow {
  return {
    ...FAILURE_ROW,
    work_item_id: id,
    kind: "audit",
    issue_number: null,
    issue_url: null,
    title: null,
    superseded,
  };
}

/** 監査の失敗2件(古い方は後の監査で解消済み)と、再実行できる失敗1件。DBが数えた件数を添える。 */
async function mixedAuditSummary(): Promise<unknown> {
  const open = { audit_open_count: 1, total_count: 3 };
  return summaryAsDelivered([
    [],
    [
      { ...auditFailureRow(30, false), ...open },
      { ...auditFailureRow(20, true), ...open },
      { ...FAILURE_ROW, ...open },
    ],
    [],
  ]);
}

describe("audit failures that a later audit resolved", () => {
  test("pass the console guard", async () => {
    expect(isConsoleSummary(await mixedAuditSummary())).toBe(true);
  });

  test("stay in the delivered list", async () => {
    const delivered = await mixedAuditSummary();
    expect(isConsoleSummary(delivered) ? delivered.failures.length : 0).toBe(3);
  });

  test("carry the flag that the console reads", async () => {
    const delivered = await mixedAuditSummary();
    expect(
      isConsoleSummary(delivered)
        ? delivered.failures.map((failure) => failure.superseded)
        : [],
    ).toEqual([false, true, false]);
  });

  test("leave the count of the unresolved audit failures to the database", async () => {
    const delivered = await mixedAuditSummary();
    expect(
      isConsoleSummary(delivered) ? openAuditFailureCount(delivered) : -1,
    ).toBe(1);
  });

  test("still count in the failures that the badge leaves out", async () => {
    const delivered = await mixedAuditSummary();
    expect(
      isConsoleSummary(delivered) ? actionableCounts(delivered).failures : -1,
    ).toBe(1);
  });

  test("leave only the unresolved ones in the audit card of the inbox", async () => {
    const delivered = await mixedAuditSummary();
    const cards = isConsoleSummary(delivered)
      ? unlistedCounts(
          delivered.counts,
          [],
          delivered.failures.filter((failure) => failure.kind === "audit")
            .length,
          openAuditFailureCount(delivered),
        )
      : [];
    expect(cards.find((card) => card.cause === "audit")?.count).toBe(1);
  });

  test("are not carried by a summary from an older backend", async () => {
    const delivered = await mixedAuditSummary();
    const older = JSON.parse(
      JSON.stringify(delivered, (key, value) =>
        key === "superseded" || key === "audit_failures_open"
          ? undefined
          : value,
      ),
    );
    expect(isConsoleSummary(older)).toBe(true);
  });

  test("count every audit failure as open for an older backend", async () => {
    const delivered = await mixedAuditSummary();
    const older = JSON.parse(
      JSON.stringify(delivered, (key, value) =>
        key === "superseded" || key === "audit_failures_open"
          ? undefined
          : value,
      ),
    );
    expect(isConsoleSummary(older) ? openAuditFailureCount(older) : -1).toBe(2);
  });

  test("count a delivered number, which the guard demands to be an integer", async () => {
    const delivered = await mixedAuditSummary();
    expect(
      isConsoleSummary(delivered) ? delivered.counts.audit_failures_open : null,
    ).toBe(1);
  });
});

describe("timestamps in the delivered summary", () => {
  test("carry a UTC offset so that the browser reads them as absolute times", async () => {
    const delivered = await summaryAsDelivered([[APPROVAL_ROW], [], []]);
    expect(JSON.stringify(delivered)).toContain(`"requested_at":"${T0}"`);
  });
});

const CONSOLE_PUBLIC_URL = "http://127.0.0.1:8080";

describe("console links built by the approval flow", () => {
  test("the approval link selects the approval in the inbox", () => {
    const { searchParams } = new URL(
      buildApprovalConsoleUrl(CONSOLE_PUBLIC_URL, 9),
    );
    expect(parseSelection(searchParams)).toEqual({ type: "approval", id: 9 });
  });

  test("the requirements link carries the attempt that the screen reads", () => {
    const { searchParams } = new URL(
      buildConsoleUrl(CONSOLE_PUBLIC_URL, { work_item_id: 7, attempt: 2 }),
    );
    expect(parseAttemptParam(searchParams.get("attempt"))).toEqual({
      kind: "attempt",
      attempt: 2,
    });
  });

  test("the audit report link has the path that the legacy audit link is read as", () => {
    expect(legacyDeepLinkTarget("#audit/12")).toBe(
      new URL(buildAuditConsoleUrl(CONSOLE_PUBLIC_URL, 12)).pathname,
    );
  });

  test("the requirements link has the path that the legacy requirements link is read as", () => {
    expect(legacyDeepLinkTarget("#requirements/7")).toBe(
      new URL(buildConsoleUrl(CONSOLE_PUBLIC_URL, { work_item_id: 7 }))
        .pathname,
    );
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
