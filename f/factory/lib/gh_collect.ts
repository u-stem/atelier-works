// GitHubの収集の本体。依存を注入して、所有者ごとにリポジトリの一覧を読み、DBに書く。
// 所有者ごとに読み取り専用のトークンを使い、一覧を取り終えて照合が通ったときだけ、その所有者の記録を置き換える。
// GitHubの失敗は例外にせず、実行の行に失敗の種類だけを残す。ジョブ結果とログには、件数と失敗の種類しか載せない。

import {
  allowlistedRepos,
  carriedFailure,
  checkOwnerId,
  classifyGraphqlFailure,
  GH_COLLECT_DEADLINE_MS,
  GH_COLLECT_MIN_REQUEST_MS,
  lookupToken,
  type OwnerCheck,
  orderOwners,
  parseOwnerReposPage,
  parseTokenVariable,
  planGone,
  type RepoNode,
  selectTargets,
} from "./gh_collect_support.ts";
import {
  GRAPHQL_REQUEST_TIMEOUT_MS,
  type GraphqlResponse,
} from "./gh_graphql.ts";
import type { Logger } from "./log.ts";
import {
  OWNER_ID_MISMATCH_KIND,
  ownerIdMismatchMessage,
  ownerNotFoundMessage,
} from "./owner_id_notice.ts";
import type {
  FactoryConfig,
  FactoryOwner,
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

/** `runGhCollect`が使う外部の操作。テストでは差し替える。 */
export type GhCollectDeps = {
  readonly config: GhCollectConfig;
  readonly nowMs: () => number;
  /** 変数`github_read_tokens`の値。読めなければ例外を投げてよい(文は捨てる)。 */
  readonly readTokenVariable: () => Promise<string>;
  /** 所有者の実行の行を、全員分、1つの文で書く。 */
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
  /** GraphQLを1回送る。失敗は例外にせず、`GraphqlFailure`で返す。 */
  readonly request: (args: {
    readonly token: string;
    readonly variables: Readonly<Record<string, unknown>>;
    readonly timeoutMs: number;
  }) => Promise<GraphqlResponse>;
  readonly log: Logger;
};

/** 所有者1人の結果。ジョブ結果に残るので、件数と失敗の種類だけを持つ。 */
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

/** 通信に至らなかった失敗の行の内容。照合も記録の置き換えも無いので、`verified`は偽、`id_checked`は`NULL`。 */
function failedOutcome(
  errorCode: GhCollectErrorCode,
  detail: Partial<GhCollectRunOutcome> = {},
): GhCollectRunOutcome {
  return {
    ok: false,
    owner_id: null,
    verified: false,
    id_checked: null,
    cost: null,
    requests: 0,
    remaining: null,
    error_code: errorCode,
    next_allowed_at: null,
    ...detail,
  };
}

type OwnerCollected = {
  readonly outcome: GhCollectRunOutcome;
  readonly repos: number;
};

/**
 * `owners`の所有者のリポジトリの状態を集めて、DBに書く。
 * `gh_collect_enabled`が偽なら、トークンを読まず、行も書かずに終わる。
 * 実行の行は、トークンを読む前に全員分を1つの文で書く。書けなければ例外を投げて、`on_failure`に任せる。
 * そのほかの失敗は例外にせず、所有者ごとの行の`error_code`に残す。
 * 所有者は最後の成功が古い順に回す。実行全体の締め切りを過ぎそうなら、新しい要求を始めない。
 */
export async function runGhCollect(
  deps: GhCollectDeps,
): Promise<GhCollectResult> {
  const { config, log } = deps;
  if (!config.gh_collect_enabled) {
    return { enabled: false, owners: [] };
  }
  const owners: FactoryOwner[] = [];
  const seen = new Set<string>();
  for (const owner of config.owners) {
    if (!seen.has(owner.name.toLowerCase())) {
      seen.add(owner.name.toLowerCase());
      owners.push(owner);
    }
  }
  if (owners.length === 0) {
    return { enabled: true, owners: [] };
  }
  const deadlineMs = deps.nowMs() + GH_COLLECT_DEADLINE_MS;
  const names = owners.map((owner) => owner.name);
  const runs = await deps.insertRuns(names);
  const runIds = new Map(runs.map((run) => [run.owner.toLowerCase(), run.id]));

  const results: GhCollectOwnerResult[] = [];
  const finish = async (
    owner: FactoryOwner,
    collected: OwnerCollected,
  ): Promise<void> => {
    const { outcome } = collected;
    results.push({
      owner: owner.name,
      ok: outcome.ok,
      error_code: outcome.error_code,
      repos: collected.repos,
      requests: outcome.requests,
    });
    log.info("owner collected", {
      owner: owner.name,
      ok: outcome.ok,
      error_code: outcome.error_code,
      repos: collected.repos,
      requests: outcome.requests,
    });
    const id = runIds.get(owner.name.toLowerCase());
    if (id === undefined) {
      return;
    }
    try {
      await deps.finishRun(id, outcome);
    } catch {
      log.error("could not finish a collection run row", {
        owner: owner.name,
      });
    }
  };

  let raw: string | null = null;
  try {
    raw = await deps.readTokenVariable();
  } catch {
    log.warn("could not read the read-only token variable");
  }
  const variable = parseTokenVariable(raw);

  let states: readonly GhCollectOwnerState[];
  try {
    states = await deps.listOwnerStates(names);
  } catch {
    log.error("could not read the collection states");
    for (const owner of owners) {
      await finish(owner, { outcome: failedOutcome("db_error"), repos: 0 });
    }
    return { enabled: true, owners: results };
  }
  const stateOf = new Map(
    states.map((state) => [state.owner.toLowerCase(), state]),
  );

  /** 所有者の一覧を取り終えて照合し、記録を置き換える。 */
  const collectOwner = async (
    owner: FactoryOwner,
    token: string,
  ): Promise<OwnerCollected> => {
    let requests = 0;
    let cost: number | null = null;
    let remaining: number | null = null;
    let ownerId: number | null = null;
    let idChecked = false;
    const nodes = new Map<string, RepoNode>();
    const fail = (
      errorCode: GhCollectErrorCode,
      nextAllowedAt: Date | null = null,
    ): OwnerCollected => ({
      outcome: failedOutcome(errorCode, {
        owner_id: ownerId,
        cost,
        requests,
        remaining,
        next_allowed_at: nextAllowedAt,
      }),
      repos: 0,
    });
    const recordOwnerNotice = async (check: OwnerCheck): Promise<void> => {
      if (owner.id === undefined) {
        return;
      }
      const message =
        check.kind === "mismatch"
          ? ownerIdMismatchMessage(owner.name, owner.id, check.actual)
          : ownerNotFoundMessage(owner.name, owner.id);
      try {
        await deps.addNotice({ kind: OWNER_ID_MISMATCH_KIND, message });
      } catch {
        log.warn("could not record the owner id notice", { owner: owner.name });
      }
    };

    let cursor: string | null = null;
    for (let first = true; ; first = false) {
      const left = deadlineMs - deps.nowMs();
      if (left < GH_COLLECT_MIN_REQUEST_MS) {
        return fail("deadline");
      }
      requests += 1;
      let response: GraphqlResponse;
      try {
        response = await deps.request({
          token,
          variables: { owner: owner.name, label: config.trigger_label, cursor },
          timeoutMs: Math.min(GRAPHQL_REQUEST_TIMEOUT_MS, left),
        });
      } catch {
        log.error("a GitHub request failed unexpectedly", {
          owner: owner.name,
        });
        return fail("http_5xx");
      }
      if (!response.ok) {
        const failure = classifyGraphqlFailure(response, deps.nowMs());
        return fail(failure.error_code, failure.next_allowed_at);
      }
      const page = parseOwnerReposPage(response.data);
      if (page.kind === "malformed") {
        return fail("parse_error");
      }
      if (page.cost !== null) {
        cost = (cost ?? 0) + page.cost;
      }
      remaining = page.remaining ?? remaining;
      if (first) {
        ownerId = page.owner?.database_id ?? null;
        const check = checkOwnerId(owner.id, page.owner);
        if (
          check.kind === "mismatch" ||
          check.kind === "not_found_with_id" ||
          check.kind === "not_found_without_id"
        ) {
          await recordOwnerNotice(check);
          return fail("owner_mismatch");
        }
        idChecked = check.kind === "matched";
      }
      for (const discarded of page.discarded) {
        log.warn("discarded a repository row", {
          owner: owner.name,
          repo: discarded.repo,
          column: discarded.column,
        });
      }
      for (const node of page.repos) {
        const key = node.name.toLowerCase();
        if (!nodes.has(key)) {
          nodes.set(key, node);
        }
      }
      if (!page.has_next) {
        break;
      }
      cursor = page.end_cursor;
    }

    if (ownerId === null) {
      return fail("parse_error");
    }
    const listed = selectTargets(config, owner.name, [...nodes.values()]);
    try {
      const previous = await deps.listRepos(owner.name);
      const gone = planGone({
        listed: listed.map((repo) => repo.repo),
        previous,
        allowlisted: allowlistedRepos(config, owner.name),
      });
      await deps.replaceSnapshot({
        owner: owner.name,
        owner_id: ownerId,
        listed,
        gone,
      });
    } catch {
      log.error("could not write the repository snapshot", {
        owner: owner.name,
      });
      return fail("db_error");
    }
    return {
      outcome: {
        ok: true,
        owner_id: ownerId,
        verified: true,
        id_checked: idChecked,
        cost,
        requests,
        remaining,
        error_code: null,
        next_allowed_at: null,
      },
      repos: listed.length,
    };
  };

  for (const owner of orderOwners(owners, states)) {
    const lookup = lookupToken(variable, owner.name);
    if (lookup.kind === "error") {
      await finish(owner, {
        outcome: failedOutcome(lookup.error_code),
        repos: 0,
      });
      continue;
    }
    const carried = carriedFailure(
      stateOf.get(owner.name.toLowerCase()),
      deps.nowMs(),
    );
    if (carried !== null) {
      await finish(owner, {
        outcome: failedOutcome(carried.error_code, {
          next_allowed_at: carried.next_allowed_at,
        }),
        repos: 0,
      });
      continue;
    }
    await finish(owner, await collectOwner(owner, lookup.token));
  }

  log.info("gh_collect finished", {
    owners: results.length,
    ok: results.filter((result) => result.ok).length,
    repos: results.reduce((sum, result) => sum + result.repos, 0),
    requests: results.reduce((sum, result) => sum + result.requests, 0),
  });
  return { enabled: true, owners: results };
}
