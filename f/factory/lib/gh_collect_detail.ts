// GitHubの収集の詳細(開いているPRとトリガーラベル付きIssue)の判定を、通信もDBも持たない純粋関数としてまとめる。
// 対象の選別、応答の解析、保存する値の検査、差分と書き込みの計画、実行の結果の分類を持つ。
// 外から来た値は、例外を投げない述語で検査する。値は戻り値にもログにも例外の文にも出さない。

import type { AliasError, AliasErrorType } from "./gh_graphql.ts";
import type {
  GhCollectErrorCode,
  GhDetailOptionalField,
  GhIssue,
  GhIssueWrite,
  GhPullRequest,
  GhPullRequestWrite,
  GhRepo,
  GhRepoDetailWrite,
  GhRepoUpsert,
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

/** 一覧のリポジトリを、対象、件数0、使用不可に分ける。 */
export function classifyRepos(_args: {
  readonly listed: readonly GhRepoUpsert[];
  readonly previous: readonly GhRepo[];
  readonly replaced: readonly string[];
}): RepoClassification {
  return { targets: [], zero_count: [], unusable: [] };
}

/** 残りの時間で、詳細の要求を始めてよいか。 */
export function canStartDetailRequest(_remainingMs: number): boolean {
  return false;
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

/**
 * 別名1つ(1つのリポジトリ)の応答を解析する。
 * `alias_errors`はその別名のエラーだけを渡す。別名の水準のエラーは、値の検査より先に失敗にする。
 */
export function parseRepoDetailAlias(_args: {
  readonly raw: unknown;
  readonly repo_id: number;
  readonly want_pull_requests: boolean;
  readonly want_issues: boolean;
  readonly alias_errors: readonly AliasError[];
  readonly config: DetailParseConfig;
}): AliasParse {
  return { kind: "failed", error_code: "parse_error", null_nodes: 0 };
}

/** 前回の行と今回の値を比べて、書く行と、残す番号の全体を決める。 */
export function planRepoDetailWrite(_args: {
  readonly owner: string;
  readonly repo: string;
  readonly repo_id: number;
  readonly observed_at: Date;
  readonly previous_prs: readonly GhPullRequest[];
  readonly previous_issues: readonly GhIssue[];
  readonly prs: readonly GhPullRequestWrite[];
  readonly issues: readonly GhIssueWrite[];
}): GhRepoDetailWrite {
  return {
    owner: "",
    repo: "",
    repo_id: 0,
    observed_at: new Date(0),
    pr_rows: [],
    pr_keep: [],
    issue_rows: [],
    issue_keep: [],
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

/** 所有者の詳細の結果を、実行の行の`ok`、`error_code`、`stage`に分類する。 */
export function classifyDetailOutcome(_args: {
  readonly tally: DetailTally;
  readonly stop: DetailStop | null;
}): DetailOutcome {
  return { ok: false, error_code: null, stage: null, next_allowed_at: null };
}

/** 捨てた記録のログのフィールド。固定の語、owner、repo、番号、列の名前だけを持つ。 */
export function detailDiscardLogFields(_args: {
  readonly owner: string;
  readonly repo: string;
  readonly discard: DetailDiscard;
}): Record<string, string | number> {
  return {};
}
