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
 * 実行を読めないという永続的な条件のまま、最初に見てからこの時間がたったコミットは`expired`にする。
 * 永続的な条件は、次の2つである。
 * - `head_sha`を指定した読み取りが、実行の多さ(`WorkflowRunsIncompleteError`)か403・404で、読み切れない。
 * - リポジトリが対象から外れた。
 * 発見の403・404、rate limit、サーバーの一時的な失敗は、一時的な条件なので数えない。
 * 読めないまま判定を待ち続けても、人に知らせる手段が無いので、行を終わらせる。
 */
export const UNREADABLE_EXPIRES_AFTER_MS = 24 * 60 * 60_000;

/**
 * 最初に見てからこの時間がたち、かつより新しい行がある行の失敗は、通知しない。
 * 権限が長く戻らなかった後に判定が再開したときに、止まっていた間の古い失敗を一度に通知しないためである。
 * そのリポジトリで最新の行の失敗は、この時間がたっていても通知する。
 * 失敗は`failed`として記録し、要約も残す。
 */
export const STALE_FAILURE_AFTER_MS = 24 * 60 * 60_000;

/**
 * 1回の実行で、新しい読み取りと、失敗の確定(通知の登録とDiscord)を始めてよい経過時間。
 * 超えたら、残りは次の回に回す。通ったコミットの確定など、軽い適用は予算の対象にしない。
 * ただし、失敗の確定は、1回の実行で最初の1件を予算を見ずに進める。
 * 予算切れが続いても、失敗の通知が飢えないためである。
 *
 * scriptのtimeout(600秒)との関係は次のとおりである。
 * - 1回の要求の上限は、ghの実行60秒、5xxの再送(待ち2秒と実行60秒)、rate limitの待ち120秒を足した約240秒。
 *   rate limitの待ちの後の再試行が再び拒まれたら、読み取りをやめる。
 * - 予算の直前に始めた発見は、既定ブランチの取得と実行一覧の2要求なので、最悪で約480秒かかる。
 * - 予算の直前に始めた判定の読み取りは、1ページなら約240秒、最大3ページで3倍になる。
 * - 適用の段で予算を見ない最初の失敗には、Discordの待ち(最大30秒)がかかる。
 * 通常はrate limitの待ちも再送も起きず、数秒から数十秒で終わるので、timeoutに収まる。
 * rate limitの待ちが重なると、timeoutを超えうる。
 * そのときはjobが打ち切られるが、行ごとの更新は冪等なので、確定しなかった行は次の回に残る。
 */
export const RUN_BUDGET_MS = 180_000;

const FAILED_NEXT_ACTION =
  "実行のログを確かめ、直す修正を入れるか、原因のコミットを取り消す";

const DENIED_NEXT_ACTION =
  "PATのRepository accessに対象リポジトリが入っているか、Actions: Read-onlyが付いているかを確かめる";

/** 監視するリポジトリ。 */
export type WatchTarget = {
  readonly owner: string;
  readonly repo: string;
};

