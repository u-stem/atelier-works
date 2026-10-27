// 1文字のショートカットを有効にするかの保存。
// 既定は無効で、読めない環境と読めない値でも無効にする。
// 画面を移すキーは、まだ送っていない入力を失わせるので、使う人が有効にするまで働かせない。

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const SHORTCUTS_STORAGE_KEY = "factory-console.shortcuts";

const ON = "on";

/** 保存された値を有効かどうかにする。有効を表す値だけを有効とする。 */
export function parseShortcutsEnabled(value: unknown): boolean {
  return value === ON;
}

export function readShortcutsEnabled(storage: StorageLike | null): boolean {
  try {
    return parseShortcutsEnabled(storage?.getItem(SHORTCUTS_STORAGE_KEY));
  } catch {
    return false;
  }
}

/** 保存できない環境でも、この画面の切り替えは行われている。 */
export function writeShortcutsEnabled(
  storage: StorageLike | null,
  enabled: boolean,
): void {
  try {
    if (enabled) {
      storage?.setItem(SHORTCUTS_STORAGE_KEY, ON);
    } else {
      storage?.removeItem(SHORTCUTS_STORAGE_KEY);
    }
  } catch {
    // 保存できなくても、この画面の切り替えはすでに行われている。
  }
}

/**
 * 別のタブが保存領域を書き換えたときの、有効かどうか。関係の無い変更は`null`。
 * 全体を消した(`key`が`null`)ときと、この値を消したときは、既定の無効に戻る。
 */
export function shortcutsEnabledFromStorageEvent(event: {
  readonly key: string | null;
  readonly newValue: string | null;
}): boolean | null {
  if (event.key !== null && event.key !== SHORTCUTS_STORAGE_KEY) {
    return null;
  }
  return parseShortcutsEnabled(event.key === null ? null : event.newValue);
}
