import { describe, expect, test } from "bun:test";
import { noticeMoveReason, shouldMoveToNotice } from "./noticeFocus.ts";

describe("noticeMoveReason", () => {
  test("says shown when the tab becomes visible while a notice is kept", () => {
    expect(
      noticeMoveReason({ id: 3, visible: false }, { id: 3, visible: true }),
    ).toBe("shown");
  });

  test("says arrived when a new notice comes while the tab is visible", () => {
    expect(
      noticeMoveReason({ id: 3, visible: true }, { id: 4, visible: true }),
    ).toBe("arrived");
  });

  test("says arrived for the first notice while the tab is visible", () => {
    expect(
      noticeMoveReason(
        { id: undefined, visible: true },
        { id: 1, visible: true },
      ),
    ).toBe("arrived");
  });

  test("says nothing while the same notice stays on a visible tab", () => {
    expect(
      noticeMoveReason({ id: 3, visible: true }, { id: 3, visible: true }),
    ).toBeNull();
  });

  test("says nothing while the tab is hidden, even if a new notice comes", () => {
    expect(
      noticeMoveReason({ id: 3, visible: false }, { id: 4, visible: false }),
    ).toBeNull();
  });

  test("says nothing when the tab becomes visible and there is no notice", () => {
    expect(
      noticeMoveReason(
        { id: undefined, visible: false },
        { id: undefined, visible: true },
      ),
    ).toBeNull();
  });
});

describe("shouldMoveToNotice", () => {
  const BODY = { name: "body" };
  const TRIGGER = { name: "trigger" };
  const FILTER = { name: "filter" };

  function decide(
    reason: "shown" | "arrived" | null,
    active: unknown,
    trigger: unknown = TRIGGER,
  ): boolean {
    return shouldMoveToNotice({ reason, active, body: BODY, trigger });
  }

  test("moves to a notice that arrived while the focus is on the body", () => {
    expect(decide("arrived", BODY)).toBe(true);
  });

  test("moves to a notice that arrived while nothing has the focus", () => {
    expect(decide("arrived", null)).toBe(true);
  });

  test("moves to a notice that arrived while the focus is back on the button that opened the dialog", () => {
    expect(decide("arrived", TRIGGER)).toBe(true);
  });

  test("leaves the focus in another field when a notice arrives", () => {
    expect(decide("arrived", FILTER)).toBe(false);
  });

  test("leaves the focus when a notice arrives and no button opened a dialog", () => {
    expect(decide("arrived", FILTER, null)).toBe(false);
  });

  test("moves to a notice kept for a tab that became visible, wherever the focus is", () => {
    expect(decide("shown", FILTER)).toBe(true);
  });

  test("does not move when there is no reason", () => {
    expect(decide(null, BODY)).toBe(false);
  });
});
