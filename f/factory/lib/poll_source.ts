// `poll_issues`と`poll_prs`が、トリガーのIssueとPRを見つける経路を持つ。
// どちらも収集の表を読み、表が使えないリポジトリのうち設定で明示したものだけをRESTで読む。検索は使わない。
// 表の行や一覧の番号は候補を絞るだけに使い、候補に入れる前にRESTで読み直して、開いていて今も対象であることを確かめる。

import { configuredRepos, isRepoAllowed } from "./config.ts";
import {
  type GhOwnerRepoCoverageInput,
  judgeGhOwnerIssueRepos,
  judgeGhOwnerRepos,
  judgeGhRepoFreshness,
  usableTableRows,
} from "./gh_collect_read.ts";
import type {
  Issue,
  IssueSearchItem,
  OpenPullRequest,
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
  hasLabel,
} from "./types.ts";

export function resolveTableUse(
  _config: Pick<
    FactoryConfig,
    "gh_collect_enabled" | "gh_collect_detail_enabled"
  >,
  _log: Logger,
): boolean {
  return false;
}

/**
 * Issueの稼働中の作業項目を引く鍵。
 * GitHubのownerとrepoは大文字小文字を区別しないので、綴りが違っても同じIssueを引けるよう小文字にする。
 */
export function issueKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${String(number)}`.toLowerCase();
}

/** 確かめる候補のIssueの参照。表の行と、RESTの一覧の番号のどちらからも作る。 */
export type IssueRef = Pick<GhIssue, "owner" | "repo" | "number">;

export type IssueCandidateCheck =
  | { readonly kind: "ok"; readonly item: IssueSearchItem }
  | {
      readonly kind: "drop";
      readonly reason: "closed" | "label_absent" | "pull_request";
    }
  | { readonly kind: "mismatch" };

/**
 * 候補を`getIssue`の応答で確かめ、候補の項目を作る。表の行にも、RESTの一覧の番号にも使う。
 * 応答のリポジトリか番号が参照と違うときは`mismatch`で、名前の付け替えか移管の途中である。
 * PRの番号は、Issueのまま扱うと別の処理に誤って回るので、`drop`(`pull_request`)にする。
 * 閉じているか、トリガーラベルが外れているときも`drop`にする。
 * 外れたラベルの付与者を読むと、偽の`labeler_denied`を残すためである。
 * 項目のownerとrepoは応答の綴りにする。作業項目の綴りをそろえるためである。
 */
export function confirmIssueCandidate(
  row: IssueRef,
  issue: Issue,
  triggerLabel: string,
): IssueCandidateCheck {
  const repository = issue.repository;
  if (
    repository === null ||
    repository.owner.toLowerCase() !== row.owner.toLowerCase() ||
    repository.repo.toLowerCase() !== row.repo.toLowerCase() ||
    issue.number !== row.number
  ) {
    return { kind: "mismatch" };
  }
  if (issue.isPullRequest) {
    return { kind: "drop", reason: "pull_request" };
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

export type IssueDiscoveryStats = {
  /** 表が新しくないため見送った、明示でないリポジトリの数。 */
  readonly skipped_stale: number;
  /** 見送った理由ごとのリポジトリの数。理由は表の鮮度の判定の語である。 */
  readonly skipped_stale_reasons: Readonly<Record<string, number>>;
  /** 表の代わりにRESTの一覧で読んだ、明示のリポジトリの数。 */
  readonly rest_lists: number;
  /** 一覧で読んだ理由ごとのリポジトリの数。表の鮮度の判定の語に、`read_failed`と`collect_disabled`を足したもの。 */
  readonly rest_reasons: Readonly<Record<string, number>>;
  /** RESTで確かめ直した候補の数。表の候補と一覧の候補を合わせる。 */
  readonly candidates: number;
  /** RESTで対象でないと分かって外した候補の数。 */
  readonly dropped: number;
};

/** この所有者の、設定で明示したリポジトリのうち、読む時点で許されるもの。 */
function explicitReposOf(
  scope: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
  ownerName: string,
  isAllowedNow: (owner: string, repo: string) => boolean,
): { owner: string; repo: string }[] {
  const name = ownerName.toLowerCase();
  return configuredRepos(scope).filter(
    (entry) =>
      entry.owner.toLowerCase() === name &&
      isAllowedNow(entry.owner, entry.repo),
  );
}

/**
 * 表が新しくなく、見送るリポジトリの、鮮度の判定の理由を返す。
 * 見送るのは、読む時点で許され、archive済みでも一覧から消えてもおらず、設定で明示してもいないリポジトリである。
 */
function skippedStaleReasons(
  ownerName: string,
  judged: ReadonlyMap<string, GhOwnerRepoCoverageInput>,
  explicitNames: ReadonlySet<string>,
  isAllowedNow: (owner: string, repo: string) => boolean,
): string[] {
  const reasons: string[] = [];
  for (const name of [...judged.keys()].sort()) {
    const item = judged.get(name);
    if (
      item === undefined ||
      explicitNames.has(name) ||
      !isAllowedNow(ownerName, item.row.repo) ||
      item.row.archived ||
      item.row.gone ||
      item.freshness.kind !== "stale"
    ) {
      continue;
    }
    reasons.push(item.freshness.reason);
  }
  return reasons;
}

type ExplicitRepo = { owner: string; repo: string };

/**
 * 表の代わりにRESTの一覧で読む明示リポジトリを、読む理由とともに返す。
 * 表を使えない理由(`tableReason`。収集の無効と表の読み取りの失敗)があれば、すべての明示リポジトリを読む。
 * 表を読めたときは、行が無いか記録が新しくないものを読み、理由は鮮度の判定の語になる。
 * archive済みの明示リポジトリは、記録が鮮度の内にあるときだけ読まない。
 * 古い記録のarchiveの印は、解除された後も残りうるので信用しない。
 */
function explicitListReads(input: {
  readonly explicit: readonly ExplicitRepo[];
  readonly judged: ReadonlyMap<string, GhOwnerRepoCoverageInput> | null;
  readonly tableReason: "collect_disabled" | "read_failed" | null;
  readonly dbNow: Date | null;
  readonly staleAfterMs: number;
}): { entry: ExplicitRepo; reason: string }[] {
  const reads: { entry: ExplicitRepo; reason: string }[] = [];
  for (const entry of input.explicit) {
    const item = input.judged?.get(entry.repo.toLowerCase());
    let reason: string | null = input.tableReason;
    if (input.judged !== null) {
      if (item === undefined) {
        reason = "no_record";
      } else if (item.freshness.kind === "stale") {
        reason = item.freshness.reason;
      }
    }
    if (reason === null) continue;
    if (
      item !== undefined &&
      input.dbNow !== null &&
      item.row.archived &&
      judgeGhRepoFreshness(
        { ...item.row, archived: false },
        [],
        input.dbNow,
        input.staleAfterMs,
      ).kind === "fresh"
    ) {
      continue;
    }
    reads.push({ entry, reason });
  }
  return reads;
}

/** 理由ごとの件数に1を足す。 */
function countReason(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/**
 * トリガーラベル付きのIssueを見つける。照合を通った所有者ごとに行う。
 * 所有者の全体を表で読み、リポジトリごとに鮮度を判定して、新しいリポジトリの行だけを候補にする。
 * 表が新しくないリポジトリの扱いは、設定で明示したかで分かれる。
 * - 明示していない: 見送り、理由別に数える。失敗にはしない。読めない間の通知は収集の側が出す。
 * - 明示した(`factory_repo`と`repo_allowlist`の項目): RESTの一覧で、ラベル付きの開いたIssueを読む。
 *   表を読めなかったとき(失敗として記録する)と、収集が無効(`useTable`が偽)のときも、明示のリポジトリは一覧で読む。
 *   明示のリポジトリは表から外れる道が多く、読めないままにすると、通知なしに止まるためである。
 * 候補は、表の行も一覧の番号も、`getIssue`で確かめ直し、開いていてトリガーラベルが付いたIssueだけを項目にする。
 * 返す項目の並びは、所有者ごとに、表の候補を(リポジトリ、番号)の順に置き、続けて一覧の候補を置く。
 * 失敗はこの関数の中で記録し、件数を`failed`で返す。
 */
export async function discoverIssues(
  input: {
    /** 収集の2つの設定が真で、表を読んでよいか。偽なら表を読まず、明示のリポジトリだけを一覧で読む。 */
    readonly useTable: boolean;
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
    readonly readOwnerIssues: (
      owner: string,
    ) => Promise<GhOwnerOpenIssueSnapshot>;
    /** ラベル付きの開いたIssueの番号を、PRを除いて返す。 */
    readonly listLabeledIssues: (
      owner: string,
      repo: string,
      label: string,
    ) => Promise<number[]>;
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
  stats: IssueDiscoveryStats;
}> {
  let failed = 0;
  let skippedStale = 0;
  let restLists = 0;
  let candidates = 0;
  let dropped = 0;
  const skippedReasons: Record<string, number> = {};
  const restReasons: Record<string, number> = {};
  const refs: IssueRef[] = [];
  // 一覧のページの境目で同じ番号が重なりうるので、番号の鍵で重ねを除く。
  const seenRefs = new Set<string>();
  const addRef = (ref: IssueRef) => {
    const key = issueKey(ref.owner, ref.repo, ref.number);
    if (seenRefs.has(key)) return;
    seenRefs.add(key);
    refs.push(ref);
  };

  const fail = async (step: string, err: unknown) => {
    failed += 1;
    await deps.recordFailure(step, err);
  };
  const isAllowedNow = (owner: string, repo: string) =>
    isRepoAllowed(input.scope, owner, repo);

  for (const owner of input.owners) {
    const explicit = explicitReposOf(input.scope, owner.name, isAllowedNow);
    const explicitNames = new Set(
      explicit.map((entry) => entry.repo.toLowerCase()),
    );
    let tableReason: "collect_disabled" | "read_failed" | null = input.useTable
      ? null
      : "collect_disabled";
    let judged: ReturnType<typeof judgeGhOwnerIssueRepos> | null = null;
    let dbNow: Date | null = null;
    if (input.useTable) {
      try {
        const snapshot = await deps.readOwnerIssues(owner.name);
        dbNow = snapshot.db_now;
        judged = judgeGhOwnerIssueRepos(
          owner.name,
          snapshot,
          input.staleAfterMs,
        );
      } catch (err) {
        await fail(`read_gh_owner_issues:${owner.name}`, err);
        tableReason = "read_failed";
      }
    }

    if (judged !== null) {
      for (const row of usableTableRows(owner.name, judged, isAllowedNow)) {
        addRef(row);
      }
      for (const reason of skippedStaleReasons(
        owner.name,
        judged,
        explicitNames,
        isAllowedNow,
      )) {
        skippedStale += 1;
        countReason(skippedReasons, reason);
      }
    }

    for (const { entry, reason } of explicitListReads({
      explicit,
      judged,
      tableReason,
      dbNow,
      staleAfterMs: input.staleAfterMs,
    })) {
      restLists += 1;
      countReason(restReasons, reason);
      try {
        const numbers = await deps.listLabeledIssues(
          entry.owner,
          entry.repo,
          input.triggerLabel,
        );
        for (const number of [...numbers].sort((a, b) => a - b)) {
          addRef({ owner: entry.owner, repo: entry.repo, number });
        }
      } catch (err) {
        await fail(`list_labeled_issues:${entry.owner}/${entry.repo}`, err);
      }
    }
  }

  const confirmed: IssueSearchItem[] = [];
  for (const ref of refs) {
    const target = `${ref.owner}/${ref.repo}#${String(ref.number)}`;
    candidates += 1;
    let issue: Issue;
    try {
      issue = await deps.getIssue(ref.owner, ref.repo, ref.number);
    } catch (err) {
      await fail(`confirm_issue:${target}`, err);
      continue;
    }
    const check = confirmIssueCandidate(ref, issue, input.triggerLabel);
    if (check.kind === "ok") {
      confirmed.push(check.item);
    } else if (check.kind === "drop") {
      dropped += 1;
      input.log.info("issue dropped by the REST check", {
        target,
        reason: check.reason,
      });
    } else {
      await fail(
        `confirm_issue:${target}`,
        new Error("issue does not match the issue read from GitHub"),
      );
    }
  }

  return {
    items: confirmed,
    failed,
    stats: {
      skipped_stale: skippedStale,
      skipped_stale_reasons: skippedReasons,
      rest_lists: restLists,
      rest_reasons: restReasons,
      candidates,
      dropped,
    },
  };
}

