// `poll_issues`が、トリガーラベル付きのIssueを見つける元(検索か収集の表)の切り替えを持つ。
// 表の行は候補を絞るだけに使い、候補に入れる前にRESTで読み直して、開いていて今も対象であることを確かめる。
// 表を使えない所有者は、その所有者の全体を検索に戻す。リポジトリ単位の戻し先は無い。

import { configuredRepos, isRepoAllowed } from "./config.ts";
import {
  judgeGhOwnerCoverage,
  judgeGhOwnerIssueRepos,
} from "./gh_collect_read.ts";
import type {
  Issue,
  IssueSearchItem,
  PrSearchItem,
  PullRequest,
  Viewer,
} from "./github.ts";
import type { Logger } from "./log.ts";
import {
  type FactoryConfig,
  type FactoryOwner,
  type GhIssue,
  type GhOwnerOpenIssueSnapshot,
  type GhPullRequest,
  type GhSource,
  hasLabel,
} from "./types.ts";

/**
 * Issueの稼働中の作業項目を引く鍵。
 * GitHubのownerとrepoは大文字小文字を区別しないので、綴りが違っても同じIssueを引けるよう小文字にする。
 */
export function issueKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${String(number)}`.toLowerCase();
}

export type TableIssueCheck =
  | { readonly kind: "ok"; readonly item: IssueSearchItem }
  | { readonly kind: "drop"; readonly reason: "closed" | "label_absent" }
  | { readonly kind: "mismatch" };

/**
 * 表の候補を`getIssue`の応答で確かめ、候補の項目を作る。
 * 応答のリポジトリか番号が表の行と違うときは`mismatch`で、名前の付け替えか移管の途中である。
 * 閉じているか、トリガーラベルが外れているときは`drop`にする。
 * 外れたラベルの付与者を読むと、偽の`labeler_denied`を残すためである。
 * 項目のownerとrepoは応答の綴りにする。検索の経路と同じ綴りで作業項目を作るためである。
 */
export function confirmTableIssue(
  row: GhIssue,
  issue: Issue,
  triggerLabel: string,
): TableIssueCheck {
  const repository = issue.repository;
  if (
    repository === null ||
    repository.owner.toLowerCase() !== row.owner.toLowerCase() ||
    repository.repo.toLowerCase() !== row.repo.toLowerCase() ||
    issue.number !== row.number
  ) {
    return { kind: "mismatch" };
  }
  if (issue.state !== "open") {
    return { kind: "drop", reason: "closed" };
  }
  if (!hasLabel(issue.labels, triggerLabel)) {
    return { kind: "drop", reason: "label_absent" };
  }
  return {
    kind: "ok",
    item: {
      owner: repository.owner,
      repo: repository.repo,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      htmlUrl: issue.htmlUrl,
      authorLogin: issue.authorLogin,
    },
  };
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

/** 設定で明示したリポジトリのうち、この所有者のものの小文字の名前。 */
function requiredRepos(
  scope: Pick<FactoryConfig, "repo_allowlist" | "factory_repo">,
  owner: string,
): Set<string> {
  const ownerName = owner.toLowerCase();
  return new Set(
    configuredRepos(scope)
      .filter((entry) => entry.owner.toLowerCase() === ownerName)
      .map((entry) => entry.repo.toLowerCase()),
  );
}

/**
 * トリガーラベル付きのIssueを見つける。照合を通った所有者ごとに行う。
 * `search`なら、所有者ごとに検索する。
 * `db`なら、所有者の全体を表で探し、使えない所有者だけ検索に戻す。使えないのは次のときである。
 * - 表を読めなかった。失敗として記録する。
 * - 記録が古い、または設定で明示したリポジトリを表で使えない。失敗にはしない。
 * 表の候補は`getIssue`で確かめ直し、開いていてトリガーラベルが付いたものだけを項目にする。
 * 返す項目の並びは、検索の結果の後に、表の候補を(リポジトリ、番号)の順に置く。
 * 失敗はこの関数の中で記録し、件数を`failed`で返す。
 */
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
  deps: {
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
  let failed = 0;
  let fallbackSearches = 0;
  let tableCandidates = 0;
  let tableDropped = 0;
  const fallbackReasons: Record<string, number> = {};
  const searched: IssueSearchItem[] = [];
  const tableRows: GhIssue[] = [];

  const fail = async (step: string, err: unknown) => {
    failed += 1;
    await deps.recordFailure(step, err);
  };
  const search = async (owner: FactoryOwner) => {
    try {
      searched.push(...(await deps.searchIssues(owner)));
    } catch (err) {
      await fail(`search_issues:${owner.name}`, err);
    }
  };
  const isAllowedNow = (owner: string, repo: string) =>
    isRepoAllowed(input.scope, owner, repo);

  for (const owner of input.owners) {
    if (input.source !== "db") {
      await search(owner);
      continue;
    }
    let reason: string | null = null;
    let snapshot: GhOwnerOpenIssueSnapshot | null = null;
    try {
      snapshot = await deps.readOwnerIssues(owner.name);
    } catch (err) {
      await fail(`read_gh_owner_issues:${owner.name}`, err);
      reason = "read_failed";
    }
    if (snapshot !== null) {
      const judged = judgeGhOwnerIssueRepos(
        owner.name,
        snapshot,
        input.staleAfterMs,
      );
      const coverage = judgeGhOwnerCoverage(
        owner.name,
        judged,
        isAllowedNow,
        requiredRepos(input.scope, owner.name),
      );
      if (coverage.kind === "stale") {
        reason = coverage.reason;
      } else {
        for (const name of [...judged.keys()].sort()) {
          const item = judged.get(name);
          if (item === undefined) continue;
          if (
            !isAllowedNow(owner.name, item.row.repo) ||
            item.row.archived ||
            item.row.gone
          ) {
            continue;
          }
          tableRows.push(
            ...[...item.usable].sort((a, b) => a.number - b.number),
          );
        }
      }
    }
    if (reason !== null) {
      fallbackSearches += 1;
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
      await search(owner);
    }
  }

  const confirmed: IssueSearchItem[] = [];
  for (const row of tableRows) {
    const target = `${row.owner}/${row.repo}#${String(row.number)}`;
    tableCandidates += 1;
    let issue: Issue;
    try {
      issue = await deps.getIssue(row.owner, row.repo, row.number);
    } catch (err) {
      await fail(`confirm_table_issue:${target}`, err);
      continue;
    }
    const check = confirmTableIssue(row, issue, input.triggerLabel);
    if (check.kind === "ok") {
      confirmed.push(check.item);
    } else if (check.kind === "drop") {
      tableDropped += 1;
      input.log.info("table issue dropped by the REST check", {
        target,
        reason: check.reason,
      });
    } else {
      await fail(
        `confirm_table_issue:${target}`,
        new Error("table issue does not match the issue read from GitHub"),
      );
    }
  }

  return {
    items: [...searched, ...confirmed],
    failed,
    stats: {
      source: input.source,
      fallback_searches: fallbackSearches,
      fallback_reasons: fallbackReasons,
      table_candidates: tableCandidates,
      table_dropped: tableDropped,
    },
  };
}

