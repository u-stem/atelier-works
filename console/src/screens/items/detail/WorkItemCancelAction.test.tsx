import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
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

function renderDialog(open: boolean) {
  return renderToStaticMarkup(
    <WorkItemCancelDialog
      open={open}
      workItemId={7}
      kind="issue"
      status="awaiting_approval"
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

  test("renders nothing for a work item that is running", () => {
    expect(renderAction("issue", "implementing")).toBe("");
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

  test("confirms with the destructive button", () => {
    expect(renderDialog(true)).toMatch(/bg-destructive[^>]*>中止する</);
  });

  test("offers to back out with the button that takes the first focus", () => {
    expect(renderDialog(true)).toContain(">取り消す<");
  });

  test("says that a cancelled work item cannot be resumed", () => {
    expect(renderDialog(true)).toContain("再開できません");
  });

  test("has no body while it is closed", () => {
    expect(renderDialog(false)).not.toContain("再開できません");
  });
});
