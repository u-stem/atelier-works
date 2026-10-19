// `poll_issues`と`poll_prs`が、トリガーのIssueとPRを見つける元(検索か収集の表)の切り替えを持つ。
// 表の行は候補を絞るだけに使い、候補に入れる前にRESTで読み直して、開いていて今も対象であることを確かめる。
// 表を使えない所有者は、その所有者の全体を検索に戻す。リポジトリ単位の戻し先は無い。

import { isRepoAllowed } from "./config.ts";
import {
  judgeGhOwnerCoverage,
  judgeGhOwnerIssueRepos,
  judgeGhOwnerRepos,
  requiredRepos,
  usableTableRows,
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
  type GhOwnerOpenPrSnapshot,
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
        tableRows.push(...usableTableRows(owner.name, judged, isAllowedNow));
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

/**
 * 表のPRの候補を、`getPr`と`getIssue`の応答で確かめ、候補の項目を作る。
 * 上から当てて、最初に当たったものを採る。
 * 1. 応答のリポジトリか番号が表の行と違うなら`mismatch`。名前の付け替えか移管の途中である。
 * 2. 閉じていれば`drop`(`closed`)。
 * 3. レビューか修正のラベル、またはPATのアカウントのassigneeがあれば`ok`。
 * 4. 依頼先を読めなければ`unknown_reviewers`。決められないまま外すと、依頼で起きるはずのレビューが黙って止まる。
 * 5. PATのアカウントへの依頼があれば`ok`。
 * 6. それ以外は`drop`(`not_target`)。
 * チームへの依頼はRESTでも一員かを決められないので、`not_target`になる。
 * 項目のownerとrepoは応答の綴りにする。検索の経路と同じ綴りで作業項目を作るためである。
 */
export function confirmTablePr(
  row: GhPullRequest,
  pr: PullRequest,
  asIssue: Issue,
  viewer: Viewer,
  labels: { readonly reviewLabel: string; readonly fixLabel: string },
): TablePrCheck {
  const repository = asIssue.repository;
  if (
    repository === null ||
    repository.owner.toLowerCase() !== row.owner.toLowerCase() ||
    repository.repo.toLowerCase() !== row.repo.toLowerCase() ||
    asIssue.number !== row.number ||
    pr.number !== row.number
  ) {
    return { kind: "mismatch" };
  }
  if (pr.state !== "open") {
    return { kind: "drop", reason: "closed" };
  }
  const viewerLogin = viewer.login.toLowerCase();
  const matched =
    hasLabel(asIssue.labels, labels.reviewLabel) ||
    hasLabel(asIssue.labels, labels.fixLabel) ||
    asIssue.assignees.some((login) => login.toLowerCase() === viewerLogin);
  if (!matched) {
    if (pr.requestedReviewerIds === null) {
      return { kind: "unknown_reviewers" };
    }
    if (!pr.requestedReviewerIds.includes(viewer.id)) {
      return { kind: "drop", reason: "not_target" };
    }
  }
  return {
    kind: "ok",
    item: {
      owner: repository.owner,
      repo: repository.repo,
      number: row.number,
      title: pr.title,
      htmlUrl: `https://github.com/${repository.owner}/${repository.repo}/pull/${String(row.number)}`,
    },
  };
}

/**
 * ラベル、レビューの依頼、assigneeのPRを見つける。照合を通った所有者ごとに行う。
 * `search`なら、所有者ごとに検索する。
 * `db`なら、所有者の全体を表で探し、使えない所有者だけ検索に戻す。使えないのは次のときである。
 * - 表を読めなかった。失敗として記録する。
 * - 記録が古い、または設定で明示したリポジトリを表で使えない。失敗にはしない。
 * - チームへのレビューの依頼か、依頼先の読めない依頼が付いた行がある。
 *   表ではPATのアカウントに宛てた依頼かを決められず、検索なら見つけるものを取りこぼすためである。
 *   この所有者の表の候補は、確かめずに捨てる。
 * 表の候補は`getPr`と`getIssue`で確かめ直し、今も対象のものだけを項目にする。
 * 確かめ直しはPRを1件ずつ順に処理し、1件の中の2本だけを並列にする。GitHubへの同時の要求を増やさないためである。
 * 返す項目の並びは、検索の結果の後に、表の候補を(リポジトリ、番号)の順に置く。PRの鍵(小文字)で重ねを除く。
 * 失敗はこの関数の中で記録し、件数を`failed`で返す。
 */
export async function discoverPrs(
  input: {
    readonly source: GhSource;
    readonly owners: readonly FactoryOwner[];
    readonly scope: Pick<
      FactoryConfig,
      "owners" | "repo_allowlist" | "factory_repo"
    >;
    readonly viewer: Viewer;
    readonly labels: {
      readonly reviewLabel: string;
      readonly fixLabel: string;
    };
    readonly staleAfterMs: number;
    readonly log: Logger;
  },
  deps: {
    readonly searchPrs: (owner: FactoryOwner) => Promise<PrSearchItem[]>;
    readonly readOwnerPrs: (owner: string) => Promise<GhOwnerOpenPrSnapshot>;
    readonly getPr: (
      owner: string,
      repo: string,
      number: number,
    ) => Promise<PullRequest>;
    readonly getIssue: (
      owner: string,
      repo: string,
      number: number,
    ) => Promise<Issue>;
    readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  },
): Promise<{
  items: PrSearchItem[];
  failed: number;
  stats: PollSourceStats;
}> {
  let failed = 0;
  let fallbackSearches = 0;
  let tableCandidates = 0;
  let tableDropped = 0;
  const fallbackReasons: Record<string, number> = {};
  const searched: PrSearchItem[] = [];
  const tableRows: GhPullRequest[] = [];

  const fail = async (step: string, err: unknown) => {
    failed += 1;
    await deps.recordFailure(step, err);
  };
  const search = async (owner: FactoryOwner) => {
    try {
      searched.push(...(await deps.searchPrs(owner)));
    } catch (err) {
      await fail(`search_prs:${owner.name}`, err);
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
    let snapshot: GhOwnerOpenPrSnapshot | null = null;
    try {
      snapshot = await deps.readOwnerPrs(owner.name);
    } catch (err) {
      await fail(`read_gh_owner_prs:${owner.name}`, err);
      reason = "read_failed";
    }
    if (snapshot !== null) {
      const judged = judgeGhOwnerRepos(
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
        const classified = usableTableRows(
          owner.name,
          judged,
          isAllowedNow,
        ).map((row) => ({
          row,
          kind: classifyPollPrRow(row, input.viewer.id),
        }));
        if (classified.some((entry) => entry.kind === "team")) {
          reason = "team_review";
        } else {
          for (const entry of classified) {
            if (entry.kind === "target" || entry.kind === "maybe") {
              tableRows.push(entry.row);
            }
          }
        }
      }
    }
    if (reason !== null) {
      fallbackSearches += 1;
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
      await search(owner);
    }
  }

  const confirmed: PrSearchItem[] = [];
  for (const row of tableRows) {
    const target = `${row.owner}/${row.repo}#${String(row.number)}`;
    tableCandidates += 1;
    const [pr, asIssue] = await Promise.allSettled([
      deps.getPr(row.owner, row.repo, row.number),
      deps.getIssue(row.owner, row.repo, row.number),
    ]);
    if (pr.status === "rejected") {
      await fail(`confirm_table_pr:${target}`, pr.reason);
      continue;
    }
    if (asIssue.status === "rejected") {
      await fail(`confirm_table_pr:${target}`, asIssue.reason);
      continue;
    }
    const check = confirmTablePr(
      row,
      pr.value,
      asIssue.value,
      input.viewer,
      input.labels,
    );
    if (check.kind === "ok") {
      confirmed.push(check.item);
    } else if (check.kind === "drop") {
      tableDropped += 1;
      input.log.info("table pull request dropped by the REST check", {
        target,
        reason: check.reason,
      });
    } else {
      await fail(
        `confirm_table_pr:${target}`,
        new Error(
          check.kind === "mismatch"
            ? "table pull request does not match the pull request read from GitHub"
            : "requested reviewers of the pull request could not be read",
        ),
      );
    }
  }

  const seen = new Set<string>();
  const items: PrSearchItem[] = [];
  for (const item of [...searched, ...confirmed]) {
    const key =
      `${item.owner}/${item.repo}#${String(item.number)}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  return {
    items,
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
