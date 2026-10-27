// システムの画面の見出しの更新ボタンと最終更新を、画面が持つ取得にまとめる。
// 保留と凍結の取得は、ほかの3つと同じ更新ボタンで取り直す。
// 設定の取得は、設定のタブを開いた後だけ加える。開くまで取得しないものを、更新で取りに行かないためである。
// 設定は自動で取り直さないので、最終更新の最小の時刻には入れない。入れると、開いた後は見出しの時刻が設定の時刻で止まる。
// 取得中と失敗と更新の操作には、設定も含める。

import {
  type RefreshStatus,
  refreshStatusOfAll,
} from "../../app/refreshStatus.ts";

type Refreshable = Parameters<typeof refreshStatusOfAll>[0][number];

export function refreshStatusOfSystem(queries: {
  readonly status: Refreshable;
  readonly deployments: Refreshable;
  readonly summary: Refreshable;
  readonly holds: Refreshable;
  /** 設定の取得。タブをまだ開いていないときは`null`か省略する。 */
  readonly config?: Refreshable | null;
  /** 起動の関係の図の取得。図を開く前は`null`か省略する。 */
  readonly flowGraph?: readonly Refreshable[] | null;
}): RefreshStatus {
  const polled = [
    queries.status,
    queries.deployments,
    queries.summary,
    queries.holds,
  ];
  const config =
    queries.config === undefined || queries.config === null
      ? []
      : [queries.config];
  return {
    ...refreshStatusOfAll([...polled, ...config]),
    updatedAt: refreshStatusOfAll(polled).updatedAt,
  };
}
