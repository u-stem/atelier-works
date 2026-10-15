// FactoryのPRのマージの競合の監視(`watch_pr_conflicts`)の流れを、外部の操作を注入して組み立てる。
// 検知と通知だけを行い、PRにもリポジトリにも書き込まず、修正は起動しない。
//
// 対象のPRは、作業項目の更新時刻や件数の窓に頼らずに見つける。
// 状態が`pr_open`の作業項目を持つリポジトリごとに、開いているPRを列挙し、
// Factoryのブランチのもの(下書きでなく、forkでなく、作業項目が同じPRを指す)だけをPRとして読む。
// `pr_open`はPRがマージされた後も変わらないので、作業項目から引くと、閉じたPRを読み続けたり、古い開いたPRを取り逃がしたりする。
// 開いているPRの一覧から引けば、読むのは開いているPRだけで、放置された古いPRも漏れない。
//
// 競合とみなすのは、`mergeable`が偽で`mergeable_state`が`dirty`のときだけである(`decidePrConflict`)。
// GitHubが計算していない(`mergeable`が`null`)PRは何もせず、次の回に判定し直す。
//
// 通知は競合の1回につき1回である。競合は、行が無い状態か、競合から離れた状態から競合に移った時点で始まる。
// 競合のままheadが進んでも、通知は重ねない。通知の登録とDiscordの後に、通知した時刻を記録する。
// 記録が先に成功して通知が失敗すると、通知が出なくなるためである。
// 通知の解決は、競合が終わった(解けた、PRが閉じた、監視の対象から外れた)ときだけ行う。
// 始まったときには解決しない。並んだ2つの実行の一方が、他方の出したばかりの通知を解決してしまうのを避けるためである。
//
// 開いているPRの一覧に無い(マージされた、閉じた)PRや、一覧を読めなかったリポジトリの競合の行は、
// PRを読み直して、解けたか閉じたかを確かめる。許可リストから外れたリポジトリの行と、PRが見つからない(404)行は閉じる。
// 外部由来の文字列(題名、ブランチ名)は、通知にもログにも載せない。
// 例外は、PRごと、リポジトリごとに捕まえて、他を止めない。rate limitは、以降の読み取りを止める。

import type {
  PrConflictCheck,
  PrConflictObservation,
  PrConflictRecorded,
  PrConflictSettledState,
} from "./db.ts";
import type { NotifyBestEffortResult, NotifyEvent } from "./discord.ts";
import {
  GitHubHttpError,
  GitHubRateLimitError,
  type OpenPullRequest,
  type PullRequest,
} from "./github.ts";
import type { Logger } from "./log.ts";
import { pullRequestKey } from "./pr_ci_human_support.ts";
import {
  type FactoryWorkItemRef,
  isFactoryPrBranch,
  type PullRequestRef,
  pullRequestPageUrl,
} from "./pr_ci_support.ts";
import { isSameRepoHead, RUN_BUDGET_MS } from "./pr_ci_watch.ts";
import {
  decidePrConflict,
  PR_CONFLICT_KIND,
  PR_CONFLICT_NEXT_ACTION,
  PR_CONFLICT_REASON,
  PR_CONFLICT_RESOLVED_BY,
  prConflictNoticeMessage,
  prConflictNoticePrefix,
} from "./pr_conflict_support.ts";
import {
  assertGitHubName,
  type NoticeRecord,
  parseImplementBranchWorkItemId,
} from "./types.ts";

/** 1回の実行で読む、競合している行の最大の数。 */
export const CONFLICT_ROW_LIMIT = 200;

