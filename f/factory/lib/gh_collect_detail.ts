// GitHubの収集の詳細(開いているPRとトリガーラベル付きIssue)の判定を、通信もDBも持たない純粋関数としてまとめる。
// 対象の選別、応答の解析、保存する値の検査、差分と書き込みの計画、実行の結果の分類を持つ。
// 外から来た値は、例外を投げない述語で検査する。値は戻り値にもログにも例外の文にも出さない。

import { GH_COLLECT_MIN_REQUEST_MS } from "./gh_collect_support.ts";
import type { AliasError, AliasErrorType } from "./gh_graphql.ts";
import {
  type GhAuthorType,
  type GhCollectErrorCode,
  type GhDetailOptionalField,
  type GhIssue,
  type GhIssueWrite,
  type GhMergeable,
  type GhPullRequest,
  type GhPullRequestWrite,
  type GhRepo,
  type GhRepoDetailWrite,
  type GhRepoUpsert,
  isGhAuthorType,
  isGitHubDatabaseId,
  isGitHubLogin,
  isGitSha,
  isRecord,
  isStoredRefName,
} from "./types.ts";

/** 1束の別名の上限。 */
export const GH_DETAIL_BATCH_MAX = 20;

/** リポジトリごと、PRとIssueのそれぞれで取るページの上限。 */
export const GH_DETAIL_PAGE_LIMIT = 3;

/** 1周回に1人の所有者が束を分ける回数の上限。 */
export const GH_DETAIL_SPLIT_MAX = 8;

/** `rateLimit.remaining`がこれ未満なら、その所有者の詳細を始めない、または続けない。 */
export const GH_DETAIL_REMAINING_FLOOR = 500;

/** 詳細を取る対象のリポジトリ1件。 */
export type DetailTarget = {
  readonly repo: string;
  readonly repo_id: number;
  readonly open_pr_count: number;
  readonly labeled_issue_count: number;
  /** 結果を最後に書いた時刻。一度も着手していなければ`null`。 */
  readonly last_attempted_at: Date | null;
  /** 前回の着手が失敗した。数値IDが入れ替わったリポジトリは偽にする。 */
  readonly suspected: boolean;
};

/** 件数が0で、要求なしで閉じるリポジトリ。 */
export type ZeroCountRepo = {
  readonly repo: string;
  readonly repo_id: number;
};

export type RepoClassification = {
  /** 取る順に並べた対象。古い`last_attempted_at`が先で、一度も着手していないものが最初。 */
  readonly targets: readonly DetailTarget[];
  readonly zero_count: readonly ZeroCountRepo[];
  /** 段2では何もしないリポジトリの名前。 */
  readonly unusable: readonly string[];
};

/** 結果を書いた時刻の古い順。一度も着手していないものが先で、同じ値は名前の順。 */
function compareTargets(a: DetailTarget, b: DetailTarget): number {
  const left = a.last_attempted_at?.getTime() ?? Number.NEGATIVE_INFINITY;
  const right = b.last_attempted_at?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (left !== right) {
    return left < right ? -1 : 1;
  }
  if (a.repo === b.repo) {
    return 0;
  }
  return a.repo < b.repo ? -1 : 1;
}

/**
 * 一覧のリポジトリを、対象、件数0、使用不可に分ける。
 * `previous`は置き換えの前の`gh_repos`の全行で、今回の一覧に載らない行(前回から`gone`のものを含む)を使用不可にするために使う。
 * `replaced`は数値IDが入れ替わったリポジトリで、一度も着手していない疑いの無いものとして扱う。
 * 許可の外とarchivedのリポジトリは、件数があっても対象にしない。
 */