/**
 * 監視するリポジトリを決める。`factory_repo`と`repo_allowlist`のうち、
 * `isRepoAllowed`が許すものを、重複なく返す。
 * `factory_repo`は、`owners`の照合や`repo_allowlist`によらず、常に対象になる。
 * `repo_allowlist`の項目は、`owners`(照合を通ったオーナーだけを渡すこと)に含まれるオーナーのものだけを通す。
 * `repo_allowlist`が空なら`factory_repo`だけになる。`owners`の全リポジトリを列挙するAPIは使わない。
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
  return `${noticePrefix(owner, repo)}mainのCIの実行をGitHubから読めません(403か404)。PATの権限が足りないか、リポジトリにアクセスできません。次の操作: ${DENIED_NEXT_ACTION}`;
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
  /**
   * 並びの鍵が`(runCreatedAt, id)`より後のコミットで、`passed`のものがあるか。
   * 時刻が同じコミットは、`id`の大きい方を後とする。
   */
  readonly hasNewerPassed: (
    owner: string,
    repo: string,
    runCreatedAt: Date,
    id: number,
  ) => Promise<boolean>;
  /**
   * 並びの鍵が`(runCreatedAt, id)`より後のコミットを、状態を問わず記録済みか。
   * 古い失敗を通知するかの判断に使う。
   */
  readonly hasNewerRow: (
    owner: string,
    repo: string,
    runCreatedAt: Date,
    id: number,
  ) => Promise<boolean>;
  /**
   * 並びの鍵が`(runCreatedAt, id)`より後のコミットで、判定待ちか失敗のものを記録済みか。
   * 通ったコミットが失敗の通知を解決してよいかの判断に使う。
   */
  readonly hasNewerUnsettledOrFailedRow: (
    owner: string,
    repo: string,
    runCreatedAt: Date,
    id: number,
  ) => Promise<boolean>;
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
  /** この回で、失敗の確定を始めた数。最初の1件は、予算を見ずに確定する。 */
  failedStarted: number;
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
    failedStarted: 0,
  };
  const context: Context = { deps, now, counters, state };
  const targetKeys = new Set(
    targets.map((target) => repoKey(target.owner, target.repo)),
  );
  for (const target of targets) {
    if (state.rateLimited || overBudget(context)) break;
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

/** 実行の開始から`RUN_BUDGET_MS`以上たったか。たったら、新しい読み取りは始めない。 */
function overBudget(context: Context): boolean {
  return context.deps.now().getTime() - context.now.getTime() >= RUN_BUDGET_MS;
}

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

/** 判定待ちの行の実行を取り直した結果。 */
type ReadOutcome =
  | { readonly kind: "runs"; readonly runs: WorkflowRun[] }
  /** 永続的な条件で読めない。一定の時間が続けば、期限切れにしてよい。 */
  | { readonly kind: "unreadable" }
  /** 今回は読めなかった(rate limit、一時的な失敗、発見の失敗、時間切れ)。何も決めず、次の回に回す。 */
  | { readonly kind: "skip" };

/** 読み取りの後に決めた、行の行き先。適用は`passed`、`failed`、`settle`の順に行う。 */
type Judgement =
  | { readonly kind: "passed"; readonly row: MainCiRun }
  | {
      readonly kind: "failed";
      readonly row: MainCiRun;
      readonly runs: readonly WorkflowRun[];
    }
  | {
      readonly kind: "settle";
      readonly row: MainCiRun;
      readonly state: "expired" | "no_ci";
    };

/**
 * 判定待ちのコミットを、取り直した実行で確定する。2段で行う。
 * 先に全行の結果を決め、次に`passed`、`failed`、その他の順に適用する。
 * 同じ回で古いコミットが失敗し、新しいコミットが通ったときに、古い失敗を通知しないためである。
 */
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
  const judgements: Judgement[] = [];
  for (const row of rows) {
    if (overBudget(context)) break;
    try {
      const judgement = decideRow(
        context,
        row,
        await readRuns(context, row, targetKeys),
      );
      if (judgement !== null) judgements.push(judgement);
    } catch (err) {
      await recordFailureOf(
        context,
        `judge_commit:${row.owner}/${row.repo}`,
        err,
      );
    }
  }
  for (const kind of ["passed", "failed", "settle"] as const) {
    for (const judgement of judgements) {
      if (judgement.kind !== kind) continue;
      try {
        await applyJudgement(context, judgement);
      } catch (err) {
        await recordFailureOf(
          context,
          `judge_commit:${judgement.row.owner}/${judgement.row.repo}`,
          err,
        );
      }
    }
  }
}

/**
 * コミットの実行を取り直す。
 * 発見で読めなかったリポジトリ、rate limit、一時的な失敗、時間切れは、何も決めずに`skip`にする。
 * `head_sha`を指定した読み取りが、実行の多すぎる(`WorkflowRunsIncompleteError`)か403・404で読めないときと、
 * 対象から外れたリポジトリは、永続的な条件なので`unreadable`にする。
 */
async function readRuns(
  context: Context,
  row: MainCiRun,
  targetKeys: ReadonlySet<string>,
): Promise<ReadOutcome> {
  const { deps, state } = context;
  const key = repoKey(row.owner, row.repo);
  if (!targetKeys.has(key)) return { kind: "unreadable" };
  if (!state.readable.has(key) || state.rateLimited) return { kind: "skip" };
  try {
    const branch = await defaultBranchOf(context, row.owner, row.repo);
    const runs = await deps.listRuns(row.owner, row.repo, branch, row.head_sha);
    return { kind: "runs", runs };
  } catch (err) {
    if (err instanceof GitHubRateLimitError) {
      state.rateLimited = true;
      deps.log.warn("main ci judging stopped by the rate limit", {
        repo: `${row.owner}/${row.repo}`,
        error: errorMessage(err),
      });
      return { kind: "skip" };
    }
    if (err instanceof WorkflowRunsIncompleteError || isDenied(err)) {
      deps.log.warn("main ci runs of a commit are not usable", {
        repo: `${row.owner}/${row.repo}`,
        error: errorMessage(err),
      });
      return { kind: "unreadable" };
    }
    await recordFailureOf(
      context,
      `judge_commit:${row.owner}/${row.repo}`,
      err,
    );
    return { kind: "skip" };
  }
}

