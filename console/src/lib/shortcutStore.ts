// 1文字のショートカットを有効にするかの保存。読めない環境と読めない値では有効のままにする。
// 無効にする切り替えは、1文字のショートカットを止められるようにするために置く。

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const SHORTCUTS_STORAGE_KEY = "factory-console.shortcuts";

const OFF = "off";

/** 保存された値を有効かどうかにする。無効を表す値だけを無効とする。 */
export function parseShortcutsEnabled(value: unknown): boolean {
  return value !== OFF;
}

export function readShortcutsEnabled(storage: StorageLike | null): boolean {
  try {
    return parseShortcutsEnabled(storage?.getItem(SHORTCUTS_STORAGE_KEY));
  } catch {
    return true;
  }
}

/** 保存できない環境でも、この画面の切り替えは行われている。 */
export function writeShortcutsEnabled(
  storage: StorageLike | null,
  enabled: boolean,
): void {
  try {
    if (enabled) {
      storage?.removeItem(SHORTCUTS_STORAGE_KEY);
    } else {
      storage?.setItem(SHORTCUTS_STORAGE_KEY, OFF);
    }
  } catch {
    // 保存できなくても、この画面の切り替えはすでに行われている。
  }
}
