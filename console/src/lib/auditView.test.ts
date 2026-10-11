import { describe, expect, test } from "bun:test";
import {
  auditIndexSubtitle,
  auditProposalBreakdown,
  auditProposalTotal,
  auditReportPath,
  auditReportTitle,
} from "./auditView.ts";

const COUNTS = { pending_count: 1, approved_count: 2, rejected_count: 3 };

describe("auditProposalBreakdown", () => {
  test("lists the pending, approved, and rejected counts in Japanese", () => {
    expect(auditProposalBreakdown(COUNTS)).toBe(
      "提案: 未決定 1 ・ 承認 2 ・ 却下 3",
    );
  });

  test("shows zero counts", () => {
    expect(
      auditProposalBreakdown({
        pending_count: 0,
        approved_count: 0,
        rejected_count: 0,
      }),
    ).toBe("提案: 未決定 0 ・ 承認 0 ・ 却下 0");
  });
});

describe("auditProposalTotal", () => {
  test("states the total and the breakdown", () => {
    expect(auditProposalTotal(COUNTS)).toBe("提案6件(承認待ち1・承認2・却下3)");
  });
});

describe("auditReportPath", () => {
  test("points to the report of the work item", () => {
    expect(auditReportPath(31)).toBe("/reports/audit/31");
  });
});

describe("auditReportTitle", () => {
  test("puts the period in the title", () => {
    expect(auditReportTitle("2026-09-28〜2026-10-04")).toBe(
      "監査レポート 2026-09-28〜2026-10-04",
    );
  });
});

describe("auditIndexSubtitle", () => {
  test("counts the reports", () => {
    expect(auditIndexSubtitle(3)).toBe("監査レポート 3件");
  });

  test("says there is none when the list is empty", () => {
    expect(auditIndexSubtitle(0)).toBe("監査レポートはまだありません");
  });
});
