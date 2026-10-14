// 空の要対応の面に渡す、一覧の取り直しの失敗。

export type RefreshFailure = {
  readonly error: unknown;
  readonly isFetching: boolean;
  readonly onRetry: () => void;
};

/**
 * 一覧の取り直しが失敗しているときだけ、面に渡す失敗を作る。
 * 失敗していなければ`null`を返す。
 */
export function refreshFailureOf(
  summary: {
    readonly isError: boolean;
    readonly error: unknown;
    readonly isFetching: boolean;
  },
  onRetry: () => void,
): RefreshFailure | null {
  return summary.isError
    ? { error: summary.error, isFetching: summary.isFetching, onRetry }
    : null;
}
