// 節のテストが使う、クエリの結果の偽物。

import type { SectionQuery } from "./sectionQuery.ts";

/** 取得できた値を持ち、取り直しに失敗した状態。 */
export function staleQuery<T>(
  data: T,
  error: unknown,
  isFetching = false,
): SectionQuery<T> {
  return {
    data,
    isError: true,
    error,
    isFetching,
    refetch: () => Promise.resolve(undefined),
  };
}

/** 取得できた値を持ち、失敗していない状態。 */
export function freshQuery<T>(data: T): SectionQuery<T> {
  return {
    data,
    isError: false,
    error: null,
    isFetching: false,
    refetch: () => Promise.resolve(undefined),
  };
}