/**
 * PRが、直接の条件(ラベル、PATのアカウントへの依頼、assignee)に当たるかの分類。
 * - `target`: 当たる。
 * - `team`: チームへの依頼か、依頼先を読めない依頼があり、PATのアカウントに宛てた依頼かを元の値では決められない。
 *   RESTで直接の依頼を確かめる。チーム宛ての依頼は、まだ解決できないので見送る。
 * - `maybe`: ラベルかassigneeが不明で、当たるかをRESTで確かめる。
 * - `none`: 当たらない。
 * 下書きとforkのPRも絞らない。判定がRESTの値で扱う。
 */
export type PollPrRowClass = "target" | "maybe" | "team" | "none";

/** 分類の入力。表の行と、RESTの一覧の要素のどちらからも作る。`null`は不明を表す。 */
type PrSignals = {
  readonly hasReviewLabel: boolean | null;
  readonly hasFixLabel: boolean | null;
  readonly requestedUserIds: readonly number[] | null;
  readonly assigneeIds: readonly number[] | null;
  readonly teamReviewRequested: boolean | null;
};

/**
 * 上から当てて、最初に当たったものを採る。`viewerId`はPATのアカウントの数値IDで、依頼とassigneeはIDで比べる。
 * 1. ラベルか、PATのアカウントへの依頼かassigneeに当たれば`target`。
 * 2. チームへの依頼が真か不明、または直接の依頼先が不明なら`team`。
 *    片方だけが不明でも、直接の依頼を判定できないので`team`にする。
 * 3. ラベルかassigneeが不明なら`maybe`。
 * 4. それ以外は`none`。
 */
