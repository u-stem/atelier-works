// GitHubの収集の本体。依存を注入して、所有者ごとにリポジトリの一覧(段1)と、開いているPRとトリガーラベル付きIssueの詳細(段2)を読み、DBに書く。
// 所有者ごとに読み取り専用のトークンを使い、一覧を取り終えて照合が通ったときだけ、その所有者の記録を置き換える。
// 段2は設定の`gh_collect_detail_enabled`が真のときだけ行い、全員分の段1の後に、段1と同じ順で回す。
// GitHubの失敗は例外にせず、実行の行に失敗の種類だけを残す。ジョブ結果とログには、件数と失敗の種類しか載せない。

import {
  canStartDetailRequest,
  classifyDetailOutcome,
  classifyRepos,
  type DetailFailureCode,
  type DetailOutcome,
  type DetailStop,
  detailDiscardLogFields,
  GH_DETAIL_REMAINING_FLOOR,
  type OptionalFieldError,
  planRepoDetailWrite,
  type ZeroCountRepo,
} from "./gh_collect_detail.ts";
import {
  type BatchResult,
  type RepoSettlement,
  startDetailRound,
} from "./gh_collect_detail_round.ts";
import {
  allowlistedRepos,
  backoffUntil,
  carriedFailure,
  checkOwnerId,
  classifyGraphqlFailure,
  GH_COLLECT_DEADLINE_MS,
  lookupToken,
  type OwnerCheck,
  observationStartMs,
  orderOwners,
  parseOwnerReposPage,
  parseTokenVariable,
  planGone,
  type RepoNode,
  selectTargets,
  stage1Floor,
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
import {
  checkGhRepoDetailWrite,
  type FactoryConfig,
  type FactoryOwner,
  type GhCollectErrorCode,
  type GhCollectOwnerState,
  type GhCollectRunOutcome,
  type GhCollectStage,
  type GhIssue,
  type GhPullRequest,
  type GhRepo,
  type GhRepoDetailWrite,
  type GhRepoDetailWriteResult,
  type GhRepoGone,
  type GhRepoUpsert,
  type NoticeRecord,
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
  /** 一覧の置き換え。数値IDが入れ替わったリポジトリの名前と、使用不可にした行の数を返す。 */
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

/** 所有者が集め終えた結果。`led`は、その周回の最初の要求を送った所有者かで決まるので、`finish`が付ける。 */
type CollectedOutcome = Omit<GhCollectRunOutcome, "led">;

/** 結果とログに載せる、件数だけの内訳。 */
type Summary = {
  readonly optional_field_errors: readonly OptionalFieldError[];
  readonly null_nodes: number;
  readonly unusable: number;
};

const NO_SUMMARY: Summary = {
  optional_field_errors: [],
  null_nodes: 0,
  unusable: 0,
};

/** 通信に至らなかった失敗の行の内容。照合も記録の置き換えも無いので、`verified`は偽、`id_checked`は`NULL`。段は一覧にする。 */
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
    stage: "list",
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
  readonly summary: Summary;
};

/** 段1が成功し、段2を待つ所有者。段1の照合の結果と、段2に要る入力を持つ。 */
type ListedOwner = {
  readonly owner: FactoryOwner;
  readonly token: string;
  readonly owner_id: number;
  readonly id_checked: boolean;
  readonly requests: number;
  readonly cost: number | null;
  readonly remaining: number | null;
  readonly reset_at: Date | null;
  /** その周回の観測を始めた時刻(エポックミリ秒)。 */
  readonly observed_at_ms: number;
  readonly listed: readonly GhRepoUpsert[];
  readonly previous: readonly GhRepo[];
  readonly replaced: readonly string[];
  readonly unusable: number;
};

type Stage1Result =
  | { readonly kind: "failed"; readonly collected: OwnerCollected }
  | { readonly kind: "listed"; readonly listed: ListedOwner };

/** 段2を行わないときに、段1の結果から作る成功の行。 */
function listingCollected(listed: ListedOwner): OwnerCollected {
  return {
    outcome: {
      ok: true,
      owner_id: listed.owner_id,
      verified: true,
      id_checked: listed.id_checked,
      cost: listed.cost,
      requests: listed.requests,
      remaining: listed.remaining,
      error_code: null,
      next_allowed_at: null,
      stage: null,
      detail_targets: 0,
      detail_requests: 0,
      detail_done: 0,
      detail_incomplete: 0,
    },
    repos: listed.listed.length,
    summary: { ...NO_SUMMARY, unusable: listed.unusable },
  };
}

/** 想定外の例外で段2を終えられなかった所有者の行。段1の照合の結果は保つ。 */
function interruptedCollected(listed: ListedOwner): OwnerCollected {
  return {
    outcome: {
      ...listingCollected(listed).outcome,
      ok: false,
      error_code: "parse_error",
      stage: "detail",
    },
    repos: listed.listed.length,
    summary: { ...NO_SUMMARY, unusable: listed.unusable },
  };
}

/**
 * `owners`の所有者のリポジトリの状態を集めて、DBに書く。
 * `gh_collect_enabled`が偽なら、トークンを読まず、行も書かずに終わる。
 * 実行の行は、トークンを読む前に全員分を1つの文で書く。書けなければ例外を投げて、`on_failure`に任せる。
 * そのほかの失敗は例外にせず、所有者ごとの行の`error_code`に残す。
 * 所有者は、先頭を担当してから長い順に回す。この周回で最初に段1の要求を送った所有者の行に、結果を問わず`led`を付ける。
 * 実行全体の締め切りを過ぎそうなら、新しい要求を始めない。
 *
 * `gh_collect_detail_enabled`が真のときは、段1が成功した所有者を保留にして全員分の段1を終え、
 * 続けて段2(開いているPRとトリガーラベル付きIssueの詳細)を、段1と同じ順に回す。
 * 段1は、段2の取り分を残す下限で新しい要求を止める。保留の所有者は、例外で抜けても必ず`finish`する。
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
  const detailEnabled = config.gh_collect_detail_enabled;
  const floorMs = stage1Floor(detailEnabled);
  const deadlineMs = deps.nowMs() + GH_COLLECT_DEADLINE_MS;
  const names = owners.map((owner) => owner.name);
  const runs = await deps.insertRuns(names);
  const runIds = new Map(runs.map((run) => [run.owner.toLowerCase(), run.id]));

  const results: GhCollectOwnerResult[] = [];
  // 最初に段1の要求を送った所有者は1人だけで、その行に`led`を付ける。
  let ledOwner: string | null = null;
  const finish = async (
    owner: FactoryOwner,
    collected: OwnerCollected,
  ): Promise<void> => {
    const led =
      ledOwner === owner.name.toLowerCase() && collected.outcome.requests >= 1;
    const outcome: GhCollectRunOutcome = { ...collected.outcome, led };
    const fields = {
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
      optional_field_errors: collected.summary.optional_field_errors,
      null_nodes: collected.summary.null_nodes,
      unusable: collected.summary.unusable,
    };
    results.push(fields);
    log.info("owner collected", fields);
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
      await finish(owner, {
        outcome: failedOutcome(errorCode),
        repos: 0,
        summary: NO_SUMMARY,
      });
    }
    return { enabled: true, owners: results };
  }
  const stateOf = new Map(
    states.map((state) => [state.owner.toLowerCase(), state]),
  );

  /** 所有者の開いている行を使用不可にする。失敗しても結果は変えず、警告だけ残す。 */
  const markOwnerUnusable = async (owner: FactoryOwner): Promise<void> => {
    try {
      await deps.markOwnerRowsUnusable(owner.name);
    } catch {
      log.warn("could not mark the owner rows unusable", {
        owner: owner.name,
      });
    }
  };

  /** 段1: 所有者の一覧を取り終えて照合し、記録を置き換える。 */
  const collectOwner = async (
    owner: FactoryOwner,
    token: string,
  ): Promise<Stage1Result> => {
    let requests = 0;
    let cost: number | null = null;
    let remaining: number | null = null;
    let resetAt: Date | null = null;
    let ownerId: number | null = null;
    let idChecked = false;
    let firstSentMs = 0;
    let firstReceivedMs = 0;
    const nodes = new Map<string, RepoNode>();
    const fail = (
      errorCode: GhCollectErrorCode,
      nextAllowedAt: Date | null = null,
    ): Stage1Result => ({
      kind: "failed",
      collected: {
        outcome: failedOutcome(errorCode, {
          owner_id: ownerId,
          cost,
          requests,
          remaining,
          next_allowed_at: nextAllowedAt,
        }),
        repos: 0,
        summary: NO_SUMMARY,
      },
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
      const sentAt = deps.nowMs();
      const left = deadlineMs - sentAt;
      if (left < floorMs) {
        return fail("deadline");
      }
      if (ledOwner === null) {
        ledOwner = owner.name.toLowerCase();
      }
      requests += 1;
      if (first) {
        firstSentMs = sentAt;
      }
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
      if (first) {
        firstReceivedMs = deps.nowMs();
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
      resetAt = page.reset_at ?? resetAt;
      if (first) {
        ownerId = page.owner?.database_id ?? null;
        const check = checkOwnerId(owner.id, page.owner);
        if (
          check.kind === "mismatch" ||
          check.kind === "not_found_with_id" ||
          check.kind === "not_found_without_id"
        ) {
          await recordOwnerNotice(check);
          // 名前が別のアカウントに付け替わった疑いがあるので、開いている行を使えなくする。
          await markOwnerUnusable(owner);
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
    let previous: readonly GhRepo[];
    let snapshot: {
      readonly replaced: readonly string[];
      readonly unusable: number;
    };
    try {
      previous = await deps.listRepos(owner.name);
      const gone = planGone({
        listed: listed.map((repo) => repo.repo),
        previous,
        allowlisted: allowlistedRepos(config, owner.name),
      });
      snapshot = await deps.replaceSnapshot({
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
    for (const repo of snapshot.replaced) {
      log.warn("repository id changed", { owner: owner.name, repo });
    }
    return {
      kind: "listed",
      listed: {
        owner,
        token,
        owner_id: ownerId,
        id_checked: idChecked,
        requests,
        cost,
        remaining,
        reset_at: resetAt,
        observed_at_ms: observationStartMs({
          pages: requests,
          first_sent_ms: firstSentMs,
          first_received_ms: firstReceivedMs,
        }),
        listed,
        previous,
        replaced: snapshot.replaced,
        unusable: snapshot.unusable,
      },
    };
  };

  /**
   * 段2: 所有者の開いているPRとトリガーラベル付きIssueの詳細を取り、書く。
   * 件数が0のリポジトリは要求なしで閉じる。残りの時間が10秒以上ある間だけ束を送る。
   * 想定外の例外は、その所有者の行を`parse_error`(段は詳細)にして終える。
   */
  const collectDetail = async (
    listed: ListedOwner,
  ): Promise<OwnerCollected> => {
    const { owner } = listed;
    const name = owner.name.toLowerCase();
    const failedCodes: DetailFailureCode[] = [];
    const tally = {
      targets: 0,
      requests: 0,
      done: 0,
      truncated: 0,
      failed: failedCodes,
    };
    const optional = new Map<string, OptionalFieldError>();
    let nullNodes = 0;
    let cost = listed.cost;
    let remaining = listed.remaining;
    let resetAt = listed.reset_at;
    const build = (detail: DetailOutcome): OwnerCollected => ({
      outcome: {
        ok: detail.ok,
        owner_id: listed.owner_id,
        verified: true,
        id_checked: listed.id_checked,
        cost,
        requests: listed.requests,
        remaining,
        error_code: detail.error_code,
        next_allowed_at: detail.next_allowed_at,
        stage: detail.stage,
        detail_targets: tally.targets,
        detail_requests: tally.requests,
        detail_done: tally.done,
        detail_incomplete: tally.truncated + tally.failed.length,
      },
      repos: listed.listed.length,
      summary: {
        optional_field_errors: [...optional.values()],
        null_nodes: nullNodes,
        unusable: listed.unusable,
      },
    });
    const dbStop: DetailStop = {
      error_code: "db_error",
      next_allowed_at: null,
    };
    const belowFloor = (): boolean =>
      remaining !== null && remaining < GH_DETAIL_REMAINING_FLOOR;
    const rateLimitStop = (): DetailStop => ({
      error_code: "rate_limited",
      next_allowed_at: backoffUntil(
        deps.nowMs(),
        resetAt === null ? null : resetAt.getTime(),
      ),
    });
    try {
      const classified = classifyRepos({
        listed: listed.listed,
        previous: listed.previous,
        replaced: listed.replaced,
      });
      tally.targets = classified.targets.length;
      const observedAt = new Date(listed.observed_at_ms);
      if (classified.zero_count.length > 0) {
        try {
          await deps.closeZeroCountRepos({
            owner: name,
            repos: classified.zero_count,
            observed_at: observedAt,
          });
        } catch {
          log.warn("could not close the zero count repositories", {
            owner: owner.name,
          });
        }
      }
      if (tally.targets === 0) {
        return build(classifyDetailOutcome({ tally, stop: null }));
      }
      if (belowFloor()) {
        return build(classifyDetailOutcome({ tally, stop: rateLimitStop() }));
      }
      let rows: {
        readonly prs: readonly GhPullRequest[];
        readonly issues: readonly GhIssue[];
      };
      try {
        rows = await deps.listDetailRows(name);
      } catch {
        log.error("could not read the detail rows", { owner: owner.name });
        return build(classifyDetailOutcome({ tally, stop: dbStop }));
      }

      const mark = async (
        settlement: { readonly repo: string; readonly repo_id: number },
        kind: "truncated" | "failed",
      ): Promise<void> => {
        try {
          await deps.markRepoIncomplete({
            owner: name,
            repo: settlement.repo,
            repo_id: settlement.repo_id,
            kind,
          });
        } catch {
          log.warn("could not mark the repository", {
            owner: owner.name,
            repo: settlement.repo,
          });
        }
      };
      /** リポジトリ1件の結果を数え、DBに書く。DBの失敗(例外)だけが所有者の段2を止める。 */
      const settle = async (
        settlement: RepoSettlement,
      ): Promise<"ok" | "db_error"> => {
        if (settlement.kind === "truncated") {
          tally.truncated += 1;
          await mark(settlement, "truncated");
          return "ok";
        }
        if (settlement.kind === "failed") {
          tally.failed.push(settlement.code);
          log.warn("a repository detail failed", {
            owner: owner.name,
            repo: settlement.repo,
            error_code: settlement.code,
          });
          await mark(settlement, "failed");
          return "ok";
        }
        const write = planRepoDetailWrite({
          owner: name,
          repo: settlement.repo,
          repo_id: settlement.repo_id,
          observed_at: observedAt,
          previous_prs: rows.prs,
          previous_issues: rows.issues,
          prs: settlement.prs,
          issues: settlement.issues,
        });
        const invalid = checkGhRepoDetailWrite(write);
        if (invalid !== null) {
          log.warn("a detail write failed its checks", {
            owner: owner.name,
            repo: settlement.repo,
            field: invalid,
          });
          tally.failed.push("parse_error");
          await mark(settlement, "failed");
          return "ok";
        }
        let result: GhRepoDetailWriteResult;
        try {
          result = await deps.writeRepoDetail(write);
        } catch {
          log.error("could not write the repository detail", {
            owner: owner.name,
          });
          return "db_error";
        }
        if (result.kind === "written") {
          tally.done += 1;
        } else if (result.kind === "rejected") {
          log.warn("a detail write was rejected", {
            owner: owner.name,
            repo: settlement.repo,
            field: result.field,
          });
          tally.failed.push("parse_error");
          await mark(settlement, "failed");
        } else {
          log.warn("the repository row changed before the detail write", {
            owner: owner.name,
            repo: settlement.repo,
          });
        }
        return "ok";
      };

      const round = startDetailRound({
        owner: name,
        targets: classified.targets,
        label: config.trigger_label,
        config: {
          review_label: config.review_label,
          fix_label: config.fix_label,
        },
      });
      let stop: DetailStop | null = null;
      for (;;) {
        if (belowFloor() && round.pending()) {
          stop = rateLimitStop();
          break;
        }
        const left = deadlineMs - deps.nowMs();
        if (!canStartDetailRequest(left)) {
          break;
        }
        const batch = round.nextBatch();
        if (batch === null) {
          break;
        }
        const request = round.requestFor(batch);
        tally.requests += 1;
        let response: GraphqlResponse | null = null;
        try {
          response = await deps.request({
            token: listed.token,
            variables: request.variables,
            timeoutMs: Math.min(GRAPHQL_REQUEST_TIMEOUT_MS, left),
            kind: { kind: "repo_details", aliases: request.aliases },
          });
        } catch {
          log.error("a GitHub detail request failed unexpectedly", {
            owner: owner.name,
          });
        }
        const result: BatchResult =
          response === null
            ? round.onException(batch)
            : round.onResponse(batch, response, deps.nowMs());
        if (result.rate !== null) {
          cost = (cost ?? 0) + result.rate.cost;
          remaining = result.rate.remaining;
          resetAt = result.rate.reset_at ?? resetAt;
        }
        for (const entry of result.optional_errors) {
          const key = `${entry.field}|${entry.type}`;
          optional.set(key, {
            ...entry,
            count: (optional.get(key)?.count ?? 0) + entry.count,
          });
        }
        nullNodes += result.null_nodes;
        for (const discarded of result.discarded) {
          log.warn(
            "discarded a detail value",
            detailDiscardLogFields({
              owner: owner.name,
              repo: discarded.repo,
              discard: discarded,
            }),
          );
        }
        if (result.split) {
          log.warn("split a detail batch", {
            owner: owner.name,
            aliases: batch.repos.length,
          });
        }
        for (const settlement of result.settlements) {
          if ((await settle(settlement)) === "db_error") {
            stop = dbStop;
            break;
          }
        }
        if (stop !== null) {
          break;
        }
        if (result.stop !== null) {
          stop = result.stop;
          break;
        }
      }
      if (stop === null || stop.error_code !== "db_error") {
        for (const settlement of round.close()) {
          if ((await settle(settlement)) === "db_error") {
            stop = dbStop;
            break;
          }
        }
      }
      return build(classifyDetailOutcome({ tally, stop }));
    } catch {
      log.error("stage 2 failed unexpectedly", { owner: owner.name });
      return build({
        ok: false,
        error_code: "parse_error",
        stage: "detail",
        next_allowed_at: null,
      });
    }
  };

  const pending: ListedOwner[] = [];
  const settledOwners = new Set<string>();
  const runOwners = async (): Promise<void> => {
    for (const owner of orderOwners(owners, states)) {
      const lookup = lookupToken(variable, owner.name);
      if (lookup.kind === "error") {
        await finish(owner, {
          outcome: failedOutcome(lookup.error_code),
          repos: 0,
          summary: NO_SUMMARY,
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
          summary: NO_SUMMARY,
        });
        continue;
      }
      const stage1 = await collectOwner(owner, lookup.token);
      if (stage1.kind === "failed") {
        await finish(owner, stage1.collected);
      } else if (detailEnabled) {
        pending.push(stage1.listed);
      } else {
        await finish(owner, listingCollected(stage1.listed));
      }
    }
    for (const listed of pending) {
      const collected = await collectDetail(listed);
      settledOwners.add(listed.owner.name.toLowerCase());
      await finish(listed.owner, collected);
    }
  };

  if (detailEnabled) {
    try {
      await runOwners();
    } finally {
      // 例外で抜けたときも、保留のまま終えていない所有者の行を必ず終える。
      for (const listed of pending) {
        if (!settledOwners.has(listed.owner.name.toLowerCase())) {
          await finish(listed.owner, interruptedCollected(listed));
        }
      }
    }
  } else {
    await runOwners();
  }

  log.info("gh_collect finished", {
    owners: results.length,
    ok: results.filter((result) => result.ok).length,
    repos: results.reduce((sum, result) => sum + result.repos, 0),
    requests: results.reduce((sum, result) => sum + result.requests, 0),
    detail_requests: results.reduce(
      (sum, result) => sum + result.detail_requests,
      0,
    ),
    detail_done: results.reduce((sum, result) => sum + result.detail_done, 0),
    detail_incomplete: results.reduce(
      (sum, result) => sum + result.detail_incomplete,
      0,
    ),
  });
  return { enabled: true, owners: results };
}
