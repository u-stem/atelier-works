// 各画面の見出しに出す「最終更新」と再読み込みの状態。画面が自分のクエリから作って渡す。

import { ApiFailure, isBannerError } from "../api/errors.ts";

export type RefreshStatus = {
  /** 最後に取得できた時刻(ミリ秒)。まだ取得できていなければ0。 */
  readonly updatedAt: number;
  readonly isFetching: boolean;
  /** バナーが知らせる失敗(401)を除いた、見出しで知らせる失敗があるか。 */
  readonly isError: boolean;
  readonly onRefresh: () => void;
};

type RefreshableQuery = {
  readonly dataUpdatedAt: number;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => Promise<unknown>;
};

/**
 * TanStack Queryの結果を、見出しが受け取る形にする。
 * 401は画面上部のバナーが知らせるので、見出しの失敗には数えない。
 */
export function refreshStatusOf(query: RefreshableQuery): RefreshStatus {
  return {
    updatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    isError:
      query.isError &&
      !(
        query.error instanceof ApiFailure && isBannerError(query.error.apiError)
      ),
    onRefresh: () => {
      void query.refetch();
    },
  };
}
