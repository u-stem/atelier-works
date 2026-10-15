// FactoryのPRのマージの競合の監視(`watch_pr_conflicts`)の流れを、外部の操作を注入して組み立てる。
// 検知と通知だけを行い、PRにもリポジトリにも書き込まず、修正は起動しない。
//
// 対象は、作業項目の`pr_url`から引いたPRのうち、許可リストに合うリポジトリの、
// 開いていて、下書きでなく、forkでなく、Factoryのブランチのものである。
// 競合とみなすのは、`mergeable`が偽で`mergeable_state`が`dirty`のときだけである(`decidePrConflict`)。
// GitHubが計算していない(`mergeable`が`null`)PRは何もせず、次の回に判定し直す。
//
// 競合は、PRごとの行にheadとbaseのコミットを記録する。同じPR・同じhead・同じbaseでは通知を重ねない。
// headかbaseが進んだら、古い通知を解決して通知し直す。競合が解けたら通知を解決し、PRが閉じたら通知を解決して行を閉じる。
// 通知の登録とDiscordの後に、通知した時刻を記録する。記録が先に成功して通知が失敗すると、通知が出なくなるためである。
//
// 作業項目が追跡から外れた(PRがマージされた後など)競合の行は、PRを読み直して、解けたか閉じたかを確かめる。
// 外部由来の文字列(題名、ブランチ名)は、通知にもログにも載せない。
// 例外は、PRごとに捕まえて、他のPRを止めない。rate limitは、以降の読み取りを止める。

