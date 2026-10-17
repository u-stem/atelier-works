// 1人の所有者の1周回の詳細の取得を進める状態機械。通信もDBも持たない。
// 待ち行列(健全な列と疑いの列)、束の組み立てと分割、ページ送り、リポジトリごとの結果の確定を持つ。
// 呼び出し側が、`nextBatch`で次の束を受け取り、要求を送り、応答を`onResponse`に渡す。
// 周回の終わりには`close`を呼び、取り終えていないリポジトリの結果を確定する。

import type {
  DetailDiscard,
  DetailFailureCode,
  DetailParseConfig,
  DetailStop,
  DetailTarget,
  OptionalFieldError,
} from "./gh_collect_detail.ts";
import type { GraphqlResponse } from "./gh_graphql.ts";
import type { GhIssueWrite, GhPullRequestWrite } from "./types.ts";

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

/** 所有者の対象から、周回の状態を作る。 */
export function startDetailRound(_args: {
  readonly owner: string;
  readonly targets: readonly DetailTarget[];
  readonly label: string;
  readonly config: DetailParseConfig;
  readonly batch_max?: number;
  readonly split_max?: number;
  readonly page_limit?: number;
}): DetailRound {
  const empty: BatchResult = {
    settlements: [],
    stop: null,
    rate: null,
    optional_errors: [],
    null_nodes: 0,
    discarded: [],
    split: false,
  };
  return {
    nextBatch: () => null,
    requestFor: () => ({ aliases: 0, variables: {} }),
    onResponse: () => empty,
    onException: () => empty,
    pending: () => false,
    close: () => [],
  };
}