function classifySignals(signals: PrSignals, viewerId: number): PollPrRowClass {
  if (
    signals.hasReviewLabel === true ||
    signals.hasFixLabel === true ||
    signals.requestedUserIds?.includes(viewerId) === true ||
    signals.assigneeIds?.includes(viewerId) === true
  ) {
    return "target";
  }
  if (
    signals.teamReviewRequested !== false ||
    signals.requestedUserIds === null
  ) {
    return "team";
  }
  if (
    signals.hasReviewLabel === null ||
    signals.hasFixLabel === null ||
    signals.assigneeIds === null
  ) {
    return "maybe";
  }
  return "none";
}

/** 表の行を分類する。分け方は`classifySignals`にある。 */
export function classifyPollPrRow(
  row: GhPullRequest,
  viewerId: number,
): PollPrRowClass {
  return classifySignals(
    {
      hasReviewLabel: row.has_review_label,
      hasFixLabel: row.has_fix_label,
      requestedUserIds: row.review_requested_user_ids,
      assigneeIds: row.assignee_ids,
      teamReviewRequested: row.team_review_requested,
    },
    viewerId,
  );
}

/**
 * RESTの一覧の要素を分類する。分け方は`classifySignals`にある。
 * 一覧が返さなかった項目(省略または`null`)は不明として扱う。
 */
