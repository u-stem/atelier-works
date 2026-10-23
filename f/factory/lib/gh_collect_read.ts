// 収集が書いたGitHubの記録を、下流が読んでよいかの判定を持つ。
// リポジトリごとの鮮度と、使ってよい行の絞り込みを、通信もDBも持たない純粋関数で行う。
// 記録は、打ち切りや失敗のリポジトリでは古いまま`usable`が真で残るので、読む側は必ず鮮度を判定する。

import { configuredRepos, isRepoAllowed } from "./config.ts";
import type {
  FactoryConfig,
  GhDetailOpenRow,
  GhIssue,
  GhOwnerOpenIssueSnapshot,
  GhOwnerOpenPrSnapshot,
  GhOwnerRepoFreshnessRow,
  GhPullRequest,
  GhRepoFreshnessRow,
  GhRepoStaleProbe,
  GhRepoStaleSnapshot,
  GhRepoStaleSummary,
} from "./types.ts";

const MINUTE_MS = 60_000;

/** 判断を止める閾値の下限(ミリ秒)。 */
const MIN_STALE_AFTER_MS = 15 * MINUTE_MS;

/** 収集の1周回の長さ(ミリ秒)。 */
const COLLECT_CYCLE_MS = 5 * MINUTE_MS;

/** 鮮度の判定が`stale`になる理由。 */
export type GhRepoStaleReason =
  | "no_record"
  | "unusable"
  | "not_collected"
  | "in_future"
  | "too_old";

export type GhRepoFreshness =
  | { readonly kind: "fresh" }
  | { readonly kind: "stale"; readonly reason: GhRepoStaleReason };

/**
 * 記録を使わずに止める閾値(ミリ秒)。`max(15分, (n+1)×5分)`で、nは設定の所有者の数。
 * 所有者を順に回す収集では、健全な所有者の成功の間隔が最悪`n×5分`になる。
 * `last_collected_at`は観測を始めた時刻なので、読む時点の経過はその間隔に書き込みの遅れが加わる。
 * そこで1周回の余裕を足す。通知の閾値(`staleNotifyThresholdMs`)より短く保つ。
 */
export function ghDetailStaleAfterMs(ownerCount: number): number {
  return Math.max(MIN_STALE_AFTER_MS, (ownerCount + 1) * COLLECT_CYCLE_MS);
}

/** 行が、リポジトリの現在の数値IDで書かれた、使ってよい開いた行か。 */
function isUsableOpenRow(row: GhDetailOpenRow, repoId: number): boolean {
  return row.state === "open" && row.usable && row.repo_id === repoId;
}

/**
 * リポジトリの記録を使ってよい鮮度か判定する。上から当てて、最初に当たったものを採る。
 * 1. `gh_repos`に行が無い(`no_record`)。
 * 2. 数値IDが無い、許可の外、一覧から消えた、archive済み(`unusable`)。
 * 3. 開いた行が1件以上あり、すべて使えない(`unusable`)。無効にされたまま書き直されていない行だけが残る状態を、PRが無いことと取り違えない。
 * 4. 一度も取り終えていない(`not_collected`)。
 * 5. `last_collected_at`がDBの時刻より後(`in_future`)。書く前の時刻なので、正しければ起きない。
 * 6. DBの時刻との差が閾値を超える(`too_old`)。閾値ちょうどは`fresh`。
 * 比べる相手は、行を読んだ同じ文のDBの時刻である。workerの時計とは比べない。
 */
export function judgeGhRepoFreshness<T extends GhDetailOpenRow>(
  repo: GhRepoFreshnessRow | null,
  openRows: readonly T[],
  dbNow: Date,
  staleAfterMs: number,
): GhRepoFreshness {
  if (repo === null) {
    return { kind: "stale", reason: "no_record" };
  }
  const repoId = repo.repo_id;
  if (repoId === null || !repo.allowed || repo.gone || repo.archived) {
    return { kind: "stale", reason: "unusable" };
  }
  const open = openRows.filter((row) => row.state === "open");
  if (open.length > 0 && !open.some((row) => isUsableOpenRow(row, repoId))) {
    return { kind: "stale", reason: "unusable" };
  }
  const collectedAt = repo.last_collected_at;
  if (collectedAt === null) {
    return { kind: "stale", reason: "not_collected" };
  }
  const ageMs = dbNow.getTime() - collectedAt.getTime();
  if (ageMs < 0) {
    return { kind: "stale", reason: "in_future" };
  }
  if (ageMs > staleAfterMs) {
    return { kind: "stale", reason: "too_old" };
  }
  return { kind: "fresh" };
}

