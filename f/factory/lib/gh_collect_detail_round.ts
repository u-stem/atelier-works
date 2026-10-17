// 1人の所有者の1周回の詳細の取得を進める状態機械。通信もDBも持たない。
// 待ち行列(健全な列と疑いの列)、束の組み立てと分割、ページ送り、リポジトリごとの結果の確定を持つ。
// 呼び出し側が、`nextBatch`で次の束を受け取り、要求を送り、応答を`onResponse`に渡す。
// 周回の終わりには`close`を呼び、取り終えていないリポジトリの結果を確定する。

import {
  type DetailDiscard,
  type DetailFailureCode,
  type DetailParseConfig,
  type DetailStop,
  type DetailTarget,
  GH_DETAIL_BATCH_MAX,
  GH_DETAIL_PAGE_LIMIT,
  GH_DETAIL_SPLIT_MAX,
  type OptionalFieldError,
  type ParsedPage,
  parseRepoDetailAlias,
} from "./gh_collect_detail.ts";
import { classifyGraphqlFailure, parseResetAt } from "./gh_collect_support.ts";
import type { AliasError, GraphqlResponse } from "./gh_graphql.ts";
import {
  type GhCollectErrorCode,
  type GhIssueWrite,
  type GhPullRequestWrite,
  isRecord,
} from "./types.ts";

/** 1回の要求に束ねるリポジトリ。 */
export type DetailBatch = {
  readonly repos: readonly string[];
};

/** リポジトリ1件の確定した結果。 */
export type RepoSettlement =
  | {
      readonly kind: "collected";
      readonly repo: string;
      readonly repo_id: number;
      readonly prs: readonly GhPullRequestWrite[];
      readonly issues: readonly GhIssueWrite[];
    }
  | {
      readonly kind: "truncated";
      readonly repo: string;
      readonly repo_id: number;
    }
  | {
      readonly kind: "failed";
      readonly repo: string;
      readonly repo_id: number;
      readonly code: DetailFailureCode;
    };

/** 1回の応答を処理した結果。 */
export type BatchResult = {
  readonly settlements: readonly RepoSettlement[];
  /** 所有者の詳細を止める失敗があれば、その理由。 */
  readonly stop: DetailStop | null;
  /** 応答の`rateLimit`。読めなければ`null`。 */
  readonly rate: {
    readonly cost: number;
    readonly remaining: number;
    readonly reset_at: Date | null;
  } | null;
  readonly optional_errors: readonly OptionalFieldError[];
  readonly null_nodes: number;
  readonly discarded: readonly (DetailDiscard & { readonly repo: string })[];
  /** 束を分けて送り直す失敗だったか。 */
  readonly split: boolean;
};

export type DetailRequest = {
  readonly aliases: number;
  readonly variables: Readonly<Record<string, unknown>>;
};

export type DetailRound = {
  /** 次に送る束。送るものが無いか、止まっていれば`null`。 */
  nextBatch(): DetailBatch | null;
  /** 束の要求の別名の数と変数。 */
  requestFor(batch: DetailBatch): DetailRequest;
  /** 束の応答を処理する。 */
  onResponse(
    batch: DetailBatch,
    response: GraphqlResponse,
    nowMs: number,
  ): BatchResult;
  /** 要求が例外で終わった束を処理する。 */
  onException(batch: DetailBatch): BatchResult;
  /** 送る束が残っているか。 */
  pending(): boolean;
  /** 周回の終わりに、確定していないリポジトリの結果を確定する。 */
  close(): readonly RepoSettlement[];
};

/** PRかIssueの片側の進み具合。 */
type Side<T> = {
  /** 取り終えたか、そもそも取らない。 */
  done: boolean;
  cursor: string | null;
  pages: number;
  readonly nodes: Map<number, T>;
};

type RepoState = {
  readonly repo: string;
  readonly repo_id: number;
  readonly pr: Side<GhPullRequestWrite>;
  readonly issue: Side<GhIssueWrite>;
  /** 束を分けた後で、まだ通っていない。 */
  split_suspect: boolean;
  /** 分けるきっかけになった失敗の理由。 */
  last_failure: DetailFailureCode | null;
  /** 応答を1回以上受け取った。 */
  fetched: boolean;
  settled: boolean;
};

const EMPTY_RESULT: BatchResult = {
  settlements: [],
  stop: null,
  rate: null,
  optional_errors: [],
  null_nodes: 0,
  discarded: [],
  split: false,
};

