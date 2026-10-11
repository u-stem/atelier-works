import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { UnlistedCount } from "../../lib/inboxView.ts";
import { UnlistedCards } from "./UnlistedCards.tsx";

const AUDIT: UnlistedCount = {
  type: "failure",
  label: "監査の失敗",
  count: 3,
  cause: "audit",
};
const APPROVAL: UnlistedCount = { type: "approval", label: "承認", count: 2 };

function render(entries: readonly UnlistedCount[], compact: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <UnlistedCards entries={entries} compact={compact} />
    </MemoryRouter>,
  );
}

describe("UnlistedCards", () => {
  test("links an audit failure to the system screen", () => {
    expect(render([AUDIT], true)).toContain('href="/system"');
  });

  test("links a card of the full form to the system screen", () => {
    expect(render([AUDIT], false)).toContain('href="/system"');
  });

  test("tells where the link leads", () => {
    expect(render([AUDIT], true)).toContain(
      "監査の失敗 3件。システムの画面で確認する",
    );
  });

  test("does not link approvals, which the system screen lacks", () => {
    expect(render([APPROVAL], true)).not.toContain("<a ");
  });
});
