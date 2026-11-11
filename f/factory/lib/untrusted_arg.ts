// 前のstepの結果のうち、Claudeの出力や外から来た文字列を含む値を、次のstepの引数で渡すための部品。
// Windmillは、ジョブの引数の`$var:`や`$res:`で始まる文字列を、実行者の権限で解決する。
// 文書によれば、解決は配列や入れ子のオブジェクトの中の文字列にも及ぶ(深さと件数に上限がある)。
// 値をオブジェクトで包んでも防げないので、flow.yamlの式で値全体をJSONの文字列にして渡し、受け取るstepで戻す。
// 式はJSONの`$`をすべて`$`に置き換える。引数のどこにも`$`が現れないので、
// 解決の規則(先頭だけに一致するか、文字列のどこでも一致するか)に依らない。
// 戻すときは形を型ガードで確かめ、値は例外の文にもログにも載せない。

import { isNumber, isRecord, isString } from "./types.ts";

/** 値を型`T`に絞り込む型ガード。 */
export type Guard<T> = (value: unknown) => value is T;

/**
 * flow.yamlの式が作る文字列と同じものを作る。式は`JSON.stringify(<値>).replace(/\$/g, "\\u0024")`の形である。
 * flowの定義を読むテストが、式とこの関数の出力が一致することを確かめる。
 */
export function sealUntrustedArg(value: unknown): string {
  return JSON.stringify(value).replace(/\$/g, "\\u0024");
}

/**
 * 引数の文字列をJSONとして読み、`guard`を通った値を返す。
 * 読めないときと形が違うときは、値を載せずに例外を投げる。
 * 古い定義のflowが、包まない引数で呼ぶと、文字列でないので例外になる。ここで止めて、包まない値を使わない。
 */
export function parseUntrustedArg<T>(
  text: unknown,
  label: string,
  guard: Guard<T>,
): T {
  if (typeof text !== "string") {
    throw new Error(`${label}: expected the sealed JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}: the sealed text is not valid JSON`);
  }
  if (!guard(parsed)) {
    throw new Error(`${label}: the sealed value has an unexpected shape`);
  }
  return parsed;
}

/** 要素がすべて`guard`を通る配列。 */
export function isArrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

/** `null`か、`guard`を通る値。 */
export function isNullOr<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value);
}

/** 有限の数か`null`。 */
export const isNumberOrNull: Guard<number | null> = isNullOr(isNumber);

/** 文字列か`null`。 */
export const isStringOrNull: Guard<string | null> = isNullOr(isString);

type GuardedType<G> = G extends Guard<infer T> ? T : never;

/** 各キーが、対応する`guard`を通るオブジェクト。余分なキーは許す。 */
export function isShape<S extends Record<string, Guard<unknown>>>(
  shape: S,
): Guard<{ [K in keyof S]: GuardedType<S[K]> }> {
  return (value): value is { [K in keyof S]: GuardedType<S[K]> } =>
    isRecord(value) &&
    Object.entries(shape).every(([key, guard]) => guard(value[key]));
}
