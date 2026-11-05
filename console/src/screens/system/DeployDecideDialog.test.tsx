import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeployDecisionRequest } from "./DeployApprovalsPanel.tsx";
import { DeployDecideDialog } from "./DeployDecideDialog.tsx";

const ITEM = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  requestedAt: "2026-11-05T01:00:00.000Z",
  paths: ["f/factory/self_update.ts"],
  hiddenPathCount: 0,
};

function render(request: DeployDecisionRequest | null): string {
  return renderToStaticMarkup(
    <DeployDecideDialog
      request={request}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

describe("DeployDecideDialog", () => {
  test("asks about an approval", () => {
    expect(render({ item: ITEM, decision: "approve" })).toContain(
      "この版の反映を承認しますか",
    );
  });

  test("asks about a rejection", () => {
    expect(render({ item: ITEM, decision: "reject" })).toContain(
      "この版の反映を却下しますか",
    );
  });

  test("tells that an approval deploys within two minutes", () => {
    expect(render({ item: ITEM, decision: "approve" })).toContain("2分以内");
  });

  test("tells that a rejection needs a pull request that undoes the change", () => {
    expect(render({ item: ITEM, decision: "reject" })).toContain(
      "mainへ戻すPR",
    );
  });

  test("points the dialog at the paragraph that explains the effect", () => {
    const html = render({ item: ITEM, decision: "approve" });
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(html).toMatch(new RegExp(`<p[^>]* id="${describedBy}"`));
  });

  test("asks nothing when no decision is chosen", () => {
    expect(render(null)).not.toContain("しますか");
  });
});