/**
 * 開いていて、`usable`が真で、`repo_id`が`gh_repos`の数値IDと等しい、照会したリポジトリの行だけを返す。
 * PRの行とIssueの行のどちらにも使う。
 * 名前は、照会の名前と行の名前をどちらも小文字にして比べる。
 * SQLが同じ条件で絞っていなくても、ここで絞る。
 */
export function usableGhDetailRows<T extends GhDetailOpenRow>(
  owner: string,
  repo: string,
  repoId: number,
  rows: readonly T[],
): T[] {
  const ownerName = owner.toLowerCase();
  const repoName = repo.toLowerCase();
  return rows.filter(
    (row) =>
      isUsableOpenRow(row, repoId) &&
      row.owner.toLowerCase() === ownerName &&
      row.repo.toLowerCase() === repoName,
  );
}

/** PRの行について`usableGhDetailRows`を呼ぶ。 */
export function usableGhPullRequests(
  owner: string,
  repo: string,
  repoId: number,
  prs: readonly GhPullRequest[],
): GhPullRequest[] {
  return usableGhDetailRows(owner, repo, repoId, prs);
}

/**
 * 所有者の行を、リポジトリごとの判定に分ける。鍵は小文字のリポジトリ名。
 * `gh_repos`の行の無いリポジトリの開いた行は、数値IDを確かめられないので使わない。
 */
function judgeOwnerRows<T extends GhDetailOpenRow>(
  owner: string,
  repos: readonly GhOwnerRepoFreshnessRow[],
  rows: readonly T[],
  dbNow: Date,
  staleAfterMs: number,
): Map<string, GhOwnerRepoCoverageInput & { readonly usable: readonly T[] }> {
  const ownerName = owner.toLowerCase();
  const openByRepo = new Map<string, T[]>();
  for (const found of rows) {
    if (found.owner.toLowerCase() !== ownerName) {
      continue;
    }
    const key = found.repo.toLowerCase();
    const list = openByRepo.get(key);
    if (list === undefined) {
      openByRepo.set(key, [found]);
    } else {
      list.push(found);
    }
  }
  const judged = new Map<
    string,
    GhOwnerRepoCoverageInput & { readonly usable: readonly T[] }
  >();
  for (const row of repos) {
    const name = row.repo.toLowerCase();
    const open = openByRepo.get(name) ?? [];
    const freshness = judgeGhRepoFreshness(row, open, dbNow, staleAfterMs);
    const usable =
      freshness.kind === "fresh" && row.repo_id !== null
        ? usableGhDetailRows(owner, name, row.repo_id, open)
        : [];
    judged.set(name, { row, freshness, usable });
  }
  return judged;
}

/** リポジトリごとの判定。`usable`は、鮮度が足りるときだけ使ってよい行。 */
export type GhOwnerRepoJudgement = {
  readonly row: GhOwnerRepoFreshnessRow;
  readonly freshness: GhRepoFreshness;
  readonly usable: readonly GhPullRequest[];
};

/**
 * 所有者のPRの読み取りを、リポジトリごとの判定に分ける。鍵は小文字のリポジトリ名。
 * `gh_repos`の行の無いリポジトリの開いた行は、数値IDを確かめられないので使わない。
 */
export function judgeGhOwnerRepos(
  owner: string,
  snapshot: GhOwnerOpenPrSnapshot,
  staleAfterMs: number,
): Map<string, GhOwnerRepoJudgement> {
  return judgeOwnerRows(
    owner,
    snapshot.repos,
    snapshot.prs,
    snapshot.db_now,
    staleAfterMs,
  );
}

/** リポジトリごとの判定の、行と鮮度の部分。PRとIssueのどちらの判定も満たす。 */
export type GhOwnerRepoCoverageInput = {
  readonly row: GhOwnerRepoFreshnessRow;
  readonly freshness: GhRepoFreshness;
};

/** Issueの行の、リポジトリごとの判定。`usable`は、鮮度が足りるときだけ使ってよい行。 */
export type GhOwnerIssueRepoJudgement = GhOwnerRepoCoverageInput & {
  readonly usable: readonly GhIssue[];
};