export type PrConflictWatchDeps = {
  readonly now: () => Date;
  readonly log: Logger;
  readonly instanceName: string;
  /** 許可リストと、照合を通ったオーナーに合うリポジトリか(`buildRepoGates`)。 */
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  /** 状態が`pr_open`の作業項目を持つリポジトリ。重複は無い。 */
  readonly listOpenRepos: () => Promise<{ owner: string; repo: string }[]>;
  /** リポジトリの開いているPRをすべて返す。多すぎて読み切れないときは例外を投げる。 */
  readonly listOpenPrs: (
    owner: string,
    repo: string,
  ) => Promise<OpenPullRequest[]>;
  /** 作業項目の照合に使う列を返す。無ければ`null`。 */
  readonly getWorkItemRef: (id: number) => Promise<FactoryWorkItemRef | null>;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
  /** 競合している行を、読み直していない順に返す。 */
  readonly listConflicted: (limit: number) => Promise<PrConflictCheck[]>;
  /** 競合を記録し、その行と、新しい競合が始まったかを返す(`recordPrConflict`)。 */
  readonly record: (
    observation: PrConflictObservation,
  ) => Promise<PrConflictRecorded>;
  /** 今の競合で通知した時刻を記録する。この呼び出しで書いたら`true`。 */
  readonly markNotified: (id: number) => Promise<boolean>;
  /** 行を競合から離れた状態に移す。この呼び出しで移したら`true`。 */
  readonly settle: (id: number, to: PrConflictSettledState) => Promise<boolean>;
  /** 状態を変えずに読み直した時刻を進める。 */
  readonly touch: (id: number) => Promise<boolean>;
  /** 新しく挿入したら通知のID、同じ未解決の通知があれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly resolveNotices: (
    kind: string,
    messagePrefix: string,
    resolvedBy: string,
  ) => Promise<number>;
  /** 失敗しても例外を投げない送信(`notifyBestEffort`)を渡す。 */
  readonly notify: (event: NotifyEvent) => Promise<NotifyBestEffortResult>;
  /** ジョブの失敗として記録する。記録に失敗しても例外を投げない。 */
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
};

export type PrConflictWatchResult = {
  /** 読んだFactoryのPRの数。 */
  readonly tracked: number;
  /** 競合していると判定したPRの数。通知済みも含む。 */
  readonly conflicted: number;
  /** 通知した数。 */
  readonly notified: number;
  /** 競合が解けて、通知を解決した数。 */
  readonly resolved: number;
  /** 閉じた行の数。PRが閉じたときと、監視の対象から外れたときを含む。 */
  readonly closed: number;
  /** 判定を見送ったPRの数。 */
  readonly skipped: number;
  /** 失敗したPRとリポジトリの数。 */
  readonly errors: number;
  /** rate limitで読み取りを止めたか。 */
  readonly rateLimited: boolean;
};

/** 何も読まずに終わったときの結果。 */
export const PR_CONFLICT_WATCH_IDLE_RESULT: PrConflictWatchResult = {
  tracked: 0,
  conflicted: 0,
  notified: 0,
  resolved: 0,
  closed: 0,
  skipped: 0,
  errors: 0,
  rateLimited: false,
};

type Counters = {
  tracked: number;
  conflicted: number;
  notified: number;
  resolved: number;
  closed: number;
  skipped: number;
  errors: number;
  rateLimited: boolean;
};

type Context = {
  readonly deps: PrConflictWatchDeps;
  readonly startedAt: Date;
  readonly counters: Counters;
  /** この回の最初に読んだ、競合している行。PRの鍵で引く。 */
  readonly rows: ReadonlyMap<string, PrConflictCheck>;
};

function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof GitHubHttpError && statuses.includes(err.status);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function overBudget(context: Context): boolean {
  return (
    context.deps.now().getTime() - context.startedAt.getTime() >= RUN_BUDGET_MS
  );
}

function stopped(context: Context): boolean {
  return context.counters.rateLimited || overBudget(context);
}

function rowRef(row: PrConflictCheck): PullRequestRef {
  return { owner: row.owner, repo: row.repo, number: row.pr_number };
}

async function recordFailureOf(
  context: Context,
  step: string,
  err: unknown,
): Promise<void> {
  context.counters.errors += 1;
  await context.deps.recordFailure(step, err);
}

/**
 * rate limitなら以降の読み取りを止め、権限の不足(403、404)ならログだけに残し、それ以外は失敗として記録する。
 */
async function absorbReadError(
  context: Context,
  step: string,
  subject: string,
  err: unknown,
): Promise<void> {
  const { deps, counters } = context;
  if (err instanceof GitHubRateLimitError) {
    counters.rateLimited = true;
    deps.log.warn("pr conflict reading stopped by the rate limit", {
      subject,
      error: errorMessage(err),
    });
    return;
  }
  if (isStatus(err, 403, 404)) {
    deps.log.warn("pr conflict skipped something that is not readable", {
      subject,
      error: errorMessage(err),
    });
    return;
  }
  await recordFailureOf(context, step, err);
}

/**
 * 競合の監視を1回分実行する。
 * 競合している行を読めなければ、何も読まずに失敗として記録して終わる。
 */
