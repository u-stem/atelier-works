// 前のstepの結果のうち、Claudeの出力や外から来た文字列を含む値を、次のstepの引数で受け取るための部品。
// Windmillは、ジョブの引数の文字列が`$var:`、`$jsonvar:`、`$res:`、`$encrypted:`で始まるとき、ジョブの権限で解決する。
// 解決は引数ごとに働き、オブジェクトの中の文字列にも及ぶ(深さ50まで)。値をオブジェクトで包んでも守りにならない。
// そこで、flow.yamlの式で値全体をJSONの文字列にして渡す。式の`.replace(/\$/g, "\\u0024")`が、JSONの`$`をすべてUnicodeのエスケープに置き換えるので、
// 引数のどこにも`$`が現れない。受け取るstepは、ここの部品で文字列を戻し、型ガードで形を確かめる。
// 戻せない値は、値を載せずに例外にする。決まった失敗なので、flowの再試行の印を付ける。

import { NO_FLOW_RETRY_MARKER } from "./flow_retry_marker.ts";
import { isNumber, isRecord } from "./types.ts";

/** 値を型`T`に絞り込む型ガード。 */
export type Guard<T> = (value: unknown) => value is T;

/** `isShape`が返す型ガード。確かめるキーの一覧と、最初に合わなかったキーを返す関数を持つ。 */
export type ShapeGuard<T> = Guard<T> & {
  readonly keys: readonly string[];
  /** 最初に合わなかったキー。値がオブジェクトでなければ空の文字列。すべて合えば`null`。 */
  readonly firstMismatch: (value: unknown) => string | null;
};

function failure(label: string, message: string): Error {
  return new Error(`${NO_FLOW_RETRY_MARKER} ${label}: ${message}`);
}

/**
 * 引数の文字列をJSONとして読み、`guard`を通った値を返す。
 * 読めないときと形が違うときは、値を載せずに例外を投げる。形が違うときは、合わなかったキーの名前だけを載せる。
 * 古い定義のflowが、包まない引数で呼ぶと、文字列でないので例外になる。ここで止めて、包まない値を使わない。
 */
export function parseUntrustedArg<T>(
  text: unknown,
  label: string,
  guard: Guard<T> | ShapeGuard<T>,
): T {
  if (typeof text !== "string") {
    throw failure(label, "expected the sealed JSON text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw failure(label, "the sealed text is not valid JSON");
  }
  if (!guard(parsed)) {
    const key = "firstMismatch" in guard ? guard.firstMismatch(parsed) : null;
    const where = key === null || key === "" ? "the top level" : `"${key}"`;
    throw failure(
      label,
      `the sealed value has an unexpected shape at ${where}`,
    );
  }
  return parsed;
}

/** 要素がすべて`guard`を通る配列。 */
export function isArrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] =>
    Array.isArray(value) && value.every((item) => guard(item));
}

/** `null`か、`guard`を通る値。 */
export function isNullOr<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value);
}

/** `expected`と等しい文字列。 */
export function isLiteral<T extends string>(expected: T): Guard<T> {
  return (value): value is T => value === expected;
}

/** 有限の数か`null`。 */
export const isNumberOrNull: Guard<number | null> = isNullOr(isNumber);

/** 文字列か`null`。 */
export const isStringOrNull: Guard<string | null> = isNullOr(
  (value): value is string => typeof value === "string",
);

type GuardedType<G> = G extends Guard<infer T> ? T : never;

/** 各キーが、対応する`guard`を通るオブジェクト。余分なキーは許す。 */
export function isShape<S extends Record<string, Guard<unknown>>>(
  shape: S,
): ShapeGuard<{ [K in keyof S]: GuardedType<S[K]> }> {
  const keys = Object.keys(shape);
  const firstMismatch = (value: unknown): string | null => {
    if (!isRecord(value)) return "";
    return (
      keys.find((key) => {
        const guard = shape[key];
        return guard === undefined || !guard(value[key]);
      }) ?? null
    );
  };
  const guard = (
    value: unknown,
  ): value is { [K in keyof S]: GuardedType<S[K]> } =>
    firstMismatch(value) === null;
  return Object.assign(guard, { keys, firstMismatch });
}
