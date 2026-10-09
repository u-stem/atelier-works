// APIの応答を検証する型ガードの部品。値の形が違えば`false`を返し、補正や変換はしない。

export type Guard<T> = (value: unknown) => value is T;

/** 配列でも`null`でもないオブジェクト。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** 符号を問わない整数。JavaScriptで正確に表せる範囲に限る。 */
export function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number";
}

/** 1以上の整数。JavaScriptで正確に表せる範囲に限る。 */
export function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

/** 0以上の整数。JavaScriptで正確に表せる範囲に限る。 */
export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

/** `Date.parse`が読める文字列。時刻はISO 8601の文字列で受け取る。 */
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** `guard`を通る値か`null`。`undefined`(項目の欠落)は通さない。 */
export function isNullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value: unknown): value is T | null => value === null || guard(value);
}

/** 要素がすべて`guard`を通る配列。 */
export function isArrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] =>
    Array.isArray(value) && value.every((item) => guard(item));
}

/** `values`のどれかと等しい値。 */
export function isOneOf<T extends string>(values: readonly T[]): Guard<T> {
  return (value: unknown): value is T =>
    typeof value === "string" &&
    values.some((candidate) => candidate === value);
}

export const isNullableString = isNullable(isString);
export const isNullableInteger = isNullable(isInteger);
export const isNullableIsoTimestamp = isNullable(isIsoTimestamp);
