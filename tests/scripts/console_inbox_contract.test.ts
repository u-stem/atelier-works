// backendの"inbox"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import {
  isInboxProposal,
  isInboxRows,
} from "../../console/src/api/guards/inboxProposals.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const T0 = "2026-10-01T00:00:00.000Z";

const BASE_ROW: SqlRow = {
  approval_request_id: "3",
  status: "pending",
  work_item_id: 1,
  owner: "o",
  repo: "r",
  title: "Add feature",
  requested_at: new Date(T0),
  expires_at: null,
};

const REQUIREMENTS_ROW: SqlRow = {
  ...BASE_ROW,
  kind: "requirements",
  issue_number: "42",
  issue_url: "https://github.com/o/r/issues/42",
  draft_attempt: 2,
  summary: "要約",
};

const AUDIT_PROPOSAL_ROW: SqlRow = {
  ...BASE_ROW,
  approval_request_id: 4,
  kind: "issue_proposal",
  pr_number: null,
  proposal_title: "改善",
  proposal_body: "本文",
  proposal_status: "pending",
  created_issue_number: null,
  created_issue_url: null,
  claimed_by: null,
  origin: "audit",
  payload: {
    period_label: "2026-10-01〜2026-10-07",
    factory_label_available: true,
  },
};

const PR_PROPOSAL_ROW: SqlRow = {
  ...AUDIT_PROPOSAL_ROW,
  approval_request_id: 5,
  pr_number: 12,
  claimed_by: "worker",
  origin: "pr_fix",
  payload: {},
};

/** WindmillがscriptのResultをJSONにして返す経路を再現する。 */
async function inboxAsDelivered(rows: SqlRow[]): Promise<unknown> {
  const result = await runConsoleQuery("inbox", 200, 7, sqlReturning(rows));
  return JSON.parse(JSON.stringify(result));
}

describe("inbox contract between console_query and the console guard", () => {
  test("accepts an inbox with requirements and both kinds of proposal", async () => {
    const delivered = await inboxAsDelivered([
      REQUIREMENTS_ROW,
      AUDIT_PROPOSAL_ROW,
      PR_PROPOSAL_ROW,
    ]);
    expect(isInboxRows(delivered)).toBe(true);
  });

  test("accepts an empty inbox", async () => {
    expect(isInboxRows(await inboxAsDelivered([]))).toBe(true);
  });

  test("delivers the audit proposal fields the approval bar reads", async () => {
    const delivered = await inboxAsDelivered([AUDIT_PROPOSAL_ROW]);
    expect(
      Array.isArray(delivered) &&
        delivered.length === 1 &&
        isInboxProposal(delivered[0]) &&
        delivered[0].origin === "audit" &&
        delivered[0].factory_label_available,
    ).toBe(true);
  });

  test("delivers a proposal from a pull request without the label", async () => {
    const delivered = await inboxAsDelivered([PR_PROPOSAL_ROW]);
    expect(
      Array.isArray(delivered) &&
        isInboxProposal(delivered[0]) &&
        !delivered[0].factory_label_available,
    ).toBe(true);
  });
});