/**
 * 表のPRの行が、検索の4本(依頼、assignee、レビューのラベル、修正のラベル)のどれかに当たるかの分類。
 * - `target`: 当たる。
 * - `team`: チームへの依頼か、依頼先を読めない依頼があり、PATのアカウントに宛てた依頼かを表では決められない。
 * - `maybe`: ラベルかassigneeが不明で、当たるかをRESTで確かめる。
 * - `none`: 当たらない。
 * 下書きとforkのPRも絞らない。検索も絞らず、判定がRESTの値で扱う。
 */
export type PollPrRowClass = "target" | "maybe" | "team" | "none";

/**
 * 表の行を分類する。`viewerId`はPATのアカウントの数値IDで、依頼とassigneeはIDで比べる。
 * 上から当てて、最初に当たったものを採る。
 * 1. ラベルか、PATのアカウントへの依頼かassigneeに当たれば`target`。
 * 2. チームへの依頼が真か不明、または直接の依頼先が不明なら`team`。
 *    片方だけが不明の行でも、直接の依頼を判定できないので`team`にする。
 * 3. ラベルかassigneeが不明なら`maybe`。
 * 4. それ以外は`none`。
 */
export function classifyPollPrRow(
  row: GhPullRequest,
  viewerId: number,
): PollPrRowClass {
  if (
    row.has_review_label === true ||
    row.has_fix_label === true ||
    row.review_requested_user_ids?.includes(viewerId) === true ||
    row.assignee_ids?.includes(viewerId) === true
  ) {
    return "target";
  }
  if (
    row.team_review_requested !== false ||
    row.review_requested_user_ids === null
  ) {
    return "team";
  }
  if (
    row.has_review_label === null ||
    row.has_fix_label === null ||
    row.assignee_ids === null
  ) {
    return "maybe";
  }
  return "none";
}

export type TablePrCheck =
  | { readonly kind: "ok"; readonly item: PrSearchItem }
  | { readonly kind: "drop"; readonly reason: "closed" | "not_target" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "unknown_reviewers" };

/** 表の候補を、RESTの応答で確かめる。 */
export function confirmTablePr(
  _row: GhPullRequest,
  _pr: PullRequest,
  _asIssue: Issue,
  _viewer: Viewer,
  _labels: { readonly reviewLabel: string; readonly fixLabel: string },
): TablePrCheck {
  return { kind: "drop", reason: "not_target" };
}
