import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AUDIT_KICKOFF_CONFIRM } from "../../lib/auditKickoff.ts";
import { KickoffConfirmDialog } from "./KickoffConfirmDialog.tsx";

const html = renderToStaticMarkup(
  <KickoffConfirmDialog
    open={false}
    onConfirm={() => undefined}
    onCancel={() => undefined}
  />,
);

describe("KickoffConfirmDialog", () => {
  test("shows the title", () => {
    expect(html).toContain(AUDIT_KICKOFF_CONFIRM.title);
  });

  test("labels the cancel button with the kickoff wording", () => {
    expect(html).toContain(`>${AUDIT_KICKOFF_CONFIRM.cancelLabel}</button>`);
  });

  test("labels the confirm button with the kickoff wording", () => {
    expect(html).toContain(`>${AUDIT_KICKOFF_CONFIRM.confirmLabel}</button>`);
  });

  test("is described by the description paragraph", () => {
    const id = /aria-describedby="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(html).toContain(`<p id="${id}"`);
  });

  test("shares the layout of ConfirmDialog", () => {
    expect(html).toContain('<div class="flex flex-col gap-4 p-6">');
  });

  test("uses shadow-raised", () => {
    expect(html).toMatch(/<dialog [^>]*class="[^"]*\bshadow-raised\b/);
  });
});
