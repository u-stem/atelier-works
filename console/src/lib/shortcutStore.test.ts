import { describe, expect, test } from "bun:test";
import {
  parseShortcutsEnabled,
  readShortcutsEnabled,
  SHORTCUTS_STORAGE_KEY,
  type StorageLike,
  shortcutsEnabledFromStorageEvent,
  writeShortcutsEnabled,
} from "./shortcutStore.ts";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  readonly data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const BROKEN: StorageLike = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

describe("shortcutStore", () => {
  test("reads a missing localStorage as disabled", () => {
    expect(readShortcutsEnabled(null)).toBe(false);
  });

  test("reads a missing value as disabled", () => {
    expect(readShortcutsEnabled(memoryStorage())).toBe(false);
  });

  test("reads a broken localStorage as disabled", () => {
    expect(readShortcutsEnabled(BROKEN)).toBe(false);
  });

  test("reads the saved on value as enabled", () => {
    expect(
      readShortcutsEnabled(memoryStorage({ [SHORTCUTS_STORAGE_KEY]: "on" })),
    ).toBe(true);
  });

  test("reads an unknown value as disabled", () => {
    expect(
      readShortcutsEnabled(memoryStorage({ [SHORTCUTS_STORAGE_KEY]: "maybe" })),
    ).toBe(false);
  });

  test("parses a non-string as disabled", () => {
    expect(parseShortcutsEnabled(42)).toBe(false);
  });

  test("saves enabled as the on value", () => {
    const storage = memoryStorage();
    writeShortcutsEnabled(storage, true);
    expect(storage.data.get(SHORTCUTS_STORAGE_KEY)).toBe("on");
  });

  test("clears the saved value when disabled again", () => {
    const storage = memoryStorage({ [SHORTCUTS_STORAGE_KEY]: "on" });
    writeShortcutsEnabled(storage, false);
    expect(storage.data.has(SHORTCUTS_STORAGE_KEY)).toBe(false);
  });

  test("does not throw when saving fails", () => {
    expect(() => {
      writeShortcutsEnabled(BROKEN, true);
    }).not.toThrow();
  });
});

describe("shortcutsEnabledFromStorageEvent", () => {
  test("turns on when another tab saves the on value", () => {
    expect(
      shortcutsEnabledFromStorageEvent({
        key: SHORTCUTS_STORAGE_KEY,
        newValue: "on",
      }),
    ).toBe(true);
  });

  test("turns off when another tab clears the value", () => {
    expect(
      shortcutsEnabledFromStorageEvent({
        key: SHORTCUTS_STORAGE_KEY,
        newValue: null,
      }),
    ).toBe(false);
  });

  test("turns off when another tab clears the whole storage", () => {
    expect(
      shortcutsEnabledFromStorageEvent({ key: null, newValue: null }),
    ).toBe(false);
  });

  test("ignores a change to another key", () => {
    expect(
      shortcutsEnabledFromStorageEvent({
        key: "factory-console.sidebar",
        newValue: "1",
      }),
    ).toBeNull();
  });
});