import type {
  PrConflictCheck,
  PrConflictObservation,
  PrConflictSettledState,
} from "./db.ts";
import type { NotifyBestEffortResult, NotifyEvent } from "./discord.ts";
import {
  GitHubHttpError,
  GitHubRateLimitError,
  type PullRequest,
} from "./github.ts";
import type { Logger } from "./log.ts";
import { pullRequestKey } from "./pr_ci_human_support.ts";
import {
  type FactoryWorkItemRef,
  isFactoryPrBranch,
  type PullRequestRef,
  parsePullRequestUrl,
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
import { assertGitHubName, type NoticeRecord } from "./types.ts";

/** 1回の実行で読む、競合している行の最大の数。追跡の上限より多く取り、追跡から外れた行の整理も受け持つ。 */
export const CONFLICT_ROW_LIMIT = 200;

export type PrConflictWatchDeps = {
  readonly now: () => Date;
  readonly log: Logger;
  readonly instanceName: string;
  /** 許可リストと、照合を通ったオーナーに合うリポジトリか(`buildRepoGates`)。 */
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  /** PRを作ったまま`pr_open`の作業項目。新しい順に、最大`TRACKED_PR_LIMIT`件(`pr_ci_watch.ts`)。 */
  readonly listTrackedItems: () => Promise<FactoryWorkItemRef[]>;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
  /** 競合している行を、読み直していない順に返す。 */
  readonly listConflicted: (limit: number) => Promise<PrConflictCheck[]>;
  /** 競合を記録し、その行を返す(`recordPrConflict`)。 */
  readonly record: (
    observation: PrConflictObservation,
  ) => Promise<PrConflictCheck>;
  /** 通知した時刻を記録する。この呼び出しで書いたら`true`。 */
  readonly markNotified: (
    id: number,
    headSha: string,
    baseSha: string,
  ) => Promise<boolean>;
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
  /** 閉じられたPRの行を閉じた数。 */
  readonly closed: number;
  /** 失敗したPRの数。 */
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
  errors: 0,
  rateLimited: false,
};

type Counters = {
  tracked: number;
  conflicted: number;
  notified: number;
  resolved: number;
  closed: number;
  errors: number;
  rateLimited: boolean;
};

type Context = {
  readonly deps: PrConflictWatchDeps;
  readonly startedAt: Date;
  readonly counters: Counters;
  /** この回の最初に読んだ、競合している行。PRの鍵で引く。 */
  readonly rows: Map<string, PrConflictCheck>;
};

function isDenied(err: unknown): boolean {
  return (
    err instanceof GitHubHttpError && (err.status === 403 || err.status === 404)
  );
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

/**
 * PRのマージの競合の監視を1回分実行する。
 * 競合している行を読めなければ、何も読まずに失敗として記録して終わる。
 */
export async function runPrConflictWatch(
  deps: PrConflictWatchDeps,
): Promise<PrConflictWatchResult> {
  const context: Context = {
    deps,
    startedAt: deps.now(),
    counters: { ...PR_CONFLICT_WATCH_IDLE_RESULT },
    rows: new Map(),
  };
  try {
    for (const row of await deps.listConflicted(CONFLICT_ROW_LIMIT)) {
      context.rows.set(pullRequestKey(rowRef(row)), row);
    }
  } catch (err) {
    await recordFailureOf(context, "list_conflicted", err);
    return context.counters;
  }
  const seen = await watchTracked(context);
  await watchUntracked(context, seen);
  return context.counters;
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
 * 読み取りの失敗を扱う。rate limitは以降の読み取りを止め、権限の不足(403、404)は読み飛ばし、
 * それ以外は失敗として記録する。
 */
async function absorbError(
  context: Context,
  ref: PullRequestRef,
  err: unknown,
): Promise<void> {
  const { deps, counters } = context;
  const key = pullRequestKey(ref);
  if (err instanceof GitHubRateLimitError) {
    counters.rateLimited = true;
    deps.log.warn("pr conflict reading stopped by the rate limit", {
      pr: key,
      error: errorMessage(err),
    });
    return;
  }
  if (isDenied(err)) {
    deps.log.warn("pr conflict skipped a pull request that is not readable", {
      pr: key,
      error: errorMessage(err),
    });
    return;
  }
  await recordFailureOf(context, `pr_conflict:${key}`, err);
}

/** 追跡中の作業項目のPRを読んで扱う。読んだPRの鍵の集合を返す。 */
async function watchTracked(context: Context): Promise<Set<string>> {
  const { deps, counters } = context;
  const seen = new Set<string>();
  let items: FactoryWorkItemRef[];
  try {
    items = await deps.listTrackedItems();
  } catch (err) {
    await recordFailureOf(context, "list_tracked", err);
    return seen;
  }
  for (const item of items) {
    if (stopped(context)) break;
    const ref = item.prUrl === null ? null : parsePullRequestUrl(item.prUrl);
    if (ref === null || !deps.isRepoAllowed(ref.owner, ref.repo)) continue;
    // `parsePullRequestUrl`は先頭が`.`のリポジトリ名も通すが、記録は通さない。読まずに飛ばす。
    try {
      assertGitHubName(ref.owner);
      assertGitHubName(ref.repo);
    } catch {
      continue;
    }
    seen.add(pullRequestKey(ref));
    counters.tracked += 1;
    try {
      await handleTracked(context, item, ref);
    } catch (err) {
      await absorbError(context, ref, err);
    }
  }
  return seen;
}

async function handleTracked(
  context: Context,
  item: FactoryWorkItemRef,
  ref: PullRequestRef,
): Promise<void> {
  const pr = await context.deps.getPr(ref.owner, ref.repo, ref.number);
  // 閉じたPRは、forkかどうかに依らず、行と通知を整理する。
  // 開いているPRは、forkのPRとFactoryのものでないブランチを対象にしない。
  if (
    pr.state === "open" &&
    (!isSameRepoHead(pr) || !isFactoryPrBranch(pr.headRef, ref, item))
  ) {
    return;
  }
  await applyDecision(context, ref, pr);
}

/** PRの今の状態から決めた扱いを、書き込みに移す。 */
async function applyDecision(
  context: Context,
  ref: PullRequestRef,
  pr: PullRequest,
): Promise<void> {
  const decision = decidePrConflict(pr);
  const row = context.rows.get(pullRequestKey(ref));
  switch (decision.kind) {
    case "close":
      if (row !== undefined) await leaveConflict(context, ref, row, "closed");
      return;
    case "clear":
      if (row !== undefined) await leaveConflict(context, ref, row, "resolved");
      return;
    case "skip":
      return;
    case "conflict":
      await settleConflict(
        context,
        ref,
        row,
        decision.headSha,
        decision.baseSha,
      );
      return;
  }
}

/**
 * 競合から離れた行を整理する。通知を解決してから、行を移す。
 * 通知の解決が失敗した回は、行を競合のまま残し、次の回にやり直す。
 */
async function leaveConflict(
  context: Context,
  ref: PullRequestRef,
  row: PrConflictCheck,
  to: PrConflictSettledState,
): Promise<void> {
  const { deps, counters } = context;
  await deps.resolveNotices(
    PR_CONFLICT_KIND,
    prConflictNoticePrefix(ref.owner, ref.repo, ref.number),
    PR_CONFLICT_RESOLVED_BY,
  );
  const moved = await deps.settle(row.id, to);
  if (!moved) return;
  if (to === "resolved") counters.resolved += 1;
  else counters.closed += 1;
  deps.log.info("pr conflict row settled", {
    pr: pullRequestKey(ref),
    state: to,
  });
}

/**
 * 競合を記録し、まだ通知していない組なら通知する。
 * 前回と同じheadとbaseなら、通知を解決せずに記録する。通知の登録だけが済んだ回の通知を、重ねないためである。
 * headかbaseが違う(または初めての)組は、古い通知を解決してから記録する。
 */
async function settleConflict(
  context: Context,
  ref: PullRequestRef,
  prior: PrConflictCheck | undefined,
  headSha: string,
  baseSha: string,
): Promise<void> {
  const { deps, counters } = context;
  const sameKey =
    prior !== undefined &&
    prior.head_sha === headSha &&
    prior.base_sha === baseSha;
  if (!sameKey) {
    await deps.resolveNotices(
      PR_CONFLICT_KIND,
      prConflictNoticePrefix(ref.owner, ref.repo, ref.number),
      PR_CONFLICT_RESOLVED_BY,
    );
  }
  const row = await deps.record({
    owner: ref.owner,
    repo: ref.repo,
    pr_number: ref.number,
    head_sha: headSha,
    base_sha: baseSha,
  });
  counters.conflicted += 1;
  if (row.notified_at !== null) return;
  // 通知を先に登録する。通知した時刻の記録が先に成功して登録が失敗すると、通知が永久に出ないため。
  const noticeId = await deps.addNotice({
    kind: PR_CONFLICT_KIND,
    message: prConflictNoticeMessage({
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.number,
      headSha,
      baseSha,
    }),
  });
  if (noticeId !== null) {
    const url = pullRequestPageUrl(ref.owner, ref.repo, ref.number);
    const sent = await deps.notify({
      kind: "needs_human",
      instance_name: deps.instanceName,
      owner: ref.owner,
      repo: ref.repo,
      url,
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
  if (await deps.markNotified(row.id, headSha, baseSha)) {
    counters.notified += 1;
    deps.log.warn("pr conflict notified", { pr: pullRequestKey(ref) });
  }
}

/**
 * 追跡から外れた競合の行を整理する。PRを読み直し、閉じたか競合が解けたときだけ行を移す。
 * それ以外は、読み直した時刻だけを進める。通知は出さない。
 * 許可リストから外れたリポジトリの行は、読まずに時刻だけを進めて、ほかの行を押し出さないようにする。
 */
async function watchUntracked(
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
        await deps.touch(row.id);
        continue;
      }
      const pr = await deps.getPr(ref.owner, ref.repo, ref.number);
      const decision = decidePrConflict(pr);
      if (decision.kind === "close") {
        await leaveConflict(context, ref, row, "closed");
      } else if (decision.kind === "clear") {
        await leaveConflict(context, ref, row, "resolved");
      } else {
        await deps.touch(row.id);
      }
    } catch (err) {
      await absorbError(context, ref, err);
    }
  }
}
