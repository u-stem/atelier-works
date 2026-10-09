// 稼働中のIssueの一意インデックスへの違反と、その再実行の拒否を、
// 人が読む文にする規則のテスト。別のサイクルが稼働中なので、人の操作は要らない。

import { describe, expect, test } from "bun:test";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const RAW =
  'duplicate key value violates unique constraint "work_items_active_issue_key"';
const RETRY =
  "retry_work_item: another work item (id 9) is active for this Issue, retry after it finishes";

describe("the active issue index violation", () => {
  test("is described as another cycle being active", () => {
    expect(describeReason(RAW)).toBe("同じIssueで、別のサイクルが稼働中です");
  });

  test("asks for no action and says to wait for the active cycle", () => {
    expect(nextActionFor(RAW)).toBe(
      "操作は要りません。稼働中のサイクルの承認依頼か完了を待ってください",
    );
  });
});

describe("the retry refusal for an active issue", () => {
  test("is described as another cycle being active", () => {
    expect(describeReason(RETRY)).toBe("同じIssueで、別のサイクルが稼働中です");
  });

  test("says to wait for the active cycle, with or without the id", () => {
    const withoutId =
      "retry_work_item: another work item is active for this Issue, retry after it finishes";
    expect(nextActionFor(withoutId)).toBe(nextActionFor(RETRY));
  });
});
