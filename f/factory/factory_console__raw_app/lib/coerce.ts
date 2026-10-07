// `backend.console_query(...)`が返す`unknown`の値から項目を読む、緩い変換の関数群。
// 型が合わない値は例外にせず、安全な既定値に置き換える。
//
// リポジトリの通常の方針(Parse, don't validate)より、意図して緩くしている。
// `f/factory/lib/db.ts`や`f/factory/steps/console_query.ts`は不正な項目で例外を投げ、
// `console_query.ts`は返す前にすべての行を厳密に検査している。
// そのため、このAppに届いた値の項目がそれでも不正になるのは、
// ジョブ単位の失敗(通信や例外。try/catchで別に扱う)か、
// Appのバンドルの食い違いのときだけで、
// どちらも項目ごとに厳しく検査しても見つけやすくはならない。
// 既定値に置き換えれば、1つの項目のせいでタブ全体が空になることを防げる。

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean {
  return value === true;
}

export function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}
