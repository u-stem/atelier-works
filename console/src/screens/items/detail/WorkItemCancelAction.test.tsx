import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WORK_ITEM_CANCEL_CONFIRM,
  WorkItemCancelAction,
  WorkItemCancelDialog,
} from "./WorkItemCancelAction.tsx";

function renderAction(kind: string, status: string) {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WorkItemCancelAction workItemId={7} kind={kind} status={status} />
    </QueryClientProvider>,
  );
}

function renderDialog(open: boolean, status = "awaiting_approval") {
  return renderToStaticMarkup(
    <WorkItemCancelDialog
      open={open}
      workItemId={7}
      kind="issue"
      status={status}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

describe("WorkItemCancelAction", () => {
  test("offers to cancel a work item in a state on the table", () => {
    expect(renderAction("issue", "awaiting_approval")).toContain(
      "作業項目を中止",
    );
  });

  test("offers to cancel an Issue whose flow is running", () => {
    expect(renderAction("issue", "implementing")).toContain("作業項目を中止");
  });

  test("renders nothing for a work item whose flow runs and that the table does not allow", () => {
    expect(renderAction("pr_fix", "fixing")).toBe("");
  });

  test("renders nothing for an Issue whose pull request is open", () => {
    expect(renderAction("issue", "pr_open")).toBe("");
  });

  test("renders nothing for a work item that is already cancelled", () => {
    expect(renderAction("pr_fix", "cancelled")).toBe("");
  });
});

describe("WorkItemCancelDialog", () => {
  test("asks whether to cancel the work item", () => {
    expect(renderDialog(true)).toContain("この作業項目を中止しますか");
  });

  test("names the work item", () => {
    expect(renderDialog(true)).toContain("#7");
  });

  // 色はConfirmDialogが決める。ここでは、破壊的な確認として渡していることだけを確かめる。
  test("confirms as a destructive action", () => {
    expect(WORK_ITEM_CANCEL_CONFIRM.destructive).toBe(true);
  });

  test("confirms with the button that says it cancels", () => {
    expect(renderDialog(true)).toContain(">中止する<");
  });

  // 「取り消す」は、作業項目を取り消す操作と読み違えるので、このダイアログでは「閉じる」にする。
  test("offers to back out with the button that says it closes", () => {
    expect(renderDialog(true)).toContain(">閉じる<");
  });

  test("does not label the button that backs out as a cancel", () => {
    expect(renderDialog(true)).not.toContain(">取り消す<");
  });

  test("says that a cancelled work item cannot be resumed", () => {
    expect(renderDialog(true)).toContain("再開できません");
  });

  test("warns about the running job when the Issue is being implemented", () => {
    expect(renderDialog(true, "implementing")).toContain(
      "「ジョブの中止」は押さないでください",
    );
  });

  test("does not warn about a running job for an Issue that waits for an approval", () => {
    expect(renderDialog(true)).not.toContain("「ジョブの中止」");
  });

  test("has no body while it is closed", () => {
    expect(renderDialog(false)).not.toContain("再開できません");
  });
});
