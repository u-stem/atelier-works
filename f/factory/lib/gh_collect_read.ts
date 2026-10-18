// 収集が書いたGitHubの記録を、下流が読んでよいかの判定を持つ。
// リポジトリごとの鮮度と、使ってよい行の絞り込みを、通信もDBも持たない純粋関数で行う。
// 記録は、打ち切りや失敗のリポジトリでは古いまま`usable`が真で残るので、読む側は必ず鮮度を判定する。

import type {
  FactoryConfig,
  GhDetailOpenRow,
  GhIssue,
  GhOwnerOpenIssueSnapshot,
  GhOwnerOpenPrSnapshot,
  GhOwnerRepoFreshnessRow,
  GhPullRequest,
  GhRepoFreshnessRow,
  GhSource,
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
 * 名前は、照会の名前と行の名前をどちらも小文字にして比べる。
 * SQLが同じ条件で絞っていなくても、ここで絞る。
 */
export function usableGhPullRequests(
  owner: string,
  repo: string,
  repoId: number,
  prs: readonly GhPullRequest[],
): GhPullRequest[] {
  const ownerName = owner.toLowerCase();
  const repoName = repo.toLowerCase();
  return prs.filter(
    (row) =>
      isUsableOpenRow(row, repoId) &&
      row.owner.toLowerCase() === ownerName &&
      row.repo.toLowerCase() === repoName,
  );
}

/** リポジトリごとの判定。`usable`は、鮮度が足りるときだけ使ってよい行。 */
export type GhOwnerRepoJudgement = {
  readonly row: GhOwnerRepoFreshnessRow;
  readonly freshness: GhRepoFreshness;
  readonly usable: readonly GhPullRequest[];
};

/**
 * 所有者の読み取りを、リポジトリごとの判定に分ける。鍵は小文字のリポジトリ名。
 * `gh_repos`の行の無いリポジトリの開いた行は、数値IDを確かめられないので使わない。
 */
export function judgeGhOwnerRepos(
  owner: string,
  snapshot: GhOwnerOpenPrSnapshot,
  staleAfterMs: number,
): Map<string, GhOwnerRepoJudgement> {
  const ownerName = owner.toLowerCase();
  const openByRepo = new Map<string, GhPullRequest[]>();
  for (const pr of snapshot.prs) {
    if (pr.owner.toLowerCase() !== ownerName) {
      continue;
    }
    const key = pr.repo.toLowerCase();
    const rows = openByRepo.get(key);
    if (rows === undefined) {
      openByRepo.set(key, [pr]);
    } else {
      rows.push(pr);
    }
  }
  const judged = new Map<string, GhOwnerRepoJudgement>();
  for (const row of snapshot.repos) {
    const name = row.repo.toLowerCase();
    const open = openByRepo.get(name) ?? [];
    const freshness = judgeGhRepoFreshness(
      row,
      open,
      snapshot.db_now,
      staleAfterMs,
    );
    const usable =
      freshness.kind === "fresh" && row.repo_id !== null
        ? usableGhPullRequests(owner, name, row.repo_id, open)
        : [];
    judged.set(name, { row, freshness, usable });
  }
  return judged;
}

/** 所有者の判定が見る、リポジトリごとの判定の部分。PRとIssueのどちらの判定も満たす。 */
export type GhOwnerRepoCoverageInput = {
  readonly row: GhOwnerRepoFreshnessRow;
  readonly freshness: GhRepoFreshness;
};

/** Issueの行の、リポジトリごとの判定。`usable`は、鮮度が足りるときだけ使ってよい行。 */
export type GhOwnerIssueRepoJudgement = GhOwnerRepoCoverageInput & {
  readonly usable: readonly GhIssue[];
};

/** 詳細の行から、使ってよい開いた行だけを返す。 */
export function usableGhDetailRows<T extends GhDetailOpenRow>(
  _owner: string,
  _repo: string,
  _repoId: number,
  _rows: readonly T[],
): T[] {
  return [];
}

/** 所有者のIssueの読み取りを、リポジトリごとの判定に分ける。鍵は小文字のリポジトリ名。 */
export function judgeGhOwnerIssueRepos(
  _owner: string,
  _snapshot: GhOwnerOpenIssueSnapshot,
  _staleAfterMs: number,
): Map<string, GhOwnerIssueRepoJudgement> {
  return new Map();
}

export type GhOwnerCoverage =
  | { readonly kind: "fresh" }
  | { readonly kind: "stale"; readonly reason: GhRepoStaleReason };

/**
 * 所有者の全体を表で探してよいか判定する。検索の`user:`/`org:`の範囲の代わりにできるかを決める。
 * 1. `gh_repos`に所有者の行が無い(`no_record`)。
 * 2. 読む時点の許可が偽のリポジトリは、判定から外す。
 *    記録の`allowed`が偽でも、読む時点で許されるリポジトリは外さず、`unusable`で`stale`にする。
 * 3. 一覧から消えた、archive済みのリポジトリは、判定から外す。外さないと、そのリポジトリを1つ持つ所有者が毎周回検索に戻る。
 * 4. 残りに鮮度の足りないリポジトリがあれば、名前の順で最初のものの理由で`stale`にする。
 * 5. どれでもなければ`fresh`。
 * 所有者の最新の実行の照合結果は読まない。照合の不一致は収集が配下の行を使えなくし、一時的な失敗は鮮度が閾値で落とす。
 */
export function judgeGhOwnerCoverage(
  owner: string,
  judged: ReadonlyMap<string, GhOwnerRepoCoverageInput>,
  isRepoAllowedNow: (owner: string, repo: string) => boolean,
  _required?: ReadonlySet<string>,
): GhOwnerCoverage {
  if (judged.size === 0) {
    return { kind: "stale", reason: "no_record" };
  }
  const names = [...judged.keys()].sort();
  for (const name of names) {
    const item = judged.get(name);
    if (item === undefined) {
      continue;
    }
    if (!isRepoAllowedNow(owner, item.row.repo)) {
      continue;
    }
    if (item.row.gone || item.row.archived) {
      continue;
    }
    if (item.freshness.kind === "stale") {
      return { kind: "stale", reason: item.freshness.reason };
    }
  }
  return { kind: "fresh" };
}

/**
 * 設定と収集の設定から、実際に使う読み取り元を決める。
 * 収集の記録が進まないときに表を読むと古い値で判断するので、収集の2つの設定が真のときだけ`db`にする。
 */
export function effectiveGhSource(
  setting: GhSource,
  config: Pick<
    FactoryConfig,
    "gh_collect_enabled" | "gh_collect_detail_enabled"
  >,
): GhSource {
  return setting === "db" &&
    config.gh_collect_enabled &&
    config.gh_collect_detail_enabled
    ? "db"
    : "search";
}
