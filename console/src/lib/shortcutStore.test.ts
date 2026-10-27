import { describe, expect, test } from "bun:test";
import {
  parseShortcutsEnabled,
  readShortcutsEnabled,
  SHORTCUTS_STORAGE_KEY,
  type StorageLike,
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
  test("reads a missing localStorage as enabled", () => {
    expect(readShortcutsEnabled(null)).toBe(true);
  });

  test("reads a missing value as enabled", () => {
    expect(readShortcutsEnabled(memoryStorage())).toBe(true);
  });

  test("reads a broken localStorage as enabled", () => {
    expect(readShortcutsEnabled(BROKEN)).toBe(true);
  });

  test("reads the saved off value as disabled", () => {
    expect(
      readShortcutsEnabled(memoryStorage({ [SHORTCUTS_STORAGE_KEY]: "off" })),
    ).toBe(false);
  });

  test("reads an unknown value as enabled", () => {
    expect(
      readShortcutsEnabled(memoryStorage({ [SHORTCUTS_STORAGE_KEY]: "maybe" })),
    ).toBe(true);
  });

  test("parses a non-string as enabled", () => {
    expect(parseShortcutsEnabled(42)).toBe(true);
  });

  test("saves disabled as the off value", () => {
    const storage = memoryStorage();
    writeShortcutsEnabled(storage, false);
    expect(storage.data.get(SHORTCUTS_STORAGE_KEY)).toBe("off");
  });

  test("clears the saved value when enabled again", () => {
    const storage = memoryStorage({ [SHORTCUTS_STORAGE_KEY]: "off" });
    writeShortcutsEnabled(storage, true);
    expect(storage.data.has(SHORTCUTS_STORAGE_KEY)).toBe(false);
  });

  test("does not throw when saving fails", () => {
    expect(() => {
      writeShortcutsEnabled(BROKEN, false);
    }).not.toThrow();
  });
});