export function classifyRepos(args: {
  readonly listed: readonly GhRepoUpsert[];
  readonly previous: readonly GhRepo[];
  readonly replaced: readonly string[];
}): RepoClassification {
  const previousByRepo = new Map(
    args.previous.map((row) => [row.repo.toLowerCase(), row]),
  );
  const replaced = new Set(args.replaced.map((repo) => repo.toLowerCase()));
  const listedNames = new Set<string>();
  const targets: DetailTarget[] = [];
  const zeroCount: ZeroCountRepo[] = [];
  const unusable: string[] = [];
  for (const entry of args.listed) {
    const repo = entry.repo.toLowerCase();
    listedNames.add(repo);
    if (!entry.allowed || entry.archived) {
      unusable.push(repo);
      continue;
    }
    const openPrs = entry.open_pr_count ?? 0;
    const labeledIssues = entry.labeled_issue_count ?? 0;
    if (openPrs === 0 && labeledIssues === 0) {
      zeroCount.push({ repo, repo_id: entry.repo_id });
      continue;
    }
    const before = replaced.has(repo) ? undefined : previousByRepo.get(repo);
    targets.push({
      repo,
      repo_id: entry.repo_id,
      open_pr_count: openPrs,
      labeled_issue_count: labeledIssues,
      last_attempted_at: before?.last_attempted_at ?? null,
      suspected: before?.detail_failed === true,
    });
  }
  for (const [repo] of previousByRepo) {
    if (!listedNames.has(repo)) {
      unusable.push(repo);
    }
  }
  return {
    targets: targets.sort(compareTargets),
    zero_count: zeroCount.sort((a, b) => (a.repo < b.repo ? -1 : 1)),
    unusable: unusable.sort(),
  };
}

/** 残りの時間で、詳細の要求を始めてよいか。 */
export function canStartDetailRequest(remainingMs: number): boolean {
  return remainingMs >= GH_COLLECT_MIN_REQUEST_MS;
}

/** 解析に使う設定。ラベルの真偽は、収集の時点の設定で決める。 */
export type DetailParseConfig = {
  readonly review_label: string;
  readonly fix_label: string;
};

/** エラーを数える項目。PRの任意の4つと、Issueの作者。 */
export type OptionalErrorField = GhDetailOptionalField | "issue_author";

/** 任意の項目のエラーの件数。固定の項目名と丸めた`type`の組ごとに数える。 */
export type OptionalFieldError = {
  readonly field: OptionalErrorField;
  readonly type: AliasErrorType;
  readonly count: number;
};

/** 検査に通らず`NULL`にした列。値は持たない。 */
export type DetailDiscard = {
  readonly number: number;
  readonly column: string;
};

/** 応答の1ページ。 */
export type ParsedPage<T> = {
  readonly nodes: readonly T[];
  readonly total: number;
  readonly has_next: boolean;
  readonly end_cursor: string | null;
};

/** 別名1つの解析結果。 */
export type AliasParse =
  | {
      readonly kind: "ok";
      readonly pull_requests: ParsedPage<GhPullRequestWrite> | null;
      readonly issues: ParsedPage<GhIssueWrite> | null;
      readonly optional_errors: readonly OptionalFieldError[];
      readonly discarded: readonly DetailDiscard[];
    }
  | {
      readonly kind: "failed";
      readonly error_code: "graphql_error" | "parse_error";
      readonly null_nodes: number;
    };

/** GitHubが返す時刻(UTCのISO 8601)。読めなければ`null`。 */
function parseTimestamp(value: unknown): Date | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)
  ) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 接続の形。ノードは検査しない。 */
type RawConnection = {
  readonly total: number;
  readonly has_next: boolean;
  readonly end_cursor: string | null;
  readonly nodes: readonly unknown[];
};

function readConnection(raw: unknown): RawConnection | null {
  if (!isRecord(raw) || !isCount(raw.totalCount) || !Array.isArray(raw.nodes)) {
    return null;
  }
  const pageInfo = raw.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
    return null;
  }
  const cursor = pageInfo.endCursor;
  if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
    return null;
  }
  if (pageInfo.hasNextPage && typeof cursor !== "string") {
    return null;
  }
  return {
    total: raw.totalCount,
    has_next: pageInfo.hasNextPage,
    end_cursor: typeof cursor === "string" ? cursor : null,
    nodes: raw.nodes,
  };
}

