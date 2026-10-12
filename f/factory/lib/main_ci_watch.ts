// mainのCI監視(`watch_main_ci`)の流れを、外部の操作を注入して組み立てる。
// 対象リポジトリごとに新しいコミットを見つけて記録し(発見)、判定を待つコミットの実行を
// 取り直して確定し(判定)、失敗は通知し、通ったコミットは同じリポジトリの失敗の通知を解決する。
// GitHub、DB、Discordの呼び出しは`MainCiWatchDeps`で渡し、テストで差し替える。
// 外部の文字列(workflow名など)は、通知の本文には載せず、要約(`summary`列)にだけ残す。

import { isRepoAllowed } from "./config.ts";
import type { MainCiRun, MainCiTransition, NewMainCiRun } from "./db.ts";
import type { NotifyEvent } from "./discord.ts";
import {
  GitHubHttpError,
  GitHubRateLimitError,
  parseGitHubRepoUrl,
  WorkflowRunsIncompleteError,
} from "./github.ts";
import type { Logger } from "./log.ts";
import {
  buildFailureSummary,
  decideState,
  failingRuns,
  groupRunsBySha,
  isPrevFailed,
  parseRunUrl,
  planNewShas,
  shortSha,
  WORKFLOW_RUNS_PER_PAGE,
  type WorkflowRun,
} from "./main_ci_support.ts";
import type { FactoryConfig, NoticeRecord } from "./types.ts";

/** コミットのCIが失敗したことを知らせるnoticeの種類。 */
export const MAIN_CI_FAILED_KIND = "main_ci_failed";

/** mainのCIの実行をGitHubから読めないことを知らせるnoticeの種類。 */
export const MAIN_CI_CHECK_DENIED_KIND = "main_ci_check_denied";

/**
 * 自動で解決したnoticeの`resolved_by`に記録する名前。
 * Consoleが日本語の名前に直すので、変えるときは`console/src/lib/systemView.ts`も直す。
 */
export const MAIN_CI_RESOLVED_BY = "watch_main_ci";

/** 1回の実行で判定を試みる、判定待ちのコミットの最大の数。 */
export const PENDING_BATCH_LIMIT = 200;

/**
 * 実行を読めない(`runs`が`null`)まま、最初に見てからこの時間がたったコミットは`expired`にする。
 * 読めないまま判定を待ち続けても、人に知らせる手段が無いため、行を終わらせる。
 */
export const UNREADABLE_EXPIRES_AFTER_MS = 24 * 60 * 60_000;

const FAILED_NEXT_ACTION =
  "実行のログを確かめ、直す修正を入れるか、原因のコミットを取り消す";

const DENIED_NEXT_ACTION =
  "GITHUB_TOKENのfine-grained PATで、このリポジトリにRepository permissionsのActions: Read-onlyを付ける";

/** 監視するリポジトリ。 */
export type WatchTarget = {
  readonly owner: string;
  readonly repo: string;
};

/**
 * 監視するリポジトリを決める。`factory_repo`と`repo_allowlist`のうち、
 * `isRepoAllowed`が許すものを、重複なく返す。
 * `repo_allowlist`が空なら`factory_repo`だけになる。`owners`の全リポジトリを列挙するAPIは使わない。
 * `owners`には、照合を通ったオーナーだけを渡すこと。
 * GitHubのリポジトリのURLとして読めない項目は`invalid`に返す。
 */
export function listMainCiTargets(
  config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
): { targets: WatchTarget[]; invalid: string[] } {
  const targets: WatchTarget[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const url of [config.factory_repo, ...config.repo_allowlist]) {
    let ref: WatchTarget;
    try {
      ref = parseGitHubRepoUrl(url);
    } catch {
      invalid.push(url);
      continue;
    }
    if (!isRepoAllowed(config, ref.owner, ref.repo)) continue;
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(ref);
  }
  return { targets, invalid };
}

/**
 * このリポジトリのnoticeの本文の接頭辞。
 * 自動解決は、種類とこの接頭辞で対象を選ぶ。末尾の区切りまで含めるので、
 * `acme/app: `は`acme/app-extra: `に当たらない。
 */
function noticePrefix(owner: string, repo: string): string {
  return `${owner}/${repo}: `;
}

/**
 * コミットのCIが失敗したnoticeの本文。固定文に、リポジトリ、コミットの先頭7文字、
 * 実行のURLだけを入れる。workflow名や結論は入れない。
 * `runUrl`は`parseRunUrl`を通した値か、検証済みの名前とshaから作ったURLを渡すこと。
 */
