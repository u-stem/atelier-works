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