/** 検査に通らず`null`にした列の記録。 */
type Discards = DetailDiscard[];

type ParsedAuthor = {
  readonly author_login: string | null;
  readonly author_type: GhAuthorType | null;
  readonly author_id: number | null;
};

const NO_AUTHOR: ParsedAuthor = {
  author_login: null,
  author_type: null,
  author_id: null,
};

/**
 * 作者を読む。項目のエラーがあるか、作者が削除されているとき、検査に通らないときは、3列とも`null`にする。
 * 数値IDが無い種別(`Mannequin`など)は、`author_id`だけ`null`にする。
 */
function readAuthor(
  raw: unknown,
  errored: boolean,
  number: number,
  discards: Discards,
): ParsedAuthor {
  if (errored || raw === null) {
    return NO_AUTHOR;
  }
  const discard = (column: string): ParsedAuthor => {
    discards.push({ number, column });
    return NO_AUTHOR;
  };
  if (!isRecord(raw) || !isGitHubLogin(raw.login)) {
    return discard("author_login");
  }
  if (!isGhAuthorType(raw.__typename)) {
    return discard("author_type");
  }
  const id = raw.databaseId;
  if (id !== null && id !== undefined && !isGitHubDatabaseId(id)) {
    return discard("author_id");
  }
  return {
    author_login: raw.login,
    author_type: raw.__typename,
    author_id: id ?? null,
  };
}

/** ブランチ名を読む。`null`は`null`のまま、検査に通らない名前は捨てて`null`にする。 */
function readRefName(
  raw: unknown,
  column: string,
  number: number,
  discards: Discards,
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (isStoredRefName(raw)) {
    return raw;
  }
  discards.push({ number, column });
  return null;
}

function readMergeable(
  raw: unknown,
  number: number,
  discards: Discards,
): GhMergeable | null {
  if (raw === "MERGEABLE" || raw === "CONFLICTING") {
    return raw;
  }
  if (raw !== "UNKNOWN") {
    discards.push({ number, column: "mergeable" });
  }
  return null;
}

/** 利用者の数値IDを集める。数値IDとして保存できないものは捨てる。 */
function collectIds(nodes: readonly unknown[]): number[] {
  const ids: number[] = [];
  for (const node of nodes) {
    if (isRecord(node) && isGitHubDatabaseId(node.databaseId)) {
      ids.push(node.databaseId);
    }
  }
  return ids;
}

type ParsedLabels = {
  readonly has_review_label: boolean | null;
  readonly has_fix_label: boolean | null;
};

/** ラベルの真偽を、収集の時点の設定で決める。名前は保存しない。100件を超えるときは不明にする。 */
function readLabels(
  raw: unknown,
  errored: boolean,
  config: DetailParseConfig,
  number: number,
  discards: Discards,
): ParsedLabels {
  const unknown: ParsedLabels = { has_review_label: null, has_fix_label: null };
  if (errored) {
    return unknown;
  }
  if (!isRecord(raw) || !isCount(raw.totalCount) || !Array.isArray(raw.nodes)) {
    discards.push({ number, column: "has_review_label" });
    return unknown;
  }
  if (raw.totalCount > raw.nodes.length) {
    return unknown;
  }
  const names = new Set<string>();
  for (const node of raw.nodes) {
    if (isRecord(node) && typeof node.name === "string") {
      names.add(node.name.toLowerCase());
    }
  }
  return {
    has_review_label: names.has(config.review_label.toLowerCase()),
    has_fix_label: names.has(config.fix_label.toLowerCase()),
  };
}

type ParsedReviewRequests = {
  readonly review_requested_user_ids: number[] | null;
  readonly team_review_requested: boolean | null;
};

