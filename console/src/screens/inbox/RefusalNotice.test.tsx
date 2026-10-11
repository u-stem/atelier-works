import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRefusal } from "../../lib/approvalRefusal.ts";
import { RefusalNotice } from "./RefusalNotice.tsx";

const REFUSAL: DecisionRefusal = {
  kind: "changed",
  message: "Issueが書き換えられているため、承認は記録されていません。",
  actions: ["Issueを元に戻して承認し直す。", "現在のIssueを使うなら却下する。"],
};

function render(refusal: DecisionRefusal = REFUSAL): string {
  return renderToStaticMarkup(<RefusalNotice refusal={refusal} />);
}

describe("RefusalNotice", () => {
  test("shows why the decision was refused", () => {
    expect(render()).toContain(REFUSAL.message);
  });

  test("lists the first thing the approver can do", () => {
    expect(render()).toContain("Issueを元に戻して承認し直す。");
  });

  test("lists the second thing the approver can do", () => {
    expect(render()).toContain("現在のIssueを使うなら却下する。");
  });

  test("announces itself as an alert", () => {
    expect(render()).toContain('role="alert"');
  });
});
