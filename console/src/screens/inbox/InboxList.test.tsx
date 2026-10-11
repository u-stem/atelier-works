import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SummaryApproval,
  SummaryFailure,
  SummaryNotice,
} from "../../api/guards/summary.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import type { InboxItem } from "../../lib/inboxView.ts";
import { InboxList } from "./InboxList.tsx";

const APPROVAL: SummaryApproval = {
  approval_request_id: 3,
  kind: "requirements",
  status: "pending",
  work_item_id: 10,
  owner: "o",
  repo: "r",
  title: "Add feature",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  pr_number: null,
  requested_at: "2026-10-01T00:00:00.000Z",
  expires_at: null,
  draft_attempt: 2,
  summary: null,
  proposal_title: null,
  created_issue_number: null,
  origin: null,
};

const FAILURE: SummaryFailure = {
  work_item_id: 7,
  kind: "issue",
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: null,
  pr_number: null,
  title: "Fix bug",
  status: "failed",
  updated_at: "2026-10-02T00:00:00.000Z",
  status_note: null,
  status_changed_at: null,
  job_failure_id: null,
  flow_path: null,
  job_id: null,
  step: null,
  error: null,
  occurred_at: null,
};

const NOTICE: SummaryNotice = {
  notice_id: 21,
  kind: "cleanup_db_failed",
  message: "disk full",
  resolved: false,
  created_at: "2026-10-03T00:00:00.000Z",
  severity: "action",
  resolvable: true,
};

function render(item: InboxItem): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <InboxList
        items={[item]}
        selected={null}
        now={Date.parse("2026-10-09T12:00:00.000Z")}
        onSelect={() => undefined}
      />
    </TooltipProvider>,
  );
}

describe("InboxList", () => {
  test("marks an approval row so that the focus can return to it", () => {
    expect(render({ type: "approval", approval: APPROVAL })).toContain(
      'data-row="approval:3"',
    );
  });

  test("marks a failure row so that the focus can return to it", () => {
    expect(render({ type: "failure", failure: FAILURE })).toContain(
      'data-row="failure:7"',
    );
  });

  test("marks a notice row so that the focus can return to it", () => {
    expect(render({ type: "notice", notice: NOTICE })).toContain(
      'data-row="notice:21"',
    );
  });
});
