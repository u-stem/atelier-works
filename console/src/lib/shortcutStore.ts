// 1文字のショートカットを有効にするかの保存。読めない環境では有効のままにする。

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const SHORTCUTS_STORAGE_KEY = "factory-console.shortcuts";

export function parseShortcutsEnabled(_value: unknown): boolean {
  return false;
}

export function readShortcutsEnabled(_storage: StorageLike | null): boolean {
  return false;
}

export function writeShortcutsEnabled(
  _storage: StorageLike | null,
  _enabled: boolean,
): void {}
