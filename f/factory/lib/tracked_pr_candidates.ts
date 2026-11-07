// `poll_prs`が、DBで追跡中のPRを、開いているものだけ候補に足す手順。
// 判断だけを持ち、DBとGitHubの読み書きは呼び出し側が渡す。

import type { TrackedPr } from "./db.ts";
import type { PrSearchItem, PullRequest } from "./github.ts";
import type { Logger } from "./log.ts";

export type TrackedPrCandidateDeps = {
  /** 1回に読む追跡中のPRの最大の数。`listTracked`は、これより1件多く返してよい。 */
  readonly limit: number;
  /** DBの現在時刻(`readDbNow`)。閉じた印の時刻になる。 */
  readonly readDbNow: () => Promise<Date>;
  /** 追跡中のPR。新しく更新された順に、最大`limit + 1`件(`listTrackedPrs`)。 */
  readonly listTracked: () => Promise<TrackedPr[]>;
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<Pick<PullRequest, "state" | "merged" | "title">>;
  /** PRの作業項目に閉じた印を付ける(`markTrackedPrClosed`)。付けたら`true`を返す。 */
  readonly markClosed: (pr: TrackedPr, readAt: Date) => Promise<boolean>;
  /** ジョブの失敗として記録する。記録に失敗しても例外を投げない。 */
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  readonly log: Logger;
};

export type TrackedPrCandidates = {
  readonly items: PrSearchItem[];
  /** 例外で処理できなかった数。 */
  readonly failed: number;
  /** 閉じた印を付けたPRの数。 */
  readonly closedMarked: number;
  /** 追跡中のPRが上限を超えていたか。真のとき、古い側は読んでいない。 */
  readonly overLimit: boolean;
};

function prKey(pr: Pick<TrackedPr, "owner" | "repo" | "pr_number">): string {
  return `${pr.owner}/${pr.repo}#${String(pr.pr_number)}`;
}

/**
 * 追跡中のPRのうち、今も開いているものを候補にして返す。
 * 開いていなければ候補にしない。マージ済みなら、作業項目に閉じた印を付けて、以後の回で読み直さない。
 * マージせずに閉じたPRは、開き直されうるので印を付けず、毎回読む。
 * 印の時刻は、一覧を読む前に取る。読んでから動いた行に、有効な印を付けないためである。
 * 時刻を取れなかった回は印を付けず、候補の収集は続ける。
 *
 * `alreadyFound`は、別の経路で見つけ済みのPRの鍵(`owner/repo#number`)で、読まずに飛ばす。
 * 許可されないリポジトリのPRも、読まずに飛ばす。
 * 一覧が`limit`を超えたときは、先頭の`limit`件だけを読み、飛ばした件数を添えて警告を出す。
 * 例外は、PRごとに捕まえて失敗として記録し、ほかのPRを止めない。
 */
export async function collectTrackedPrCandidates(
  alreadyFound: ReadonlySet<string>,
  deps: TrackedPrCandidateDeps,
): Promise<TrackedPrCandidates> {
  let failed = 0;
  let readAt: Date | null = null;
  try {
    readAt = await deps.readDbNow();
  } catch (err) {
    failed += 1;
    await deps.recordFailure("read_db_now", err);
  }
  let listed: TrackedPr[];
  try {
    listed = await deps.listTracked();
  } catch (err) {
    await deps.recordFailure("list_tracked_prs", err);
    return { items: [], failed: failed + 1, closedMarked: 0, overLimit: false };
  }
  const overLimit = listed.length > deps.limit;
  const items: PrSearchItem[] = [];
  const handled = new Set<string>();
  let closedMarked = 0;
  let skippedNotAllowed = 0;
  let skippedAlreadyFound = 0;
  for (const tracked of listed.slice(0, deps.limit)) {
    const key = prKey(tracked);
    if (alreadyFound.has(key)) {
      skippedAlreadyFound += 1;
      continue;
    }
    // 照合で飛ばしたオーナーや`owners`に無いオーナーのPRは、取り直さずに候補から外す。
    if (!deps.isRepoAllowed(tracked.owner, tracked.repo)) {
      skippedNotAllowed += 1;
      continue;
    }
    if (handled.has(key)) continue;
    handled.add(key);
    let pr: Pick<PullRequest, "state" | "merged" | "title">;
    try {
      pr = await deps.getPr(tracked.owner, tracked.repo, tracked.pr_number);
    } catch (err) {
      failed += 1;
      await deps.recordFailure(`fetch_tracked_pr:${key}`, err);
      continue;
    }
    if (pr.state === "open") {
      items.push({
        owner: tracked.owner,
        repo: tracked.repo,
        number: tracked.pr_number,
        title: pr.title,
        htmlUrl: `https://github.com/${tracked.owner}/${tracked.repo}/pull/${String(tracked.pr_number)}`,
      });
      continue;
    }
    if (!pr.merged || readAt === null) continue;
    try {
      if (await deps.markClosed(tracked, readAt)) closedMarked += 1;
    } catch (err) {
      failed += 1;
      await deps.recordFailure(`mark_tracked_pr_closed:${key}`, err);
    }
  }
  if (overLimit) {
    deps.log.warn(
      "tracked pull requests exceed the limit, so the oldest ones are not read",
      {
        limit: deps.limit,
        skipped_not_allowed: skippedNotAllowed,
        skipped_already_found: skippedAlreadyFound,
      },
    );
  }
  return { items, failed, closedMarked, overLimit };
}
