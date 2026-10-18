// `poll_issues`が、トリガーラベル付きのIssueを見つける元(検索か収集の表)の切り替えを持つ。
// 表の行は候補を絞るだけに使い、候補に入れる前にRESTで読み直して、開いていて今も対象であることを確かめる。

import type { Issue, IssueSearchItem } from "./github.ts";
import type { Logger } from "./log.ts";
import type {
  FactoryConfig,
  FactoryOwner,
  GhIssue,
  GhOwnerOpenIssueSnapshot,
  GhSource,
} from "./types.ts";

/** Issueの稼働中の作業項目を引く鍵。 */
export function issueKey(
  _owner: string,
  _repo: string,
  _number: number,
): string {
  return "";
}

export type TableIssueCheck =
  | { readonly kind: "ok"; readonly item: IssueSearchItem }
  | { readonly kind: "drop"; readonly reason: "closed" | "label_absent" }
  | { readonly kind: "mismatch" };

/** 表の候補を`getIssue`の応答で確かめ、候補の項目を作る。 */
export function confirmTableIssue(
  _row: GhIssue,
  _issue: Issue,
  _triggerLabel: string,
): TableIssueCheck {
  return { kind: "mismatch" };
}

export type PollSourceStats = {
  readonly source: GhSource;
  readonly fallback_searches: number;
  readonly fallback_reasons: Readonly<Record<string, number>>;
  /** RESTで確かめ直した表の候補の数。 */
  readonly table_candidates: number;
  /** RESTで対象でないと分かって外した表の候補の数。 */
  readonly table_dropped: number;
};

export async function discoverIssues(
  input: {
    readonly source: GhSource;
    readonly owners: readonly FactoryOwner[];
    readonly scope: Pick<
      FactoryConfig,
      "owners" | "repo_allowlist" | "factory_repo"
    >;
    readonly triggerLabel: string;
    readonly staleAfterMs: number;
    readonly log: Logger;
  },
  _deps: {
    readonly searchIssues: (owner: FactoryOwner) => Promise<IssueSearchItem[]>;
    readonly readOwnerIssues: (
      owner: string,
    ) => Promise<GhOwnerOpenIssueSnapshot>;
    readonly getIssue: (
      owner: string,
      repo: string,
      number: number,
    ) => Promise<Issue>;
    readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  },
): Promise<{
  items: IssueSearchItem[];
  failed: number;
  stats: PollSourceStats;
}> {
  return {
    items: [],
    failed: 0,
    stats: {
      source: input.source,
      fallback_searches: 0,
      fallback_reasons: {},
      table_candidates: 0,
      table_dropped: 0,
    },
  };
}
