import { describe, expect, test } from "bun:test";
import { type DialogLike, syncDialog } from "./useDialogSync.ts";

function fakeDialog(initiallyOpen: boolean): {
  dialog: DialogLike;
  calls: string[];
} {
  const calls: string[] = [];
  let open = initiallyOpen;
  const dialog: DialogLike = {
    get open() {
      return open;
    },
    showModal() {
      open = true;
      calls.push("showModal");
    },
    close() {
      open = false;
      calls.push("close");
    },
  };
  return { dialog, calls };
}

describe("syncDialog", () => {
  test("opens a closed dialog as a modal when open is true", () => {
    const { dialog, calls } = fakeDialog(false);
    syncDialog(dialog, true);
    expect(calls).toEqual(["showModal"]);
  });

  test("closes an open dialog when open is false", () => {
    const { dialog, calls } = fakeDialog(true);
    syncDialog(dialog, false);
    expect(calls).toEqual(["close"]);
  });

  test("does not open a dialog that is already open", () => {
    const { dialog, calls } = fakeDialog(true);
    syncDialog(dialog, true);
    expect(calls).toEqual([]);
  });

  test("does not close a dialog that is already closed", () => {
    const { dialog, calls } = fakeDialog(false);
    syncDialog(dialog, false);
    expect(calls).toEqual([]);
  });

  test("calls onOpened after the dialog is shown", () => {
    const { dialog, calls } = fakeDialog(false);
    syncDialog(dialog, true, () => {
      calls.push("onOpened");
    });
    expect(calls).toEqual(["showModal", "onOpened"]);
  });

  test("does not call onOpened when the dialog was already open", () => {
    const { dialog, calls } = fakeDialog(true);
    syncDialog(dialog, true, () => {
      calls.push("onOpened");
    });
    expect(calls).toEqual([]);
  });

  test("does not call onOpened when closing", () => {
    const { dialog, calls } = fakeDialog(true);
    syncDialog(dialog, false, () => {
      calls.push("onOpened");
    });
    expect(calls).toEqual(["close"]);
  });
});
