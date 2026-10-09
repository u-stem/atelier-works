// 各画面の見出しに出す「最終更新」と再読み込みの状態。画面が自分のクエリから作って渡す。

export type RefreshStatus = {
  /** 最後に取得できた時刻(ミリ秒)。まだ取得できていなければ0。 */
  readonly updatedAt: number;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly onRefresh: () => void;
};

type RefreshableQuery = {
  readonly dataUpdatedAt: number;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly refetch: () => Promise<unknown>;
};

/** TanStack Queryの結果を、見出しが受け取る形にする。 */
export function refreshStatusOf(query: RefreshableQuery): RefreshStatus {
  return {
    updatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    isError: query.isError,
    onRefresh: () => {
      void query.refetch();
    },
  };
}
