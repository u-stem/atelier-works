// GitHubの所有者のリポジトリの状態を集めて、DBに書くscript。5分ごとに、tag periodicのworkerで動く。
// 集める内容と判定は`./lib/gh_collect.ts`と`./lib/gh_collect_support.ts`にあり、このファイルは入出力をつなぐだけ。
// 読むsecretは、所有者ごとの読み取り専用のトークンの対応表`github_read_tokens`だけ。
// 書き込みのできる`github_token`は読まない。通信先は`./lib/gh_graphql.ts`が固定している。
// 設定の`gh_collect_enabled`が偽の間は、トークンを読まず、何も書かずに終わる。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  finishGhCollectRun,
  insertGhCollectRuns,
  listGhCollectOwnerStates,
  listGhRepos,
  replaceGhRepoSnapshot,
} from "./lib/db.ts";
import { type GhCollectResult, runGhCollect } from "./lib/gh_collect.ts";
import { graphqlRequest, OWNER_REPOS_QUERY } from "./lib/gh_graphql.ts";
import { logger } from "./lib/log.ts";

export async function main(): Promise<GhCollectResult> {
  const log = logger("collect_github");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  return await runGhCollect({
    config,
    nowMs: () => Date.now(),
    readTokenVariable: () => wmill.getVariable("f/factory/github_read_tokens"),
    insertRuns: (owners) => insertGhCollectRuns(owners),
    finishRun: (id, outcome) => finishGhCollectRun(id, outcome),
    listOwnerStates: (owners) => listGhCollectOwnerStates(owners),
    listRepos: (owner) => listGhRepos(owner),
    replaceSnapshot: (snapshot) => replaceGhRepoSnapshot(snapshot),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    request: ({ token, variables, timeoutMs }) =>
      graphqlRequest({ fetch, token, timeoutMs }, OWNER_REPOS_QUERY, variables),
    log,
  });
}