export async function runPrConflictWatch(
  deps: PrConflictWatchDeps,
): Promise<PrConflictWatchResult> {
  const counters = { ...PR_CONFLICT_WATCH_IDLE_RESULT };
  const startedAt = deps.now();
  const rows = new Map<string, PrConflictCheck>();
  try {
    for (const row of await deps.listConflicted(CONFLICT_ROW_LIMIT)) {
      rows.set(pullRequestKey(rowRef(row)), row);
    }
  } catch (err) {
    await recordFailureOf(
      { deps, startedAt, counters, rows },
      "list_conflicted",
      err,
    );
    return counters;
  }
  const context: Context = { deps, startedAt, counters, rows };
  const seen = await watchOpenPrs(context);
  await watchRemainingRows(context, seen);
  return counters;
}

/** 開いているPRのうち、Factoryのブランチのものか。下書きとforkは対象にしない。 */
function isCandidate(pr: OpenPullRequest): boolean {
  return (
    !pr.draft &&
    isSameRepoHead(pr) &&
    parseImplementBranchWorkItemId(pr.headRef) !== null
  );
}

/** 開いているFactoryのPRを読んで扱う。読んだPRの鍵の集合を返す。 */
async function watchOpenPrs(context: Context): Promise<Set<string>> {
  const { deps } = context;
  const seen = new Set<string>();
  let repos: { owner: string; repo: string }[];
  try {
    repos = await deps.listOpenRepos();
  } catch (err) {
    await recordFailureOf(context, "list_open_repos", err);
    return seen;
  }
  for (const { owner, repo } of repos) {
    if (stopped(context)) break;
    if (!deps.isRepoAllowed(owner, repo)) continue;
    // `parsePullRequestUrl`は先頭が`.`のリポジトリ名も通すが、記録は通さない。読まずに飛ばす。
    try {
      assertGitHubName(owner);
      assertGitHubName(repo);
    } catch {
      continue;
    }
    let open: OpenPullRequest[];
    try {
      open = await deps.listOpenPrs(owner, repo);
    } catch (err) {
      await absorbReadError(
        context,
        `list_open_prs:${owner}/${repo}`,
        `${owner}/${repo}`,
        err,
      );
      continue;
    }
    for (const candidate of open.filter(isCandidate)) {
      if (stopped(context)) break;
      await watchOpenPr(context, owner, repo, candidate, seen);
    }
  }
  return seen;
}

async function watchOpenPr(
  context: Context,
  owner: string,
  repo: string,
  candidate: OpenPullRequest,
  seen: Set<string>,
): Promise<void> {
  const { deps, counters } = context;
  const ref: PullRequestRef = { owner, repo, number: candidate.number };
  const key = pullRequestKey(ref);
  try {
    const workItemId = parseImplementBranchWorkItemId(candidate.headRef);
    if (workItemId === null) return;
    const item = await deps.getWorkItemRef(workItemId);
    // 同じ形の名前のブランチを作った人のPRを、Factoryのものとして扱わない。
    if (!isFactoryPrBranch(candidate.headRef, ref, item)) return;
    seen.add(key);
    counters.tracked += 1;
    const pr = await deps.getPr(owner, repo, candidate.number);
    await applyDecision(context, ref, pr);
  } catch (err) {
    await absorbReadError(context, `pr_conflict:${key}`, key, err);
  }
}

/** PRの今の状態から決めた扱いを、書き込みに移す。 */
async function applyDecision(
  context: Context,
  ref: PullRequestRef,
  pr: PullRequest,
): Promise<void> {
  const { deps, counters } = context;
  const decision = decidePrConflict(pr);
  switch (decision.kind) {
    case "close":
      await leaveConflict(context, ref, "closed");
      return;
    case "clear":
      await leaveConflict(context, ref, "resolved");
      return;
    case "skip":
      skip(context, ref, decision.reason);
      return;
    case "conflict": {
      counters.conflicted += 1;
      const { row, started } = await deps.record({
        owner: ref.owner,
        repo: ref.repo,
        pr_number: ref.number,
        head_sha: decision.headSha,
      });
      if (started) {
        deps.log.info("pr conflict started", { pr: pullRequestKey(ref) });
      }
      if (row.notified_at === null) await notifyConflict(context, ref, row.id);
      return;
    }
  }
}

