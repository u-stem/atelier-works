// GitHubの収集の本体。依存を注入して、所有者ごとにリポジトリの一覧を読み、DBに書く。
// 所有者ごとに読み取り専用のトークンを使い、一覧を取り終えて照合が通ったときだけ、その所有者の記録を置き換える。
// GitHubの失敗は例外にせず、実行の行に失敗の種類だけを残す。ジョブ結果とログには、件数と失敗の種類しか載せない。

import type { OptionalFieldError, ZeroCountRepo } from "./gh_collect_detail.ts";
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
  GhCollectStage,
  GhIssue,
  GhPullRequest,
  GhRepo,
  GhRepoDetailWrite,
  GhRepoDetailWriteResult,
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
  | "gh_collect_detail_enabled"
  | "review_label"
  | "fix_label"
>;

/** `request`が送る問い合わせの種類。通信の層が文に対応させる。任意の文を送る道は作らない。 */
export type GhRequestKind =
  | { readonly kind: "owner_repos" }
  | { readonly kind: "repo_details"; readonly aliases: number };

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
  }) => Promise<{
    readonly replaced: readonly string[];
    readonly unusable: number;
  }>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
  /** GraphQLを1回送る。失敗は例外にせず、`GraphqlFailure`で返す。 */
  readonly request: (args: {
    readonly token: string;
    readonly variables: Readonly<Record<string, unknown>>;
    readonly timeoutMs: number;
    readonly kind: GhRequestKind;
  }) => Promise<GraphqlResponse>;
  /** 所有者の開いているPRとIssueの行を読む。 */
  readonly listDetailRows: (owner: string) => Promise<{
    readonly prs: readonly GhPullRequest[];
    readonly issues: readonly GhIssue[];
  }>;
  /** 詳細を取り終えた1つのリポジトリを書く。検査の失敗は戻り値、DBの失敗は例外。 */
  readonly writeRepoDetail: (
    write: GhRepoDetailWrite,
  ) => Promise<GhRepoDetailWriteResult>;
  /** 打ち切りか失敗の印を書く。 */
  readonly markRepoIncomplete: (mark: {
    readonly owner: string;
    readonly repo: string;
    readonly repo_id: number;
    readonly kind: "truncated" | "failed";
  }) => Promise<void>;
  /** 件数が0のリポジトリの開いている行を閉じる。 */
  readonly closeZeroCountRepos: (close: {
    readonly owner: string;
    readonly repos: readonly ZeroCountRepo[];
    readonly observed_at: Date;
  }) => Promise<void>;
  /** 所有者の開いている行をすべて使用不可にし、行数を返す。 */
  readonly markOwnerRowsUnusable: (owner: string) => Promise<number>;
  readonly log: Logger;
};

/** 所有者1人の結果。ジョブ結果に残るので、件数と失敗の種類だけを持つ。 */
export type GhCollectOwnerResult = {
  readonly owner: string;
  readonly ok: boolean;
  readonly error_code: GhCollectErrorCode | null;
  readonly repos: number;
  readonly requests: number;
  readonly stage: GhCollectStage | null;
  readonly detail_targets: number;
  readonly detail_requests: number;
  readonly detail_done: number;
  readonly detail_incomplete: number;
  /** 任意の項目のエラーの件数。固定の項目名と丸めた種類の組ごとに数える。 */
  readonly optional_field_errors: readonly OptionalFieldError[];
  /** `nodes`の`null`の要素の数。 */
  readonly null_nodes: number;
  /** 一覧の置き換えで使用不可にした行の数。 */
  readonly unusable: number;
};

export type GhCollectResult = {
  readonly enabled: boolean;
  readonly owners: readonly GhCollectOwnerResult[];
};

/** 所有者が集め終えた結果。`led`は、周回の中の順で決まるので、`finish`が付ける。 */
type CollectedOutcome = Omit<GhCollectRunOutcome, "led">;

/** 通信に至らなかった失敗の行の内容。照合も記録の置き換えも無いので、`verified`は偽、`id_checked`は`NULL`。 */
function failedOutcome(
  errorCode: GhCollectErrorCode,
  detail: Partial<CollectedOutcome> = {},
): CollectedOutcome {
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
    stage: null,
    detail_targets: 0,
    detail_requests: 0,
    detail_done: 0,
    detail_incomplete: 0,
    ...detail,
  };
}

type OwnerCollected = {
  readonly outcome: CollectedOutcome;
  readonly repos: number;
};

/**
 * `owners`の所有者のリポジトリの状態を集めて、DBに書く。
 * `gh_collect_enabled`が偽なら、トークンを読まず、行も書かずに終わる。
 * 実行の行は、トークンを読む前に全員分を1つの文で書く。書けなければ例外を投げて、`on_failure`に任せる。
 * そのほかの失敗は例外にせず、所有者ごとの行の`error_code`に残す。
 * 所有者は、先頭を担当してから長い順に回す。この周回で最初に要求を送った所有者の行に、結果を問わず`led`を付ける。
 * 実行全体の締め切りを過ぎそうなら、新しい要求を始めない。
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
  // 最初に要求を送った所有者は1人だけで、その行に`led`を付ける。
  let ledTaken = false;
  const finish = async (
    owner: FactoryOwner,
    collected: OwnerCollected,
  ): Promise<void> => {
    const led = !ledTaken && collected.outcome.requests >= 1;
    if (led) {
      ledTaken = true;
    }
    const outcome: GhCollectRunOutcome = { ...collected.outcome, led };
    results.push({
      owner: owner.name,
      ok: outcome.ok,
      error_code: outcome.error_code,
      repos: collected.repos,
      requests: outcome.requests,
      stage: outcome.stage,
      detail_targets: outcome.detail_targets,
      detail_requests: outcome.detail_requests,
      detail_done: outcome.detail_done,
      detail_incomplete: outcome.detail_incomplete,
      optional_field_errors: [],
      null_nodes: 0,
      unusable: 0,
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
    // 状態を読めなくても、トークンの失敗は先に採る。引けた所有者だけ`db_error`にする。
    for (const owner of owners) {
      const lookup = lookupToken(variable, owner.name);
      const errorCode =
        lookup.kind === "error" ? lookup.error_code : "db_error";
      await finish(owner, { outcome: failedOutcome(errorCode), repos: 0 });
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
          kind: { kind: "owner_repos" },
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
      if (!first && page.owner?.database_id !== ownerId) {
        // 先頭でないページで所有者が消えるか別のIDになると、一覧が混ざる。置き換えない。
        return fail("parse_error");
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
        stage: null,
        detail_targets: 0,
        detail_requests: 0,
        detail_done: 0,
        detail_incomplete: 0,
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
