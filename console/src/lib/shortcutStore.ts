// 1文字のショートカットを有効にするかの保存。
// 既定は無効で、読めない環境と読めない値でも無効にする。

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const SHORTCUTS_STORAGE_KEY = "factory-console.shortcuts";

export function parseShortcutsEnabled(_value: unknown): boolean {
  return true;
}

export function readShortcutsEnabled(_storage: StorageLike | null): boolean {
  return true;
}

export function writeShortcutsEnabled(
  _storage: StorageLike | null,
  _enabled: boolean,
): void {}

export function shortcutsEnabledFromStorageEvent(_event: {
  readonly key: string | null;
  readonly newValue: string | null;
}): boolean | null {
  return null;
}