/** 判定を見送った理由を数え、見送るはずのない理由はlogに残す。 */
function skip(context: Context, ref: PullRequestRef, reason: string): void {
  context.counters.skipped += 1;
  if (reason === "not_dirty" || reason === "invalid_sha") {
    context.deps.log.warn("pr conflict skipped an unusual pull request", {
      pr: pullRequestKey(ref),
      reason,
    });
  }
}

/**
 * 競合を通知する。通知(notice)を登録し、新しく登録したときだけDiscordに送り、通知した時刻を記録する。
 * 通知を先に登録する。通知した時刻の記録が先に成功して登録が失敗すると、通知が永久に出ないため。
 */
async function notifyConflict(
  context: Context,
  ref: PullRequestRef,
  rowId: number,
): Promise<void> {
  const { deps, counters } = context;
  const noticeId = await deps.addNotice({
    kind: PR_CONFLICT_KIND,
    message: prConflictNoticeMessage({
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.number,
    }),
  });
  if (noticeId !== null) {
    const sent = await deps.notify({
      kind: "needs_human",
      instance_name: deps.instanceName,
      owner: ref.owner,
      repo: ref.repo,
      url: pullRequestPageUrl(ref.owner, ref.repo, ref.number),
      reason: PR_CONFLICT_REASON,
      target: { kind: "pr", number: ref.number },
      next_action: PR_CONFLICT_NEXT_ACTION,
    });
    // 通知(notice)は残るので、Discordに届かなかったことだけを記録する。
    if (sent.status === "not_sent") {
      deps.log.warn("pr conflict notice was not delivered", {
        pr: pullRequestKey(ref),
        notice_id: noticeId,
        reason: sent.reason,
      });
    }
  }
  if (await deps.markNotified(rowId)) {
    counters.notified += 1;
    deps.log.warn("pr conflict notified", { pr: pullRequestKey(ref) });
  }
}

/**
 * 競合が終わったPRの通知を解決し、競合の行があれば移す。
 * 通知の解決を先にする。解決に失敗した回は、行を競合のまま残し、次の回にやり直す。
 * 行が無いPRは、通知も行も触らない。
 */
async function leaveConflict(
  context: Context,
  ref: PullRequestRef,
  to: PrConflictSettledState,
): Promise<void> {
  const { deps, counters } = context;
  const target = context.rows.get(pullRequestKey(ref));
  if (target === undefined) return;
  await deps.resolveNotices(
    PR_CONFLICT_KIND,
    prConflictNoticePrefix(ref.owner, ref.repo, ref.number),
    PR_CONFLICT_RESOLVED_BY,
  );
  const moved = await deps.settle(target.id, to);
  if (!moved) return;
  if (to === "resolved") counters.resolved += 1;
  else counters.closed += 1;
  deps.log.info("pr conflict row settled", {
    pr: pullRequestKey(ref),
    state: to,
  });
}

/**
 * 開いているPRの一覧で読まなかった競合の行を整理する。PRを読み直し、閉じたか競合が解けたときだけ行を移す。
 * それ以外は、読み直した時刻だけを進める。通知は出さない。
 * 許可リストから外れたリポジトリの行と、PRが見つからない(404)行は、読まずに、または読んで、閉じる。
 * 権限の不足(403)は一時的かもしれないので、閉じずにログだけに残す。
 */
async function watchRemainingRows(
  context: Context,
  seen: ReadonlySet<string>,
): Promise<void> {
  const { deps } = context;
  for (const [key, row] of context.rows) {
    if (seen.has(key)) continue;
    if (stopped(context)) break;
    const ref = rowRef(row);
    try {
      if (!deps.isRepoAllowed(ref.owner, ref.repo)) {
        await leaveConflict(context, ref, "closed");
        continue;
      }
      const pr = await deps.getPr(ref.owner, ref.repo, ref.number);
      const decision = decidePrConflict(pr);
      if (decision.kind === "close") {
        await leaveConflict(context, ref, "closed");
      } else if (decision.kind === "clear") {
        await leaveConflict(context, ref, "resolved");
      } else {
        if (decision.kind === "skip") skip(context, ref, decision.reason);
        await deps.touch(row.id);
      }
    } catch (err) {
      if (isStatus(err, 404)) {
        try {
          await leaveConflict(context, ref, "closed");
        } catch (closeErr) {
          await recordFailureOf(context, `pr_conflict:${key}`, closeErr);
        }
        continue;
      }
      await absorbReadError(context, `pr_conflict:${key}`, key, err);
      if (isStatus(err, 403)) await deps.touch(row.id).catch(() => false);
    }
  }
}
