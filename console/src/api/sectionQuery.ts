// 節が取得の状態を表示に変えるために読む、クエリの結果の最小の形。

/**
 * TanStack Queryの結果のうち、節が読むものだけ。
 * 節が結果の全体に依存しないので、テストは偽の結果を少ない項目で作れる。
 */
export type SectionQuery<T> = {
  readonly data: T | undefined;
  readonly isError: boolean;
  readonly error: unknown;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
};
