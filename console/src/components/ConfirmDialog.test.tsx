import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

function confirmButton(
  props: { busy?: boolean; confirmDisabled?: boolean } = {},
): string {
  const html = renderToStaticMarkup(
    <ConfirmDialog
      open={false}
      title="確認"
      confirmLabel="実行する"
      onConfirm={() => undefined}
      onCancel={() => undefined}
      {...props}
    >
      {null}
    </ConfirmDialog>,
  );
  const found = html.match(/<button[^>]*>実行する<\/button>/);
  if (found === null) throw new Error("no confirm button");
  return found[0];
}

/** 属性としての`disabled`。クラス名の`disabled:`は数えない。 */
const DISABLED_ATTRIBUTE = /\sdisabled(?:=""|\s|>)/;

function dialogMarkup(
  props: { cancelLabel?: string; describedBy?: string } = {},
): string {
  return renderToStaticMarkup(
    <ConfirmDialog
      open={false}
      title="確認"
      confirmLabel="実行する"
      onConfirm={() => undefined}
      onCancel={() => undefined}
      {...props}
    >
      <p id="detail">本文</p>
    </ConfirmDialog>,
  );
}

describe("ConfirmDialog", () => {
  test("uses shadow-raised", () => {
    expect(dialogMarkup()).toMatch(
      /<dialog [^>]*class="[^"]*\bshadow-raised\b/,
    );
  });

  test("does not use shadow-md", () => {
    expect(dialogMarkup()).not.toMatch(
      /<dialog [^>]*class="[^"]*\bshadow-md\b/,
    );
  });

  test("labels the cancel button 取り消す by default", () => {
    expect(dialogMarkup()).toContain(">取り消す</button>");
  });

  test("labels the cancel button with cancelLabel", () => {
    expect(dialogMarkup({ cancelLabel: "やめる" })).toContain(
      ">やめる</button>",
    );
  });

  test("describes the dialog by the element describedBy points at", () => {
    expect(dialogMarkup({ describedBy: "detail" })).toContain(
      'aria-describedby="detail"',
    );
  });

  test("has no aria-describedby without describedBy", () => {
    expect(dialogMarkup()).not.toContain("aria-describedby");
  });
});

describe("ConfirmDialog confirm button", () => {
  test("is on by default", () => {
    expect(confirmButton()).not.toMatch(DISABLED_ATTRIBUTE);
  });

  test("is off while the operation is running", () => {
    expect(confirmButton({ busy: true })).toMatch(DISABLED_ATTRIBUTE);
  });

  test("is off while the input is not ready", () => {
    expect(confirmButton({ confirmDisabled: true })).toMatch(
      DISABLED_ATTRIBUTE,
    );
  });
});
