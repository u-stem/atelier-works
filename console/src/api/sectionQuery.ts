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
  /** 最後に取得できた時刻(ミリ秒)。まだ取得できていなければ0。報告しない結果は省く。 */
  readonly dataUpdatedAt?: number | undefined;
};

/**
 * 節が出す内容を決める取得の段階。
 * `loaded`は値がある状態で、取り直しに失敗していても値を出す。
 */
export type LoadPhase = "loaded" | "failed" | "loading";

export function loadPhaseOf(
  query: Pick<SectionQuery<unknown>, "data" | "isError">,
): LoadPhase {
  if (query.data !== undefined) {
    return "loaded";
  }
  return query.isError ? "failed" : "loading";
}