/** 読み取りの結果から、行の行き先を決める。決めないとき(次の回に回すとき)は`null`を返す。 */
function decideRow(
  context: Context,
  row: MainCiRun,
  outcome: ReadOutcome,
): Judgement | null {
  const { now } = context;
  if (outcome.kind === "skip") return null;
  if (outcome.kind === "unreadable") {
    return now.getTime() - row.first_seen_at.getTime() >=
      UNREADABLE_EXPIRES_AFTER_MS
      ? { kind: "settle", row, state: "expired" }
      : null;
  }
  const { runs } = outcome;
  const verdict = decideState({ runs, firstSeenAt: row.first_seen_at, now });
  if (verdict === "passed") return { kind: "passed", row };
  if (verdict === "failed") return { kind: "failed", row, runs };
  // 期限が来ても、完了した失敗が1件でもあれば、捨てずに失敗として確定する。
  if (verdict === "expired" && failingRuns(runs).length > 0) {
    return { kind: "failed", row, runs };
  }
  if (verdict === "expired" || verdict === "no_ci") {
    return { kind: "settle", row, state: verdict };
  }
  return null;
}

async function applyJudgement(
  context: Context,
  judgement: Judgement,
): Promise<void> {
  const { deps, counters } = context;
  if (judgement.kind === "passed") {
    await settlePassed(context, judgement.row);
    return;
  }
  if (judgement.kind === "failed") {
    // 通知の登録とDiscordは、予算の後に始めない。状態を変えずに、次の回に回す。
    // ただし、1回の実行で最初の1件は予算を見ずに確定する。予算切れが続いても、失敗の通知が飢えないためである。
    const first = context.state.failedStarted === 0;
    context.state.failedStarted += 1;
    if (!first && overBudget(context)) {
      deps.log.warn("main ci failure left to the next run by the time budget", {
        repo: `${judgement.row.owner}/${judgement.row.repo}`,
        sha: judgement.row.head_sha,
      });
      return;
    }
    await settleFailed(context, judgement.row, judgement.runs);
    return;
  }
  const { row, state } = judgement;
  const moved = await deps.transition(row.id, {
    state,
    summary: "",
    prevFailed: false,
  });
  if (moved) {
    counters[state] += 1;
    deps.log.info("main ci commit settled without a verdict", {
      repo: `${row.owner}/${row.repo}`,
      sha: row.head_sha,
      state,
    });
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
  const own = row.run_created_at ?? row.first_seen_at;
  const previous = await deps.getPrevious(row.owner, row.repo, own);
  const prevFailed = isPrevFailed(previous === null ? null : previous.state);
  const summary = buildFailureSummary(runs, prevFailed);
  const runUrl = pickRunUrl(row, runs);
  // 次の2つの失敗は、知らせても人の行動につながらないので、通知を出さずに確定する。
  // - 最初に見てから長くたち、より新しい行がある失敗。権限が戻らなかった間に溜まった古い失敗である。
  //   そのリポジトリで最新の行は、長くたっていても通知する。今も壊れているmainの先頭の失敗を捨てないためである。
  // - より新しいコミットが既に通っている失敗。直った後に分かったことである。
  const stale =
    context.now.getTime() - row.first_seen_at.getTime() >=
      STALE_FAILURE_AFTER_MS &&
    (await deps.hasNewerRow(row.owner, row.repo, own, row.id));
  const silent =
    stale || (await deps.hasNewerPassed(row.owner, row.repo, own, row.id));
  if (!silent) {
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
        next_action: FAILED_NEXT_ACTION,
      });
    }
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
      silent,
    });
  }
}

async function settlePassed(context: Context, row: MainCiRun): Promise<void> {
  const { deps, counters } = context;
  // より新しいコミットが判定待ちか失敗なら、その結果を待つ。古いコミットが遅れて通っても、新しい失敗は解決しない。
  // 新しいコミットが期限切れ、実行なし、基準の記録のどれかなら、解決を妨げない。
  // 解決は冪等なので、状態の更新より先に行う。更新に失敗した回は、次の回に解決をやり直せる。
  const own = row.run_created_at ?? row.first_seen_at;
  if (
    !(await deps.hasNewerUnsettledOrFailedRow(row.owner, row.repo, own, row.id))
  ) {
    await deps.resolveNotices(
      MAIN_CI_FAILED_KIND,
      noticePrefix(row.owner, row.repo),
      MAIN_CI_RESOLVED_BY,
    );
  }
  const moved = await deps.transition(row.id, {
    state: "passed",
    summary: "",
    prevFailed: false,
  });
  if (moved) counters.passed += 1;
}
