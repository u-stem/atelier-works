// システムの画面の見出しの更新ボタンと最終更新を、画面が持つ取得にまとめる。
// 保留と凍結の取得は、ほかの3つと同じ更新ボタンで取り直す。

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
}): RefreshStatus {
  return refreshStatusOfAll([
    queries.status,
    queries.deployments,
    queries.summary,
    queries.holds,
  ]);
}
