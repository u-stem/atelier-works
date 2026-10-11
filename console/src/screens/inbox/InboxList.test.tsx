import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SummaryApproval,
  SummaryFailure,
  SummaryNotice,
} from "../../api/guards/summary.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import type { InboxSelection } from "../../lib/inboxSelection.ts";
import type { InboxItem } from "../../lib/inboxView.ts";
import { InboxList } from "./InboxList.tsx";

const NOW = Date.parse("2026-10-04T00:00:00.000Z");
const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

function notice(id: number, message: string): InboxItem {
  const row: SummaryNotice = {
    notice_id: id,
    kind: "deployed_sha_mismatch",
    message,
    resolved: false,
    created_at: "2026-10-03T00:00:00.000Z",
    severity: "action",
    resolvable: true,
  };
  return { type: "notice", notice: row };
}

function approval(id = 1): InboxItem {
  const row: SummaryApproval = {
    approval_request_id: id,
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
  return { type: "approval", approval: row };
}

function failure(): InboxItem {
  const row: SummaryFailure = {
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
  return { type: "failure", failure: row };
}

/** `items`を描く。`allItems`は絞り込む前の全体で、省くと`items`と同じにする。 */
function render(
  items: readonly InboxItem[],
  allItems: readonly InboxItem[] = items,
  selected: InboxSelection | null = null,
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <InboxList
        items={items}
        selected={selected}
        now={NOW}
        allItems={allItems}
        onSelect={() => {}}
      />
    </TooltipProvider>,
  );
}

describe("InboxList", () => {
  test("omits the kind of a list that holds only notices", () => {
    expect(render([notice(1, SHA_A), notice(2, SHA_B)])).not.toContain(
      ">通知<",
    );
  });

  test("keeps the kind of notices filtered out of a mixed list", () => {
    const notices = [notice(1, SHA_A), notice(2, SHA_B)];
    expect(render(notices, [approval(), ...notices])).toContain(">通知<");
  });

  test("keeps the kind of an approval in a list of approvals", () => {
    expect(render([approval()])).toContain(">要件定義<");
  });

  test("compares a notice with the notices filtered out of the list", () => {
    const first = notice(1, `deployed(${SHA_A}) cause a`);
    const second = notice(2, `deployed(${SHA_A}) cause b`);
    expect(render([first], [first, second])).not.toContain("版 ");
  });

  test("shows the version of a notice that has no peers", () => {
    expect(render([notice(1, `deployed(${SHA_A}) cause a`)])).toContain(
      "版 0123456",
    );
  });

  test("shows the version that tells same-titled notices apart", () => {
    const pair = [notice(1, SHA_A), notice(2, SHA_B)];
    expect(render(pair, pair, { type: "notice", id: 1 })).toContain(
      "版 fedcba9",
    );
  });

  test("carries the whole body of a notice in the title of the sub label", () => {
    expect(render([notice(1, `deployed(${SHA_A}) is behind`)])).toContain(
      'title="deployed(0123456) is behind"',
    );
  });

  test("marks an approval row so that the focus can return to it", () => {
    expect(render([approval(3)])).toContain('data-row="approval:3"');
  });

  test("marks a failure row so that the focus can return to it", () => {
    expect(render([failure()])).toContain('data-row="failure:7"');
  });

  test("marks a notice row so that the focus can return to it", () => {
    expect(render([notice(21, SHA_A)])).toContain('data-row="notice:21"');
  });
});

describe("InboxList groups", () => {
  const pair = [notice(1, SHA_A), notice(2, SHA_B)];

  test("folds same-kind notices into one row with their count", () => {
    expect(render(pair)).toContain(">2件<");
  });

  test("starts a group closed", () => {
    expect(render(pair)).toContain('aria-expanded="false"');
  });

  test("hides the notices of a closed group", () => {
    expect(render(pair)).not.toContain('data-row="notice:1"');
  });

  test("leaves a lone notice without a group row", () => {
    expect(render([notice(1, SHA_A)])).not.toContain("aria-expanded");
  });

  test("leaves an approval without a group row", () => {
    expect(render([approval(1), approval(2)])).not.toContain("aria-expanded");
  });

  test("opens the group that holds the selected notice", () => {
    expect(render(pair, pair, { type: "notice", id: 2 })).toContain(
      'aria-expanded="true"',
    );
  });

  test("shows the notices of an open group", () => {
    expect(render(pair, pair, { type: "notice", id: 2 })).toContain(
      'data-row="notice:1"',
    );
  });

  test("marks the selected notice inside an open group", () => {
    expect(render(pair, pair, { type: "notice", id: 2 })).toContain(
      'data-row="notice:2" aria-current="true"',
    );
  });

  test("links the toggle to the list it opens", () => {
    const html = render(pair, pair, { type: "notice", id: 2 });
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${controls}"`);
  });

  test("leaves the kind label off the notices under a group", () => {
    const rows = [approval(), ...pair];
    expect(
      render(rows, rows, { type: "notice", id: 2 }).match(/>通知</g)?.length,
    ).toBe(1);
  });
});