export function classifyListedPr(
  pr: OpenPullRequest,
  viewerId: number,
  labels: { readonly reviewLabel: string; readonly fixLabel: string },
): PollPrRowClass {
  const names = pr.labels ?? null;
  return classifySignals(
    {
      hasReviewLabel:
        names === null ? null : hasLabel(names, labels.reviewLabel),
      hasFixLabel: names === null ? null : hasLabel(names, labels.fixLabel),
      requestedUserIds: pr.requestedReviewerIds ?? null,
      assigneeIds: pr.assigneeIds ?? null,
      teamReviewRequested: pr.teamReviewRequested ?? null,
    },
    viewerId,
  );
}

/** 確かめる候補のPRの参照。表の行と、RESTの一覧の要素のどちらからも作る。 */
export type PrRef = Pick<GhPullRequest, "owner" | "repo" | "number">;

export type PrCandidateCheck =
  | { readonly kind: "ok"; readonly item: PrSearchItem }
  | { readonly kind: "drop"; readonly reason: "closed" | "not_target" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "unknown_reviewers" };

/**
 * 候補のPRを、`getPr`と`getIssue`の応答で確かめ、候補の項目を作る。表の行にも、RESTの一覧の要素にも使う。
 * 上から当てて、最初に当たったものを採る。
 * 1. 応答のリポジトリか番号が参照と違うなら`mismatch`。名前の付け替えか移管の途中である。
 * 2. 閉じていれば`drop`(`closed`)。
 * 3. レビューか修正のラベル、またはPATのアカウントのassigneeがあれば`ok`。
 * 4. 依頼先を読めなければ`unknown_reviewers`。決められないまま外すと、依頼で起きるはずのレビューが黙って止まる。
 * 5. PATのアカウントへの依頼があれば`ok`。
 * 6. それ以外は`drop`(`not_target`)。
 * チームへの依頼はRESTでも一員かを決められないので、`not_target`になる。
 * 項目のownerとrepoは応答の綴りにする。作業項目の綴りをそろえるためである。
 */