function newSide<T>(wanted: boolean): Side<T> {
  return { done: !wanted, cursor: null, pages: 0, nodes: new Map() };
}

function isSplittable(code: GhCollectErrorCode): code is DetailFailureCode {
  return (
    code === "timeout" ||
    code === "http_5xx" ||
    code === "graphql_error" ||
    code === "parse_error"
  );
}

type StopCode = Exclude<DetailStop["error_code"], "db_error">;

function isStopCode(code: GhCollectErrorCode): code is StopCode {
  return (
    code === "unauthorized" ||
    code === "forbidden" ||
    code === "rate_limited" ||
    code === "secondary_limit"
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readRate(raw: unknown): BatchResult["rate"] {
  if (!isRecord(raw) || !isCount(raw.cost) || !isCount(raw.remaining)) {
    return null;
  }
  return {
    cost: raw.cost,
    remaining: raw.remaining,
    reset_at: parseResetAt(raw.resetAt),
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** 所有者の対象から、周回の状態を作る。 */
export function startDetailRound(args: {
  readonly owner: string;
  readonly targets: readonly DetailTarget[];
  readonly label: string;
  readonly config: DetailParseConfig;
  readonly batch_max?: number;
  readonly split_max?: number;
  readonly page_limit?: number;
}): DetailRound {
  const batchMax = args.batch_max ?? GH_DETAIL_BATCH_MAX;
  const splitMax = args.split_max ?? GH_DETAIL_SPLIT_MAX;
  const pageLimit = args.page_limit ?? GH_DETAIL_PAGE_LIMIT;

  const states = new Map<string, RepoState>();
  for (const target of args.targets) {
    states.set(target.repo, {
      repo: target.repo,
      repo_id: target.repo_id,
      pr: newSide(target.open_pr_count > 0),
      issue: newSide(target.labeled_issue_count > 0),
      split_suspect: false,
      last_failure: null,
      fetched: false,
      settled: false,
    });
  }
  // 健全な列は`batchMax`件ずつの束、疑いの列は1件ずつの束にする。
  const healthy: string[][] = chunk(
    args.targets.filter((target) => !target.suspected).map((t) => t.repo),
    batchMax,
  );
  const suspected: string[][] = args.targets
    .filter((target) => target.suspected)
    .map((target) => [target.repo]);
  let lastWasHealthy = false;
  let splitsUsed = 0;
  let stopped = false;

  const stateOf = (repo: string): RepoState => {
    const state = states.get(repo);
    if (state === undefined) {
      throw new Error("detail round: unknown repository");
    }
    return state;
  };

  const failed = (
    state: RepoState,
    code: DetailFailureCode,
  ): RepoSettlement => {
    state.settled = true;
    return {
      kind: "failed",
      repo: state.repo,
      repo_id: state.repo_id,
      code,
    };
  };

  /** 束全体の失敗。単独の束か分割の上限に達していれば失敗にし、そうでなければ半分に分けて健全な列の末尾に戻す。 */
  const failBatch = (
    batch: DetailBatch,
    code: DetailFailureCode,
  ): BatchResult => {
    const members = batch.repos.filter((repo) => !stateOf(repo).settled);
    if (members.length <= 1 || splitsUsed >= splitMax) {
      return {
        ...EMPTY_RESULT,
        settlements: members.map((repo) => failed(stateOf(repo), code)),
      };
    }
    splitsUsed += 1;
    for (const repo of members) {
      const state = stateOf(repo);
      state.split_suspect = true;
      state.last_failure = code;
    }
    const half = Math.ceil(members.length / 2);
    healthy.push(members.slice(0, half), members.slice(half));
    return { ...EMPTY_RESULT, split: true };
  };

  /** 側のページを取り込む。打ち切りになるときは真を返す。 */
  const applyPage = <T extends { readonly number: number }>(
    side: Side<T>,
    page: ParsedPage<T>,
  ): boolean => {
    side.pages += 1;
    for (const node of page.nodes) {
      if (!side.nodes.has(node.number)) {
        side.nodes.set(node.number, node);
      }
    }
    side.cursor = page.end_cursor;
    if (page.has_next) {
      return side.pages >= pageLimit;
    }
    side.done = true;
    return side.nodes.size !== page.total;
  };

  return {
    nextBatch() {
      if (stopped) {
        return null;
      }
      let repos: string[] | undefined;
      if (lastWasHealthy && suspected.length > 0) {
        repos = suspected.shift();
        lastWasHealthy = false;
      } else if (healthy.length > 0) {
        repos = healthy.shift();
        lastWasHealthy = true;
      } else if (suspected.length > 0) {
        repos = suspected.shift();
        lastWasHealthy = false;
      }
      return repos === undefined ? null : { repos };
    },

    requestFor(batch) {
      const variables: Record<string, unknown> = { label: args.label };
      batch.repos.forEach((repo, index) => {
        const state = stateOf(repo);
        variables[`o${index}`] = args.owner;
        variables[`n${index}`] = state.repo;
        variables[`p${index}`] = !state.pr.done;
        variables[`pc${index}`] = state.pr.cursor;
        variables[`i${index}`] = !state.issue.done;
        variables[`ic${index}`] = state.issue.cursor;
      });
      return { aliases: batch.repos.length, variables };
    },

    onResponse(batch, response, nowMs) {
      if (!response.ok) {
        const failure = classifyGraphqlFailure(response, nowMs);
        if (isSplittable(failure.error_code)) {
          return failBatch(batch, failure.error_code);
        }
        if (!isStopCode(failure.error_code)) {
          return failBatch(batch, "http_5xx");
        }
        stopped = true;
        return {
          ...EMPTY_RESULT,
          stop: {
            error_code: failure.error_code,
            next_allowed_at: failure.next_allowed_at,
          },
        };
      }
      const rate = readRate(response.data.rateLimit);
      if (rate === null) {
        return failBatch(batch, "parse_error");
      }
      const aliasErrors: readonly AliasError[] = response.alias_errors ?? [];
      const settlements: RepoSettlement[] = [];
      const optional = new Map<string, OptionalFieldError>();
      const discarded: (DetailDiscard & { readonly repo: string })[] = [];
      const continuation: string[] = [];
      let nullNodes = 0;
      batch.repos.forEach((repo, index) => {
        const state = stateOf(repo);
        // 応答が通ったので、束を分けた疑いは晴れる。
        state.split_suspect = false;
        const alias = `r${index}`;
        const parsed = parseRepoDetailAlias({
          raw: response.data[alias],
          repo_id: state.repo_id,
          want_pull_requests: !state.pr.done,
          want_issues: !state.issue.done,
          alias_errors: aliasErrors.filter((error) => error.alias === alias),
          config: args.config,
        });
        if (parsed.kind === "failed") {
          nullNodes += parsed.null_nodes;
          settlements.push(failed(state, parsed.error_code));
          return;
        }
        for (const entry of parsed.optional_errors) {
          const key = `${entry.field}|${entry.type}`;
          const before = optional.get(key);
          optional.set(key, {
            ...entry,
            count: (before?.count ?? 0) + entry.count,
          });
        }
        for (const entry of parsed.discarded) {
          discarded.push({ ...entry, repo });
        }
        state.fetched = true;
        let truncated = false;
        if (parsed.pull_requests !== null) {
          truncated = applyPage(state.pr, parsed.pull_requests) || truncated;
        }
        if (parsed.issues !== null) {
          truncated = applyPage(state.issue, parsed.issues) || truncated;
        }
        if (truncated) {
          state.settled = true;
          settlements.push({
            kind: "truncated",
            repo,
            repo_id: state.repo_id,
          });
        } else if (state.pr.done && state.issue.done) {
          state.settled = true;
          settlements.push({
            kind: "collected",
            repo,
            repo_id: state.repo_id,
            prs: [...state.pr.nodes.values()],
            issues: [...state.issue.nodes.values()],
          });
        } else {
          continuation.push(repo);
        }
      });
      if (continuation.length > 0) {
        healthy.unshift(continuation);
      }
      return {
        settlements,
        stop: null,
        rate,
        optional_errors: [...optional.values()],
        null_nodes: nullNodes,
        discarded,
        split: false,
      };
    },

    onException(batch) {
      return failBatch(batch, "http_5xx");
    },

    pending() {
      return !stopped && (healthy.length > 0 || suspected.length > 0);
    },

    close() {
      stopped = true;
      const settlements: RepoSettlement[] = [];
      for (const state of states.values()) {
        if (state.settled) {
          continue;
        }
        if (state.split_suspect) {
          settlements.push(failed(state, state.last_failure ?? "http_5xx"));
        } else if (state.fetched) {
          state.settled = true;
          settlements.push({
            kind: "truncated",
            repo: state.repo,
            repo_id: state.repo_id,
          });
        }
      }
      return settlements;
    },
  };
}
