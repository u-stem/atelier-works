// 節が取得の状態を表示に変えるために読む、クエリの結果の最小の形。

/** 取得の進み方。オフラインで止まっているときは`paused`になる。 */
export type SectionFetchStatus = "fetching" | "paused" | "idle";

/**
 * TanStack Queryの結果のうち、節が読むものだけ。
 * 節が結果の全体に依存しないので、テストは偽の結果を少ない項目で作れる。
 */
export type SectionQuery<T> = {
  readonly data: T | undefined;
  readonly isError: boolean;
  readonly error: unknown;
  readonly isFetching: boolean;
  /** 省略すると、止まっていない(`idle`か`fetching`)ものとして扱う。 */
  readonly fetchStatus?: SectionFetchStatus;
  readonly refetch: () => Promise<unknown>;
};

/**
 * 節が出す内容を決める取得の段階。
 * `loaded`は値がある状態で、取り直しに失敗していても値を出す。
 * `paused`は値が無く、オフラインで取得を待っている状態である。
 */
export type LoadPhase = "loaded" | "failed" | "paused" | "loading";

export function loadPhaseOf(
  _query: Pick<SectionQuery<unknown>, "data" | "isError" | "fetchStatus">,
): LoadPhase {
  return "loaded";
}