export function confirmPrCandidate(
  row: PrRef,
  pr: PullRequest,
  asIssue: Issue,
  viewer: Viewer,
  labels: { readonly reviewLabel: string; readonly fixLabel: string },
): PrCandidateCheck {
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

export type PrDiscoveryStats = IssueDiscoveryStats & {
  /**
   * RESTの直接の依頼では対象でなかったが、チーム宛ての依頼が付いているかもしれず、見送ったPRの数。
   * チーム宛ての依頼は、PATのアカウントが属するチームかを決められるまで見送る。
   */
  readonly team_unresolved: number;
};

/** 確かめるPRの参照に、チーム宛ての依頼だけが残りうるかを添えたもの。 */
type PrCandidateRef = PrRef & {
  /** 分類が`team`で、チームへの依頼が偽と分かっていない。直接の依頼を確かめて外れたら、見送りとして数える。 */
  readonly teamPossible: boolean;
};

/**
 * ラベル、レビューの依頼、assigneeのPRを見つける。照合を通った所有者ごとに行う。
 * 所有者の全体を表で読み、リポジトリごとに鮮度を判定して、新しいリポジトリの行だけを候補にする。
 * 行は、表の列(ラベル、依頼先、assignee)で分類し、`target`、`maybe`、`team`を候補にして、`none`は捨てる。
 * チームへの依頼は解決できないので、`team`の行も直接の依頼をRESTで確かめる。
 * 直接の依頼でなければ見送り、`team_unresolved`に数える。依頼先を読めない行も直接の依頼を確かめる。
 * 表が新しくないリポジトリの扱いは、設定で明示したかで分かれる。
 * - 明示していない: 見送り、理由別に数える。失敗にはしない。読めない間の通知は収集の側が出す。
 * - 明示した(`factory_repo`と`repo_allowlist`の項目): RESTの一覧で、開いているPRを読む。
 *   表を読めなかったとき(失敗として記録する)と、収集が無効(`useTable`が偽)のときも、明示のリポジトリは一覧で読む。
 *   明示のリポジトリは表から外れる道が多く、読めないままにすると、通知なしに止まるためである。
 *   一覧のラベル、依頼先、assigneeは、表の列と同じ分類に通し、候補にするだけに使う。
 * 候補は、表の行も一覧の要素も、`getPr`と`getIssue`で確かめ直し、今も対象のものだけを項目にする。
 * 確かめ直しはPRを1件ずつ順に処理し、1件の中の2本だけを並列にする。GitHubへの同時の要求を増やさないためである。
 * 返す項目の並びは、所有者ごとに、表の候補を(リポジトリ、番号)の順に置き、続けて一覧の候補を置く。PRの鍵(小文字)で重ねを除く。
 * 失敗はこの関数の中で記録し、件数を`failed`で返す。
 */
export async function discoverPrs(
  input: {
    /** 収集の2つの設定が真で、表を読んでよいか。偽なら表を読まず、明示のリポジトリだけを一覧で読む。 */
    readonly useTable: boolean;
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
    readonly readOwnerPrs: (owner: string) => Promise<GhOwnerOpenPrSnapshot>;
    /** 開いているPRの一覧。ラベル、依頼先、assigneeは候補を絞るためにだけ使う。 */
    readonly listOpenPrs: (
      owner: string,
      repo: string,
    ) => Promise<OpenPullRequest[]>;
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
  stats: PrDiscoveryStats;
}> {
  let failed = 0;
  let skippedStale = 0;
  let restLists = 0;
  let candidates = 0;
  let dropped = 0;
  let teamUnresolved = 0;
  const skippedReasons: Record<string, number> = {};
  const restReasons: Record<string, number> = {};
  const refs: PrCandidateRef[] = [];
  // 一覧のページの境目で同じ番号が重なりうるので、PRの鍵で重ねを除く。
  const seenRefs = new Set<string>();
  const addRef = (ref: PrCandidateRef) => {
    const key = `${ref.owner}/${ref.repo}#${String(ref.number)}`.toLowerCase();
    if (seenRefs.has(key)) return;
    seenRefs.add(key);
    refs.push(ref);
  };
  /** 分類が候補なら、確かめる参照に加える。`none`は捨てる。 */
  const addClassified = (
    ref: PrRef,
    kind: PollPrRowClass,
    teamReviewRequested: boolean | null,
  ) => {
    if (kind === "none") return;
    addRef({
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      teamPossible: kind === "team" && teamReviewRequested !== false,
    });
  };

  const fail = async (step: string, err: unknown) => {
    failed += 1;
    await deps.recordFailure(step, err);
  };
  const isAllowedNow = (owner: string, repo: string) =>
    isRepoAllowed(input.scope, owner, repo);

  for (const owner of input.owners) {
    const explicit = explicitReposOf(input.scope, owner.name, isAllowedNow);
    const explicitNames = new Set(
      explicit.map((entry) => entry.repo.toLowerCase()),
    );
    let tableReason: "collect_disabled" | "read_failed" | null = input.useTable
      ? null
      : "collect_disabled";
    let judged: ReturnType<typeof judgeGhOwnerRepos> | null = null;
    let dbNow: Date | null = null;
    if (input.useTable) {
      try {
        const snapshot = await deps.readOwnerPrs(owner.name);
        dbNow = snapshot.db_now;
        judged = judgeGhOwnerRepos(owner.name, snapshot, input.staleAfterMs);
      } catch (err) {
        await fail(`read_gh_owner_prs:${owner.name}`, err);
        tableReason = "read_failed";
      }
    }

    if (judged !== null) {
      for (const row of usableTableRows(owner.name, judged, isAllowedNow)) {
        addClassified(
          row,
          classifyPollPrRow(row, input.viewer.id),
          row.team_review_requested,
        );
      }
      for (const reason of skippedStaleReasons(
        owner.name,
        judged,
        explicitNames,
        isAllowedNow,
      )) {
        skippedStale += 1;
        countReason(skippedReasons, reason);
      }
    }

    for (const { entry, reason } of explicitListReads({
      explicit,
      judged,
      tableReason,
      dbNow,
      staleAfterMs: input.staleAfterMs,
    })) {
      restLists += 1;
      countReason(restReasons, reason);
      try {
        const listed = await deps.listOpenPrs(entry.owner, entry.repo);
        for (const pr of [...listed].sort((a, b) => a.number - b.number)) {
          addClassified(
            { owner: entry.owner, repo: entry.repo, number: pr.number },
            classifyListedPr(pr, input.viewer.id, input.labels),
            pr.teamReviewRequested ?? null,
          );
        }
      } catch (err) {
        await fail(`list_open_prs:${entry.owner}/${entry.repo}`, err);
      }
    }
  }

  const confirmed: PrSearchItem[] = [];
  for (const ref of refs) {
    const target = `${ref.owner}/${ref.repo}#${String(ref.number)}`;
    candidates += 1;
    const [pr, asIssue] = await Promise.allSettled([
      deps.getPr(ref.owner, ref.repo, ref.number),
      deps.getIssue(ref.owner, ref.repo, ref.number),
    ]);
    if (pr.status === "rejected") {
      await fail(`confirm_pr:${target}`, pr.reason);
      continue;
    }
    if (asIssue.status === "rejected") {
      await fail(`confirm_pr:${target}`, asIssue.reason);
      continue;
    }
    const check = confirmPrCandidate(
      ref,
      pr.value,
      asIssue.value,
      input.viewer,
      input.labels,
    );
    if (check.kind === "ok") {
      confirmed.push(check.item);
    } else if (check.kind === "drop") {
      if (check.reason === "not_target" && ref.teamPossible) {
        teamUnresolved += 1;
        input.log.info("pull request skipped: only a team may have asked", {
          target,
        });
      } else {
        dropped += 1;
        input.log.info("pull request dropped by the REST check", {
          target,
          reason: check.reason,
        });
      }
    } else {
      await fail(
        `confirm_pr:${target}`,
        new Error(
          check.kind === "mismatch"
            ? "pull request does not match the pull request read from GitHub"
            : "requested reviewers of the pull request could not be read",
        ),
      );
    }
  }

  return {
    items: confirmed,
    failed,
    stats: {
      skipped_stale: skippedStale,
      skipped_stale_reasons: skippedReasons,
      rest_lists: restLists,
      rest_reasons: restReasons,
      candidates,
      dropped,
      team_unresolved: teamUnresolved,
    },
  };
}
