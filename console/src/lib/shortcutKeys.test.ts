import { describe, expect, test } from "bun:test";
import {
  CHORD_IDLE,
  type ChordState,
  GO_WAIT_MS,
  isComposingKey,
  isPaletteKey,
  isTypingTarget,
  type KeyEventLike,
  keyboardGate,
  platformOf,
  type ShortcutEnv,
  shortcutRows,
  stepShortcut,
} from "./shortcutKeys.ts";

const TARGETS = [
  { key: "i", id: "inbox" },
  { key: "w", id: "items" },
  { key: "r", id: "reports" },
  { key: "j", id: "jobs" },
  { key: "s", id: "system" },
] as const;

type Id = (typeof TARGETS)[number]["id"];

function press(
  key: string,
  override: Partial<KeyEventLike> = {},
): KeyEventLike {
  return {
    key,
    keyCode: 0,
    isComposing: false,
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...override,
  };
}

function env(override: Partial<ShortcutEnv<Id>> = {}): ShortcutEnv<Id> {
  return {
    now: 0,
    enabled: true,
    typing: false,
    targets: TARGETS,
    ...override,
  };
}

const AFTER_G: ChordState = { goAt: 0 };

describe("isComposingKey", () => {
  test("ignores the Enter that confirms the IME", () => {
    expect(isComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  test("treats keyCode 229 as composing even without isComposing", () => {
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  test("does not treat a plain Enter as composing", () => {
    expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("platformOf", () => {
  test("detects a Mac", () => {
    expect(platformOf({ platform: "MacIntel", userAgent: "" })).toBe("mac");
  });

  test("detects an iPad that reports itself in the user agent", () => {
    expect(platformOf({ platform: "", userAgent: "iPad; CPU OS 18" })).toBe(
      "mac",
    );
  });

  test("treats Windows as another platform", () => {
    expect(platformOf({ platform: "Win32", userAgent: "Windows NT" })).toBe(
      "other",
    );
  });
});

describe("paletteKey", () => {
  const base = {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };

  test("uses meta on mac", () => {
    expect(isPaletteKey({ ...base, key: "k", metaKey: true }, "mac")).toBe(
      true,
    );
  });

  test("does not take ctrl on mac, which edits text in inputs", () => {
    expect(isPaletteKey({ ...base, key: "k", ctrlKey: true }, "mac")).toBe(
      false,
    );
  });

  test("uses ctrl elsewhere", () => {
    expect(isPaletteKey({ ...base, key: "k", ctrlKey: true }, "other")).toBe(
      true,
    );
  });

  test("does not take meta elsewhere", () => {
    expect(isPaletteKey({ ...base, key: "k", metaKey: true }, "other")).toBe(
      false,
    );
  });

  test("accepts a capital K from Caps Lock", () => {
    expect(isPaletteKey({ ...base, key: "K", ctrlKey: true }, "other")).toBe(
      true,
    );
  });

  test("rejects another letter", () => {
    expect(isPaletteKey({ ...base, key: "j", ctrlKey: true }, "other")).toBe(
      false,
    );
  });

  test("rejects the key with Alt", () => {
    expect(
      isPaletteKey({ ...base, key: "k", ctrlKey: true, altKey: true }, "other"),
    ).toBe(false);
  });
});

describe("isTypingTarget", () => {
  test.each(["INPUT", "TEXTAREA", "SELECT"])("is true for %s", (tagName) => {
    expect(isTypingTarget({ tagName })).toBe(true);
  });

  test("is true for contenteditable", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  test("is false for a button", () => {
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
  });

  test("is false without a target", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("keyboardGate", () => {
  test("is free when no dialog is open", () => {
    expect(keyboardGate([])).toBe("free");
  });

  test("leaves only the palette key when the palette itself is open", () => {
    expect(keyboardGate([{ isPalette: true }])).toBe("palette-only");
  });

  test("blocks everything when another dialog is open", () => {
    expect(keyboardGate([{ isPalette: false }])).toBe("blocked");
  });

  test("blocks everything when another dialog is open over the palette", () => {
    expect(keyboardGate([{ isPalette: true }, { isPalette: false }])).toBe(
      "blocked",
    );
  });
});

describe("shortcutFor", () => {
  test("waits for the next key after g", () => {
    expect(stepShortcut(CHORD_IDLE, press("g"), env({ now: 5 })).state).toEqual(
      { goAt: 5 },
    );
  });

  test("maps g then j to the jobs screen", () => {
    expect(stepShortcut(AFTER_G, press("j"), env({ now: 10 })).action).toEqual({
      kind: "go",
      id: "jobs",
    });
  });

  test.each(TARGETS)("maps g then $key to $id", ({ key, id }) => {
    expect(stepShortcut(AFTER_G, press(key), env({ now: 10 })).action).toEqual({
      kind: "go",
      id,
    });
  });

  test("returns to idle after a go", () => {
    expect(stepShortcut(AFTER_G, press("j"), env({ now: 10 })).state).toEqual(
      CHORD_IDLE,
    );
  });

  test("gives up g after one second", () => {
    expect(
      stepShortcut(AFTER_G, press("j"), env({ now: GO_WAIT_MS + 1 })).action,
    ).toBeNull();
  });

  test("still accepts the key exactly at the limit", () => {
    expect(
      stepShortcut(AFTER_G, press("j"), env({ now: GO_WAIT_MS })).action,
    ).toEqual({ kind: "go", id: "jobs" });
  });

  test("cancels g when another key follows", () => {
    expect(stepShortcut(AFTER_G, press("x"), env({ now: 10 })).state).toEqual(
      CHORD_IDLE,
    );
  });

  test("does nothing for a key that cancels g", () => {
    expect(
      stepShortcut(AFTER_G, press("x"), env({ now: 10 })).action,
    ).toBeNull();
  });

  test("keeps waiting when only Shift is pressed after g", () => {
    expect(
      stepShortcut(
        AFTER_G,
        press("Shift", { shiftKey: true }),
        env({ now: 10 }),
      ).state,
    ).toEqual(AFTER_G);
  });

  test("ignores an auto-repeated g", () => {
    expect(
      stepShortcut(CHORD_IDLE, press("g", { repeat: true }), env()).state,
    ).toEqual(CHORD_IDLE);
  });

  test("accepts ? with Shift to open the help", () => {
    expect(
      stepShortcut(CHORD_IDLE, press("?", { shiftKey: true }), env()).action,
    ).toEqual({ kind: "help" });
  });

  test.each(["ctrlKey", "altKey", "metaKey"] as const)(
    "ignores j with %s after g",
    (modifier) => {
      expect(
        stepShortcut(
          AFTER_G,
          press("j", { [modifier]: true }),
          env({ now: 10 }),
        ).action,
      ).toBeNull();
    },
  );

  test("ignores Alt+T, which belongs to the notifications", () => {
    expect(
      stepShortcut(CHORD_IDLE, press("t", { altKey: true }), env()).action,
    ).toBeNull();
  });

  test("ignores ? with Ctrl", () => {
    expect(
      stepShortcut(CHORD_IDLE, press("?", { ctrlKey: true }), env()).action,
    ).toBeNull();
  });

  test("ignores keys while typing in a field", () => {
    expect(
      stepShortcut(CHORD_IDLE, press("?"), env({ typing: true })).action,
    ).toBeNull();
  });

  test("drops a pending g when focus moves into a field", () => {
    expect(
      stepShortcut(AFTER_G, press("j"), env({ now: 10, typing: true })).state,
    ).toEqual(CHORD_IDLE);
  });

  test("ignores keys while composing", () => {
    expect(
      stepShortcut(CHORD_IDLE, press("?", { isComposing: true }), env()).action,
    ).toBeNull();
  });

  test("stays off when disabled", () => {
    expect(
      stepShortcut(AFTER_G, press("j"), env({ now: 10, enabled: false }))
        .action,
    ).toBeNull();
  });

  test("does not open the help with ? when disabled", () => {
    expect(
      stepShortcut(CHORD_IDLE, press("?"), env({ enabled: false })).action,
    ).toBeNull();
  });

  test("takes the browser default only for the keys it uses", () => {
    expect(stepShortcut(CHORD_IDLE, press("x"), env()).consumed).toBe(false);
  });

  test("takes the browser default for a go", () => {
    expect(stepShortcut(AFTER_G, press("j"), env({ now: 10 })).consumed).toBe(
      true,
    );
  });
});

describe("shortcutRows", () => {
  const screens = [
    { label: "要対応", shortcut: "i" },
    { label: "ジョブ", shortcut: "j" },
  ];

  test("lists the palette key with the platform's modifier", () => {
    expect(shortcutRows(screens, "mac")[0]?.keys).toEqual(["⌘", "K"]);
  });

  test("uses Ctrl elsewhere", () => {
    expect(shortcutRows(screens, "other")[0]?.keys).toEqual(["Ctrl", "K"]);
  });

  test("lists the help key", () => {
    expect(
      shortcutRows(screens, "other").map((row) => row.keys),
    ).toContainEqual(["?"]);
  });

  test("builds the screen rows from the table, in order", () => {
    expect(
      shortcutRows(screens, "other")
        .filter((row) => row.keys[0] === "g")
        .map((row) => [row.keys[1], row.description]),
    ).toEqual([
      ["i", "要対応へ移る"],
      ["j", "ジョブへ移る"],
    ]);
  });

  test("reads the g chord as a sequence", () => {
    expect(
      shortcutRows(screens, "other").find((row) => row.keys[0] === "g")
        ?.separator,
    ).toBe("の次に");
  });
});