export function failedNoticeMessage(
  owner: string,
  repo: string,
  sha: string,
  runUrl: string,
  prevFailed: boolean,
): string {
  const continuing = prevFailed ? "前のコミットから失敗が続いています。" : "";
  return `${noticePrefix(owner, repo)}mainのコミット${shortSha(sha)}でCIが失敗しました。${continuing}次の操作: ${FAILED_NEXT_ACTION}。実行: ${runUrl}`;
}

/** mainのCIの実行を読めないnoticeの本文。リポジトリごとに同じ文になる。 */
export function deniedNoticeMessage(owner: string, repo: string): string {
  return `${noticePrefix(owner, repo)}mainのCIの実行をGitHubから読めません(403か404)。次の操作: ${DENIED_NEXT_ACTION}`;
}

export type MainCiWatchDeps = {
  readonly now: () => Date;
  readonly log: Logger;
  readonly instanceName: string;
  readonly getDefaultBranch: (owner: string, repo: string) => Promise<string>;
  readonly listRuns: (
    owner: string,
    repo: string,
    branch: string,
    headSha?: string,
  ) => Promise<WorkflowRun[]>;
  readonly hasRows: (owner: string, repo: string) => Promise<boolean>;
  readonly latestRunCreatedAt: (
    owner: string,
    repo: string,
  ) => Promise<Date | null>;
  readonly listRowsBySha: (
    owner: string,
    repo: string,
    shas: readonly string[],
  ) => Promise<MainCiRun[]>;
  readonly record: (record: NewMainCiRun) => Promise<boolean>;
  readonly listPending: (limit: number) => Promise<MainCiRun[]>;
  readonly getPrevious: (
    owner: string,
    repo: string,
    runCreatedAt: Date,
  ) => Promise<MainCiRun | null>;
  readonly transition: (id: number, to: MainCiTransition) => Promise<boolean>;
  /** 新しく挿入したら通知のID、同じ未解決の通知があれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly resolveNotices: (
    kind: string,
    messagePrefix: string,
    resolvedBy: string,
  ) => Promise<number>;
  /** 失敗しても例外を投げない送信(`notifyBestEffort`)を渡す。 */
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  /** ジョブの失敗として記録する。記録に失敗しても例外を投げない。 */
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
};

export type MainCiWatchResult = {
  readonly repos: number;
  readonly recorded: number;
  readonly passed: number;
  readonly failed: number;
  readonly expired: number;
  readonly no_ci: number;
  /** 実行を読む権限が無かったリポジトリの数。 */
  readonly denied: number;
  /** 例外で処理できなかった数。 */
  readonly errors: number;
};

type Counters = {
  -readonly [K in keyof MainCiWatchResult]: MainCiWatchResult[K];
};

type WatchState = {
  /** 今回の発見で実行を読めたリポジトリ。判定はこのリポジトリのコミットだけを取り直す。 */
  readonly readable: Set<string>;
  readonly branches: Map<string, string>;
  /** rate limitに当たったら、今回はそれ以上GitHubを読まない。 */
  rateLimited: boolean;
};

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