/**
 * レビュー依頼を読む。利用者の数値IDを集め、チームの依頼か、依頼先が読めない依頼が1件でもあれば`team_review_requested`を真にする。
 * 項目のエラーや、20件を超える依頼では、2列とも不明にする。
 */
function readReviewRequests(
  raw: unknown,
  errored: boolean,
  number: number,
  discards: Discards,
): ParsedReviewRequests {
  const unknown: ParsedReviewRequests = {
    review_requested_user_ids: null,
    team_review_requested: null,
  };
  if (errored) {
    return unknown;
  }
  if (!isRecord(raw) || !isCount(raw.totalCount) || !Array.isArray(raw.nodes)) {
    discards.push({ number, column: "review_requested_user_ids" });
    return unknown;
  }
  if (raw.totalCount > raw.nodes.length) {
    return unknown;
  }
  const ids: number[] = [];
  let team = false;
  for (const node of raw.nodes) {
    const reviewer = isRecord(node) ? node.requestedReviewer : null;
    if (!isRecord(reviewer) || reviewer.__typename === "Team") {
      team = true;
    } else if (
      reviewer.__typename === "User" &&
      isGitHubDatabaseId(reviewer.databaseId)
    ) {
      ids.push(reviewer.databaseId);
    }
  }
  return { review_requested_user_ids: ids, team_review_requested: team };
}

function readAutoMerge(
  raw: unknown,
  number: number,
  discards: Discards,
): boolean | null {
  if (raw === null) {
    return false;
  }
  if (isRecord(raw)) {
    return true;
  }
  discards.push({ number, column: "auto_merge_enabled" });
  return null;
}

