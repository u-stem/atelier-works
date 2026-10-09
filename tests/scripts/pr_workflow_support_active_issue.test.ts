// 稼働中のIssueの一意インデックスへの違反を、人が読む文にする規則のテスト。
// 承認の後の実装への移行が失敗したときに、この文が使われる。
// 現在のサイクルが別にあるので、この作業項目は再開できない。

import { describe, expect, test } from "bun:test";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const RAW =
  'duplicate key value violates unique constraint "work_items_active_issue_key"';

describe("the active issue index violation", () => {
  test("is described as another cycle being active", () => {
    expect(describeReason(RAW)).toBe("同じIssueで、別のサイクルが稼働中です");
  });

  test("asks for no action and says to follow the current cycle", () => {
    expect(nextActionFor(RAW)).toBe(
      "操作は要りません。この作業項目は再開できないので、このIssueの現在のサイクルの作業項目に従ってください",
    );
  });
});