function isDenied(err: unknown): boolean {
  return (
    err instanceof GitHubHttpError && (err.status === 403 || err.status === 404)
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * mainのCI監視を1回分実行する。
 * 発見(対象のリポジトリごとに、新しいコミットを記録する)の後に、判定(判定待ちのコミットを取り直して確定する)を行う。
 * 例外は、リポジトリごと、コミットごとに捕まえて、他の処理を止めない。
 * 時刻は`deps.now()`を最初に1回だけ読み、workerの時計とGitHubの時計のずれは、確定を待つ時間の余裕で吸収する。
 */
export async function runMainCiWatch(
  targets: readonly WatchTarget[],
  deps: MainCiWatchDeps,
): Promise<MainCiWatchResult> {
  const now = deps.now();
  const counters: Counters = {
    repos: targets.length,
    recorded: 0,
    passed: 0,
    failed: 0,
    expired: 0,
    no_ci: 0,
    denied: 0,
    errors: 0,
  };
  const state: WatchState = {
    readable: new Set(),
    branches: new Map(),
    rateLimited: false,
  };
  const context: Context = { deps, now, counters, state };
  const targetKeys = new Set(
    targets.map((target) => repoKey(target.owner, target.repo)),
  );
  for (const target of targets) {
    if (state.rateLimited) break;
    await discover(context, target);
  }
  await judgePending(context, targetKeys);
  return counters;
}

type Context = {
  readonly deps: MainCiWatchDeps;
  readonly now: Date;
  readonly counters: Counters;
  readonly state: WatchState;
};

async function defaultBranchOf(
  context: Context,
  owner: string,
  repo: string,
): Promise<string> {
  const key = repoKey(owner, repo);
  const cached = context.state.branches.get(key);
  if (cached !== undefined) return cached;
  const branch = await context.deps.getDefaultBranch(owner, repo);
  context.state.branches.set(key, branch);
  return branch;
}

async function recordFailureOf(
  context: Context,
  step: string,
  err: unknown,
): Promise<void> {
  context.counters.errors += 1;
  await context.deps.recordFailure(step, err);
}

/** 対象のリポジトリの実行を読み、まだ記録していないコミットを記録する。 */
async function discover(context: Context, target: WatchTarget): Promise<void> {
  const { deps, state, counters } = context;
  const { owner, repo } = target;
  const key = `${owner}/${repo}`;
  let runs: WorkflowRun[];
  try {
    const branch = await defaultBranchOf(context, owner, repo);
    runs = await deps.listRuns(owner, repo, branch);
  } catch (err) {
    if (err instanceof GitHubRateLimitError) {
      state.rateLimited = true;
      deps.log.warn("main ci discovery stopped by the rate limit", {
        repo: key,
        error: errorMessage(err),
      });
      return;
    }
    if (isDenied(err)) {
      counters.denied += 1;
      deps.log.warn("main ci runs are not readable", {
        repo: key,
        error: errorMessage(err),
      });
      try {
        await deps.addNotice({
          kind: MAIN_CI_CHECK_DENIED_KIND,
          message: deniedNoticeMessage(owner, repo),
        });
      } catch (noticeErr) {
        await recordFailureOf(context, `denied_notice:${key}`, noticeErr);
      }
      return;
    }
    await recordFailureOf(context, `discover:${key}`, err);
    return;
  }
  state.readable.add(repoKey(owner, repo));
  try {
    await deps.resolveNotices(
      MAIN_CI_CHECK_DENIED_KIND,
      noticePrefix(owner, repo),
      MAIN_CI_RESOLVED_BY,
    );
    await recordNewCommits(context, target, runs);
  } catch (err) {
    await recordFailureOf(context, `discover:${key}`, err);
  }
}

async function recordNewCommits(
  context: Context,
  target: WatchTarget,
  runs: readonly WorkflowRun[],
): Promise<void> {
  const { deps, counters } = context;
  const { owner, repo } = target;
  const groups = groupRunsBySha(runs);
  if (groups.length === 0) return;
  const hasRows = await deps.hasRows(owner, repo);
  const latest = await deps.latestRunCreatedAt(owner, repo);
  const knownRows = await deps.listRowsBySha(
    owner,
    repo,
    groups.map((group) => group.headSha),
  );
  const planned = planNewShas(
    groups.map((group) => ({
      headSha: group.headSha,
      runCreatedAt: group.oldestCreatedAt,
    })),
    new Set(knownRows.map((known) => known.head_sha)),
    hasRows,
    latest,
  );
  if (runs.length >= WORKFLOW_RUNS_PER_PAGE && latest !== null) {
    const oldest = Math.min(...runs.map((run) => run.createdAt.getTime()));
    if (oldest > latest.getTime()) {
      deps.log.warn(
        "main ci discovery page is full; older commits may be missed",
        { repo: `${owner}/${repo}` },
      );
    }
  }
  for (const item of planned) {
    try {
      await deps.record({
        owner,
        repo,
        head_sha: item.headSha,
        state: item.state,
        run_created_at: item.runCreatedAt,
      });
      counters.recorded += 1;
    } catch (err) {
      // 続けて記録すると、最新のコミットが抜けたり、古いコミットが黙って基準線になったりする。
      await recordFailureOf(context, `record_commit:${owner}/${repo}`, err);
      return;
    }
  }
}

/** 判定待ちのコミットを、取り直した実行で確定する。 */
async function judgePending(
  context: Context,
  targetKeys: ReadonlySet<string>,
): Promise<void> {
  const { deps } = context;
  let rows: MainCiRun[];
  try {
    rows = await deps.listPending(PENDING_BATCH_LIMIT);
  } catch (err) {
    await recordFailureOf(context, "list_pending", err);
    return;
  }
  for (const row of rows) {
    try {
      await judgeRow(context, row, targetKeys);
    } catch (err) {
      await recordFailureOf(
        context,
        `judge_commit:${row.owner}/${row.repo}`,
        err,
      );
    }
  }
}

/**
 * コミットの実行を取り直す。読めなかったら`null`を返す。
 * 発見で読めなかったリポジトリと、対象から外れたリポジトリは、読まずに`null`を返す。
 */
async function readRuns(
  context: Context,
  row: MainCiRun,
  targetKeys: ReadonlySet<string>,
): Promise<WorkflowRun[] | null> {
  const { deps, state } = context;
  const key = repoKey(row.owner, row.repo);
  if (!targetKeys.has(key) || !state.readable.has(key) || state.rateLimited) {
    return null;
  }
  try {
    const branch = await defaultBranchOf(context, row.owner, row.repo);
    return await deps.listRuns(row.owner, row.repo, branch, row.head_sha);
  } catch (err) {
    if (err instanceof GitHubRateLimitError) {
      state.rateLimited = true;
      deps.log.warn("main ci judging stopped by the rate limit", {
        repo: `${row.owner}/${row.repo}`,
        error: errorMessage(err),
      });
    } else if (err instanceof WorkflowRunsIncompleteError || isDenied(err)) {
      deps.log.warn("main ci runs of a commit are not usable", {
        repo: `${row.owner}/${row.repo}`,
        error: errorMessage(err),
      });
    } else {
      await recordFailureOf(
        context,
        `judge_commit:${row.owner}/${row.repo}`,
        err,
      );
    }
    return null;
  }
}

async function judgeRow(
  context: Context,
  row: MainCiRun,
  targetKeys: ReadonlySet<string>,
): Promise<void> {
  const { deps, now, counters } = context;
  const runs = await readRuns(context, row, targetKeys);
  let verdict = decideState({ runs, firstSeenAt: row.first_seen_at, now });
  if (
    runs === null &&
    now.getTime() - row.first_seen_at.getTime() >= UNREADABLE_EXPIRES_AFTER_MS
  ) {
    verdict = "expired";
  }
  if (verdict === "pending") return;
  if (verdict === "failed" && runs !== null) {
    await settleFailed(context, row, runs);
    return;
  }
  if (verdict === "passed") {
    await settlePassed(context, row);
    return;
  }
  if (verdict === "expired" || verdict === "no_ci") {
    const moved = await deps.transition(row.id, {
      state: verdict,
      summary: "",
      prevFailed: false,
    });
    if (moved) {
      counters[verdict] += 1;
      deps.log.info("main ci commit settled without a verdict", {
        repo: `${row.owner}/${row.repo}`,
        sha: row.head_sha,
        state: verdict,
      });
    }
  }
}

/** 通知に載せる実行のURL。失敗した実行のうち、検証を通った最初のもの。無ければコミットのページ。 */
function pickRunUrl(row: MainCiRun, runs: readonly WorkflowRun[]): string {
  for (const run of failingRuns(runs)) {
    const url = parseRunUrl(run.htmlUrl, row.owner, row.repo);
    if (url !== null) return url;
  }
  return `https://github.com/${row.owner}/${row.repo}/commit/${row.head_sha}`;
}

async function settleFailed(
  context: Context,
  row: MainCiRun,
  runs: readonly WorkflowRun[],
): Promise<void> {
  const { deps, counters } = context;
  const previous = await deps.getPrevious(
    row.owner,
    row.repo,
    row.run_created_at ?? row.first_seen_at,
  );
  const prevFailed = isPrevFailed(previous === null ? null : previous.state);
  const summary = buildFailureSummary(runs, prevFailed);
  const runUrl = pickRunUrl(row, runs);
  // 通知を先に登録する。状態の更新が先に成功して通知が失敗すると、通知が永久に出ないため。
  const noticeId = await deps.addNotice({
    kind: MAIN_CI_FAILED_KIND,
    message: failedNoticeMessage(
      row.owner,
      row.repo,
      row.head_sha,
      runUrl,
      prevFailed,
    ),
  });
  if (noticeId !== null) {
    await deps.notify({
      kind: "main_ci_failed",
      instance_name: deps.instanceName,
      owner: row.owner,
      repo: row.repo,
      sha7: shortSha(row.head_sha),
      url: runUrl,
      prev_failed: prevFailed,
      next_action: FAILED_NEXT_ACTION,
    });
  }
  const moved = await deps.transition(row.id, {
    state: "failed",
    summary,
    prevFailed,
  });
  if (moved) {
    counters.failed += 1;
    deps.log.warn("main ci failed", {
      repo: `${row.owner}/${row.repo}`,
      sha: row.head_sha,
      prev_failed: prevFailed,
    });
  }
}

async function settlePassed(context: Context, row: MainCiRun): Promise<void> {
  const { deps, counters } = context;
  const moved = await deps.transition(row.id, {
    state: "passed",
    summary: "",
    prevFailed: false,
  });
  if (!moved) return;
  counters.passed += 1;
  // より新しいコミットを記録済みなら、その結果を待つ。古いコミットが遅れて通っても、新しい失敗は解決しない。
  const latest = await deps.latestRunCreatedAt(row.owner, row.repo);
  const own = row.run_created_at ?? row.first_seen_at;
  if (latest === null || latest.getTime() <= own.getTime()) {
    await deps.resolveNotices(
      MAIN_CI_FAILED_KIND,
      noticePrefix(row.owner, row.repo),
      MAIN_CI_RESOLVED_BY,
    );
  }
}