/** PRのノード1件を読む。必須の項目が検査に通らなければ`null`。 */
function readPullRequest(
  raw: unknown,
  errored: ReadonlySet<GhDetailOptionalField>,
  config: DetailParseConfig,
  discards: Discards,
): GhPullRequestWrite | null {
  if (!isRecord(raw) || !isGitHubDatabaseId(raw.number)) {
    return null;
  }
  const number = raw.number;
  const createdAt = parseTimestamp(raw.createdAt);
  const updatedAt = parseTimestamp(raw.updatedAt);
  if (
    createdAt === null ||
    updatedAt === null ||
    typeof raw.isDraft !== "boolean" ||
    typeof raw.isCrossRepository !== "boolean" ||
    !isGitSha(raw.headRefOid)
  ) {
    return null;
  }
  const assignees = raw.assignees;
  if (
    !isRecord(assignees) ||
    !isCount(assignees.totalCount) ||
    !Array.isArray(assignees.nodes)
  ) {
    return null;
  }
  return {
    number,
    head_sha: raw.headRefOid,
    head_ref: readRefName(raw.headRefName, "head_ref", number, discards),
    base_ref: readRefName(raw.baseRefName, "base_ref", number, discards),
    is_draft: raw.isDraft,
    is_cross_repository: raw.isCrossRepository,
    auto_merge_enabled: errored.has("autoMergeRequest")
      ? null
      : readAutoMerge(raw.autoMergeRequest, number, discards),
    ...readAuthor(raw.author, errored.has("author"), number, discards),
    mergeable: readMergeable(raw.mergeable, number, discards),
    ...readLabels(raw.labels, errored.has("labels"), config, number, discards),
    ...readReviewRequests(
      raw.reviewRequests,
      errored.has("reviewRequests"),
      number,
      discards,
    ),
    assignee_ids:
      assignees.totalCount > assignees.nodes.length
        ? null
        : collectIds(assignees.nodes),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/** Issueのノード1件を読む。必須の項目が検査に通らなければ`null`。 */
function readIssue(
  raw: unknown,
  authorErrored: boolean,
  discards: Discards,
): GhIssueWrite | null {
  if (!isRecord(raw) || !isGitHubDatabaseId(raw.number)) {
    return null;
  }
  const createdAt = parseTimestamp(raw.createdAt);
  const updatedAt = parseTimestamp(raw.updatedAt);
  if (createdAt === null || updatedAt === null) {
    return null;
  }
  return {
    number: raw.number,
    ...readAuthor(raw.author, authorErrored, raw.number, discards),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/** 別名のエラーから、ノードの添字ごとの任意の項目のエラーと、件数の集計を作る。 */
function collectFieldErrors(errors: readonly AliasError[]): {
  readonly pr: Map<number, Set<GhDetailOptionalField>>;
  readonly issue: Set<number>;
  readonly counts: OptionalFieldError[];
} {
  const pr = new Map<number, Set<GhDetailOptionalField>>();
  const issue = new Set<number>();
  const counts = new Map<string, OptionalFieldError>();
  const count = (field: OptionalErrorField, type: AliasErrorType): void => {
    const key = `${field}|${type}`;
    const before = counts.get(key);
    counts.set(key, { field, type, count: (before?.count ?? 0) + 1 });
  };
  for (const error of errors) {
    if (error.target.kind === "pr_field") {
      const fields = pr.get(error.target.index) ?? new Set();
      fields.add(error.target.field);
      pr.set(error.target.index, fields);
      count(error.target.field, error.type);
    } else if (error.target.kind === "issue_field") {
      issue.add(error.target.index);
      count("issue_author", error.type);
    }
  }
  return { pr, issue, counts: [...counts.values()] };
}

function countNulls(nodes: readonly unknown[]): number {
  return nodes.filter((node) => node === null).length;
}

/**
 * 別名1つ(1つのリポジトリ)の応答を解析する。
 * `alias_errors`はその別名のエラーだけを渡す。別名の水準のエラーは、値の検査より先に失敗(`graphql_error`)にする。
 * `repository`が`null`、数値IDの違い、`nodes`の`null`の要素、必須の項目の検査の失敗は`parse_error`にする。
 * 任意の項目(`labels`、`reviewRequests`、`author`、`autoMergeRequest`)のエラーは、その項目の列だけを`null`にする。
 */
export function parseRepoDetailAlias(args: {
  readonly raw: unknown;
  readonly repo_id: number;
  readonly want_pull_requests: boolean;
  readonly want_issues: boolean;
  readonly alias_errors: readonly AliasError[];
  readonly config: DetailParseConfig;
}): AliasParse {
  const failed = (
    errorCode: "graphql_error" | "parse_error",
    nullNodes = 0,
  ): AliasParse => ({
    kind: "failed",
    error_code: errorCode,
    null_nodes: nullNodes,
  });
  if (args.alias_errors.some((error) => error.target.kind === "alias")) {
    return failed("graphql_error");
  }
  const raw = args.raw;
  if (!isRecord(raw) || raw.databaseId !== args.repo_id) {
    return failed("parse_error");
  }
  const prConnection = args.want_pull_requests
    ? readConnection(raw.pullRequests)
    : null;
  const issueConnection = args.want_issues ? readConnection(raw.issues) : null;
  if (
    (args.want_pull_requests && prConnection === null) ||
    (args.want_issues && issueConnection === null)
  ) {
    return failed("parse_error");
  }
  const nullNodes =
    countNulls(prConnection?.nodes ?? []) +
    countNulls(issueConnection?.nodes ?? []);
  if (nullNodes > 0) {
    return failed("parse_error", nullNodes);
  }
  const fieldErrors = collectFieldErrors(args.alias_errors);
  const discarded: Discards = [];
  let pullRequests: ParsedPage<GhPullRequestWrite> | null = null;
  if (prConnection !== null) {
    const nodes: GhPullRequestWrite[] = [];
    for (const [index, node] of prConnection.nodes.entries()) {
      const row = readPullRequest(
        node,
        fieldErrors.pr.get(index) ?? new Set(),
        args.config,
        discarded,
      );
      if (row === null) {
        return failed("parse_error");
      }
      nodes.push(row);
    }
    pullRequests = {
      nodes,
      total: prConnection.total,
      has_next: prConnection.has_next,
      end_cursor: prConnection.end_cursor,
    };
  }
  let issues: ParsedPage<GhIssueWrite> | null = null;
  if (issueConnection !== null) {
    const nodes: GhIssueWrite[] = [];
    for (const [index, node] of issueConnection.nodes.entries()) {
      const row = readIssue(node, fieldErrors.issue.has(index), discarded);
      if (row === null) {
        return failed("parse_error");
      }
      nodes.push(row);
    }
    issues = {
      nodes,
      total: issueConnection.total,
      has_next: issueConnection.has_next,
      end_cursor: issueConnection.end_cursor,
    };
  }
  return {
    kind: "ok",
    pull_requests: pullRequests,
    issues,
    optional_errors: fieldErrors.counts,
    discarded,
  };
}

function sameIds(
  a: readonly number[] | null,
  b: readonly number[] | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameAuthor(a: ParsedAuthor, b: ParsedAuthor): boolean {
  return (
    a.author_login === b.author_login &&
    a.author_type === b.author_type &&
    a.author_id === b.author_id
  );
}

/** 前回の行が、今回の値と同じ(書き直す必要が無い)か。`repo_id`と`usable`と`state`も比べる。 */
function samePullRequest(
  before: GhPullRequest,
  next: GhPullRequestWrite,
  repoId: number,
): boolean {
  return (
    before.repo_id === repoId &&
    before.usable &&
    before.state === "open" &&
    before.head_sha === next.head_sha &&
    before.head_ref === next.head_ref &&
    before.base_ref === next.base_ref &&
    before.is_draft === next.is_draft &&
    before.is_cross_repository === next.is_cross_repository &&
    before.auto_merge_enabled === next.auto_merge_enabled &&
    sameAuthor(before, next) &&
    before.mergeable === next.mergeable &&
    before.has_review_label === next.has_review_label &&
    before.has_fix_label === next.has_fix_label &&
    sameIds(before.review_requested_user_ids, next.review_requested_user_ids) &&
    sameIds(before.assignee_ids, next.assignee_ids) &&
    before.team_review_requested === next.team_review_requested &&
    before.created_at.getTime() === next.created_at.getTime() &&
    before.updated_at.getTime() === next.updated_at.getTime()
  );
}

function sameIssue(
  before: GhIssue,
  next: GhIssueWrite,
  repoId: number,
): boolean {
  return (
    before.repo_id === repoId &&
    before.usable &&
    before.state === "open" &&
    sameAuthor(before, next) &&
    before.created_at.getTime() === next.created_at.getTime() &&
    before.updated_at.getTime() === next.updated_at.getTime()
  );
}

/**
 * 前回の行と今回の値を比べて、書く行(差分)と、残す番号の全体を決める。
 * 前回の行は、所有者の開いている行から、このリポジトリの分だけを使う。
 * 数値ID、`usable`、`state`が違う行も、書き直す差分に入れる。
 * `mergeable`は前回の値を保たず、今回の値をそのまま書く。
 * 取らなかった側(件数が0の側)は、空の一覧を渡す。残す番号が空になり、開いている行はすべて閉じる。
 */
export function planRepoDetailWrite(args: {
  readonly owner: string;
  readonly repo: string;
  readonly repo_id: number;
  readonly observed_at: Date;
  readonly previous_prs: readonly GhPullRequest[];
  readonly previous_issues: readonly GhIssue[];
  readonly prs: readonly GhPullRequestWrite[];
  readonly issues: readonly GhIssueWrite[];
}): GhRepoDetailWrite {
  const previousPrs = new Map(
    args.previous_prs
      .filter((row) => row.repo === args.repo && row.state === "open")
      .map((row) => [row.number, row]),
  );
  const previousIssues = new Map(
    args.previous_issues
      .filter((row) => row.repo === args.repo && row.state === "open")
      .map((row) => [row.number, row]),
  );
  return {
    owner: args.owner,
    repo: args.repo,
    repo_id: args.repo_id,
    observed_at: args.observed_at,
    pr_rows: args.prs.filter((row) => {
      const before = previousPrs.get(row.number);
      return (
        before === undefined || !samePullRequest(before, row, args.repo_id)
      );
    }),
    pr_keep: args.prs.map((row) => row.number),
    issue_rows: args.issues.filter((row) => {
      const before = previousIssues.get(row.number);
      return before === undefined || !sameIssue(before, row, args.repo_id);
    }),
    issue_keep: args.issues.map((row) => row.number),
  };
}

/** リポジトリが失敗した理由。実行の行の`error_code`にそのまま使う。 */
export type DetailFailureCode =
  | "graphql_error"
  | "parse_error"
  | "timeout"
  | "http_5xx";

/** 所有者の詳細を止めた理由。 */
export type DetailStop =
  | {
      readonly error_code:
        | "unauthorized"
        | "forbidden"
        | "rate_limited"
        | "secondary_limit";
      readonly next_allowed_at: Date | null;
    }
  | { readonly error_code: "db_error"; readonly next_allowed_at: null };

/** 所有者の詳細の集計。 */
export type DetailTally = {
  readonly targets: number;
  /** `writeGhRepoDetail`が`written`を返したリポジトリの数。 */
  readonly done: number;
  readonly truncated: number;
  /** 失敗したリポジトリごとの失敗の理由。 */
  readonly failed: readonly DetailFailureCode[];
};

export type DetailOutcome = {
  readonly ok: boolean;
  readonly error_code: GhCollectErrorCode | null;
  readonly stage: "detail" | null;
  readonly next_allowed_at: Date | null;
};

/** 失敗の理由の優先順。権限や問い合わせの誤りを、一時的な障害に紛れさせない。 */
const FAILURE_PRECEDENCE: readonly DetailFailureCode[] = [
  "graphql_error",
  "parse_error",
  "timeout",
  "http_5xx",
];

/**
 * 所有者の詳細の結果を、実行の行の`ok`、`error_code`、`stage`に分類する。
 * - 所有者単位の停止(401、403、レート制限、DBの失敗)は、失敗にする。
 * - 対象があり、取り終えたか打ち切ったリポジトリが無く、失敗が1件以上なら、失敗の中で優先の高い理由で失敗にする。
 * - 対象があり、取り終えたか打ち切ったリポジトリも失敗も無ければ、`deadline`で失敗にする。
 * - 上のどれにも当たらなければ成功にする。
 */
export function classifyDetailOutcome(args: {
  readonly tally: DetailTally;
  readonly stop: DetailStop | null;
}): DetailOutcome {
  const { tally, stop } = args;
  if (stop !== null) {
    return {
      ok: false,
      error_code: stop.error_code,
      stage: "detail",
      next_allowed_at: stop.next_allowed_at,
    };
  }
  if (tally.targets > 0 && tally.done + tally.truncated === 0) {
    const code = FAILURE_PRECEDENCE.find((entry) =>
      tally.failed.includes(entry),
    );
    return {
      ok: false,
      error_code: code ?? "deadline",
      stage: "detail",
      next_allowed_at: null,
    };
  }
  return { ok: true, error_code: null, stage: null, next_allowed_at: null };
}

/** 捨てた記録のログのフィールド。固定の語、owner、repo、番号、列の名前だけを持つ。 */
export function detailDiscardLogFields(args: {
  readonly owner: string;
  readonly repo: string;
  readonly discard: DetailDiscard;
}): Record<string, string | number> {
  return {
    owner: args.owner,
    repo: args.repo,
    number: args.discard.number,
    column: args.discard.column,
  };
}