/**
 * 所有者のIssueの読み取りを、リポジトリごとの判定に分ける。鍵は小文字のリポジトリ名。
 * `gh_repos`の行の無いリポジトリの開いた行は、数値IDを確かめられないので使わない。
 */
export function judgeGhOwnerIssueRepos(
  owner: string,
  snapshot: GhOwnerOpenIssueSnapshot,
  staleAfterMs: number,
): Map<string, GhOwnerIssueRepoJudgement> {
  return judgeOwnerRows(
    owner,
    snapshot.repos,
    snapshot.issues,
    snapshot.db_now,
    staleAfterMs,
  );
}

/**
 * 表が新しくなく、見送るリポジトリの、鮮度の判定の理由を返す。
 * 見送るのは、読む時点で許され、archive済みでも一覧から消えてもおらず、設定で明示してもいないリポジトリである。
 */
export function skippedStaleReasons(
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

/**
 * archive済みの印のあるリポジトリの記録が、archiveの印を除いて鮮度の内にあるか。
 * 真のときだけ、archive済みの印を信用できる。古い記録の印は、解除された後も残りうる。
 */
export function isArchivedWithinFreshness(
  row: GhOwnerRepoFreshnessRow,
  dbNow: Date,
  staleAfterMs: number,
): boolean {
  return (
    row.archived &&
    judgeGhRepoFreshness({ ...row, archived: false }, [], dbNow, staleAfterMs)
      .kind === "fresh"
  );
}

/**
 * 表の候補にしてよい行を、(リポジトリ、番号)の順に集める。
 * 読む時点で許されないリポジトリ、archive済みのリポジトリ、一覧から消えたリポジトリの行は入れない。
 * `usable`は鮮度が足りるリポジトリの使ってよい行だけなので、鮮度の足りないリポジトリは行を出さない。
 */
export function usableTableRows<T extends { readonly number: number }>(
  owner: string,
  judged: ReadonlyMap<
    string,
    GhOwnerRepoCoverageInput & { readonly usable: readonly T[] }
  >,
  isAllowedNow: (owner: string, repo: string) => boolean,
): T[] {
  const rows: T[] = [];
  for (const name of [...judged.keys()].sort()) {
    const item = judged.get(name);
    if (item === undefined) continue;
    if (
      !isAllowedNow(owner, item.row.repo) ||
      item.row.archived ||
      item.row.gone
    ) {
      continue;
    }
    rows.push(...[...item.usable].sort((a, b) => a.number - b.number));
  }
  return rows;
}

/**
 * 開いた行の有無と、使える行の有無を、判定が読む行の形に戻す。
 * 判定は、開いた行が1件以上あり、すべて使えないかだけを見るので、行は1件で足りる。
 */
function openRowsOf(
  probe: GhRepoStaleProbe,
  open: boolean,
  usable: boolean,
): GhDetailOpenRow[] {
  if (!open) {
    return [];
  }
  return [
    {
      owner: probe.owner,
      repo: probe.repo,
      repo_id: probe.row?.repo_id ?? 0,
      state: "open",
      usable,
    },
  ];
}

/**
 * リポジトリ1件の鮮度を判定する。PRの行とIssueの行の判定のどちらかが`stale`なら`stale`とし、PRの理由を先に採る。
 * 下流が読む表はPRとIssueで別々に判定されるので、どちらか一方が使えなければ、そのリポジトリは下流で見送られる。
 */
function judgeRepoProbe(
  probe: GhRepoStaleProbe,
  dbNow: Date,
  staleAfterMs: number,
): GhRepoFreshness {
  const pullRequests = judgeGhRepoFreshness(
    probe.row,
    openRowsOf(probe, probe.pr_open, probe.pr_usable),
    dbNow,
    staleAfterMs,
  );
  if (pullRequests.kind === "stale") {
    return pullRequests;
  }
  return judgeGhRepoFreshness(
    probe.row,
    openRowsOf(probe, probe.issue_open, probe.issue_usable),
    dbNow,
    staleAfterMs,
  );
}

/**
 * リポジトリ単位の古さを、所有者ごとに数える。
 * 数える対象は、`isTarget`が真で、一覧から消えていない(`gone`が偽)、archive済みでないリポジトリである。
 * 一覧から消えたリポジトリとarchive済みのリポジトリは、下流が読まないので、古くても数えない。
 * 対象の鮮度は、閾値`staleAfterMs`で`judgeGhRepoFreshness`にかける。
 * 閾値は下流が記録を使わなくなる閾値より長い、通知の閾値を渡す。
 * `stale`でも、`first_seen_at`から`staleAfterMs`以内のリポジトリは、新しく一覧に載った猶予として`pending`に数える。
 * `unsettled`は、閾値`settledAfterMs`(下流が記録を使う閾値)で非`fresh`の対象の数で、猶予の間のものも含む。
 * 通知は閾値`staleAfterMs`を超えたときに足し、`unsettled`が0になるまで解決しない。
 * 足す閾値と解決の閾値を分けるので、閾値の付近で通知が足されては解決されることを繰り返さない。
 * 比べる相手は、行を読んだ同じ文のDBの時刻で、workerの時計とは比べない。
 * `owners`の全員について、対象が無くても集計を返す。
 */
export function summarizeRepoStale(input: {
  readonly snapshot: GhRepoStaleSnapshot;
  readonly owners: readonly string[];
  readonly staleAfterMs: number;
  /** 解決の判定に使う、下流が記録を使う閾値。`staleAfterMs`以下にする。 */
  readonly settledAfterMs: number;
  readonly isTarget: (owner: string, repo: string) => boolean;
}): GhRepoStaleSummary[] {
  const { snapshot, staleAfterMs, isTarget } = input;
  const dbNowMs = snapshot.db_now.getTime();
  const names = [...new Set(input.owners.map((owner) => owner.toLowerCase()))];
  return names.map((owner) => {
    const reasons: Record<GhRepoStaleReason, number> = {
      no_record: 0,
      unusable: 0,
      not_collected: 0,
      in_future: 0,
      too_old: 0,
    };
    let targets = 0;
    let stale = 0;
    let pending = 0;
    let unsettled = 0;
    for (const probe of snapshot.probes) {
      if (probe.owner.toLowerCase() !== owner) {
        continue;
      }
      if (probe.row !== null && (probe.row.gone || probe.row.archived)) {
        continue;
      }
      if (!isTarget(owner, probe.repo)) {
        continue;
      }
      targets += 1;
      if (
        judgeRepoProbe(probe, snapshot.db_now, input.settledAfterMs).kind ===
        "stale"
      ) {
        unsettled += 1;
      }
      const freshness = judgeRepoProbe(probe, snapshot.db_now, staleAfterMs);
      if (freshness.kind === "fresh") {
        continue;
      }
      if (dbNowMs - probe.first_seen_at.getTime() <= staleAfterMs) {
        pending += 1;
        continue;
      }
      stale += 1;
      reasons[freshness.reason] += 1;
    }
    return { owner, targets, stale, pending, unsettled, reasons };
  });
}

/**
 * リポジトリ単位の古さを数える対象かを判定する関数を作る。
 * 対象は、読む時点で許される(`isRepoAllowed`)リポジトリのうち、明示されていないものである。
 * 明示された(`factory_repo`と`repo_allowlist`の各項目)リポジトリは、表が使えなくてもRESTで読むので数えない。
 * `repo_allowlist`が空でなければ、許されるのは明示されたリポジトリだけなので、対象は無くなる。
 */
export function repoStaleTargetFilter(
  config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
): (owner: string, repo: string) => boolean {
  const explicit = new Set(
    configuredRepos(config).map((entry) =>
      `${entry.owner}/${entry.repo}`.toLowerCase(),
    ),
  );
  return (owner, repo) =>
    isRepoAllowed(config, owner, repo) &&
    !explicit.has(`${owner}/${repo}`.toLowerCase());
}

/**
 * 明示されていないリポジトリがありうるか。
 * `isRepoAllowed`は、`repo_allowlist`が空のとき`owners`の全リポジトリを許すので、
 * 所有者がいて`repo_allowlist`が空のときに真になる。
 * 収集の無効と、トークンの無い所有者の通知は、この述語で出すかを決める。
 */
export function nonExplicitReposPossible(
  config: Pick<FactoryConfig, "owners" | "repo_allowlist">,
): boolean {
  return config.owners.length > 0 && config.repo_allowlist.length === 0;
}
