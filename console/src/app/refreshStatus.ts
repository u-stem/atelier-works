// 各画面の見出しに出す「最終更新」と更新ボタンの状態。画面が自分のクエリから作って渡す。

import { ApiFailure, isBannerError } from "../api/errors.ts";

export type RefreshStatus = {
  /** 最後に取得できた時刻(ミリ秒)。まだ取得できていなければ0。 */
  readonly updatedAt: number;
  readonly isFetching: boolean;
  /** バナーが知らせる失敗(401)を除いた、見出しで知らせる失敗があるか。 */
  readonly isError: boolean;
  /**
   * 見出しに渡した取得を取り直す。
   * 要対応の画面は一覧(summary)だけで、詳細ペインの取得は含まない。
   */
  readonly onRefresh: () => void;
  /** 見出しに渡した取得のすべてが自動で取り直される間隔(ミリ秒)。そうでなければ`null`。 */
  readonly autoRefreshMs: number | null;
};

type RefreshableQuery = {
  readonly dataUpdatedAt: number;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => Promise<unknown>;
};

type RefreshOptions = {
  /** 見出しに渡す取得のすべてが、この間隔で自動で取り直されるときだけ渡す。 */
  readonly autoRefreshMs?: number;
};

/** 401は画面上部のバナーが知らせるので、見出しの失敗には数えない。 */
function isHeaderError(query: RefreshableQuery): boolean {
  return (
    query.isError &&
    !(query.error instanceof ApiFailure && isBannerError(query.error.apiError))
  );
}

/** TanStack Queryの結果を、見出しが受け取る形にする。 */
export function refreshStatusOf(
  query: RefreshableQuery,
  options: RefreshOptions = {},
): RefreshStatus {
  return refreshStatusOfAll([query], options);
}

/**
 * 画面が持つ複数の取得を、見出しの1つの更新ボタンと最終更新にまとめる。
 * 最終更新は、取得できた中で最も古い時刻にする。新しい取得の時刻を出すと、古いままの節を新しく見せるためである。
 * 取得中とその失敗は、どれか1つでもあれば立てる。更新は全部を取り直す。
 * 同じ取得を読む節があるときは、取得を1つにして渡す。同じものを重ねて渡すと、取り直しが互いを打ち切る。
 */
export function refreshStatusOfAll(
  queries: readonly RefreshableQuery[],
  options: RefreshOptions = {},
): RefreshStatus {
  const fetched = queries
    .map((query) => query.dataUpdatedAt)
    .filter((updatedAt) => updatedAt > 0);
  return {
    updatedAt: fetched.length === 0 ? 0 : Math.min(...fetched),
    isFetching: queries.some((query) => query.isFetching),
    isError: queries.some(isHeaderError),
    onRefresh: () => {
      for (const query of queries) {
        void query.refetch();
      }
    },
    autoRefreshMs: options.autoRefreshMs ?? null,
  };
}
