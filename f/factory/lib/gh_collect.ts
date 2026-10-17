// GitHubの収集の本体。依存を注入して、所有者ごとにリポジトリの一覧を読み、DBに書く。
// スタブ。

import type { GraphqlResponse } from "./gh_graphql.ts";
import type { Logger } from "./log.ts";
import type {
  FactoryConfig,
  GhCollectErrorCode,
  GhCollectOwnerState,
  GhCollectRunOutcome,
  GhRepo,
  GhRepoGone,
  GhRepoUpsert,
  NoticeRecord,
} from "./types.ts";

export type GhCollectConfig = Pick<
  FactoryConfig,
  | "owners"
  | "repo_allowlist"
  | "factory_repo"
  | "trigger_label"
  | "gh_collect_enabled"
>;

export type GhCollectDeps = {
  readonly config: GhCollectConfig;
  readonly nowMs: () => number;
  readonly readTokenVariable: () => Promise<string>;
  readonly insertRuns: (
    owners: readonly string[],
  ) => Promise<readonly { readonly owner: string; readonly id: number }[]>;
  readonly finishRun: (
    id: number,
    outcome: GhCollectRunOutcome,
  ) => Promise<boolean>;
  readonly listOwnerStates: (
    owners: readonly string[],
  ) => Promise<readonly GhCollectOwnerState[]>;
  readonly listRepos: (owner: string) => Promise<readonly GhRepo[]>;
  readonly replaceSnapshot: (snapshot: {
    readonly owner: string;
    readonly owner_id: number;
    readonly listed: readonly GhRepoUpsert[];
    readonly gone: readonly GhRepoGone[];
  }) => Promise<void>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
  readonly request: (args: {
    readonly token: string;
    readonly variables: Readonly<Record<string, unknown>>;
    readonly timeoutMs: number;
  }) => Promise<GraphqlResponse>;
  readonly log: Logger;
};

export type GhCollectOwnerResult = {
  readonly owner: string;
  readonly ok: boolean;
  readonly error_code: GhCollectErrorCode | null;
  readonly repos: number;
  readonly requests: number;
};

export type GhCollectResult = {
  readonly enabled: boolean;
  readonly owners: readonly GhCollectOwnerResult[];
};

export async function runGhCollect(
  _deps: GhCollectDeps,
): Promise<GhCollectResult> {
  return { enabled: false, owners: [] };
}
