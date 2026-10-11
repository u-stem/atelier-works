import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SummaryApproval,
  SummaryNotice,
} from "../../api/guards/summary.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
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

function approval(): InboxItem {
  const row: SummaryApproval = {
    approval_request_id: 1,
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

/** `items`を描く。`allItems`は絞り込む前の全体で、省くと`items`と同じにする。 */
function render(
  items: readonly InboxItem[],
  allItems: readonly InboxItem[] = items,
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <InboxList
        items={items}
        selected={null}
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
    expect(render([notice(1, SHA_A), notice(2, SHA_B)])).toContain(
      "版 fedcba9",
    );
  });

  test("carries the whole body of a notice in the title of the sub label", () => {
    expect(render([notice(1, `deployed(${SHA_A}) is behind`)])).toContain(
      'title="deployed(0123456) is behind"',
    );
  });
});
