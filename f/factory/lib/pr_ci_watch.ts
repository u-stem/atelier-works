// FactoryのPRのCI監視(`watch_pr_ci`)の流れを、外部の操作を注入して組み立てる。
// 発見(Factoryが作ったPRの今のheadを記録し、古いheadの行を整理する)の後に、
// 判定(判定待ち、失敗、実行なしの行を読み直して確定する)を行う。
// 失敗は通知し、通ったheadはそのPRの失敗の通知を解決し、閉じたPRの行は整理する。
// 発見と判定の間に、回復(失敗を直す作業項目が終わった`fixing`の行を戻す)を行う。回復は監視の設定に依らず動き、
// 作業項目の起動はしない(`runPrCiRecovery`)。
// 判定の後に、起動(失敗した行を直す作業項目を起動する)を行う。起動は`deps.claim`を渡したときだけ動く。
// 起動してよいかの判断は`pr_ci_fix_claim.ts`にあり、ここは読み取りと書き込みの順序を受け持つ。
// 失敗の通知は起動と独立に、従来どおりすぐ出す。
// GitHub、DB、Discordの呼び出しは`PrCiWatchDeps`で渡し、テストで差し替える。
// 外部の文字列(workflow名、実行の結論、ログ)は、通知の本文にもDiscordにも載せない。
// 要約(`summary`列)にだけ、検証・整形した名前を残す。
//
// 1つの行の判定は、実行を読む、PRのheadを読む、判定する、の順に行う。
// 先にPRのheadを読むと、読んでいる間に進んだheadの実行を、今のheadの失敗として扱ってしまう。

import { isRepoAllowed } from "./config.ts";
import type {
  ClaimPrCiCheckInput,
  NewPrCiCheck,
  PrCiCheck,
  PrCiTransition,
} from "./db.ts";
import type { NotifyBestEffortResult, NotifyEvent } from "./discord.ts";
import {
  GitHubHttpError,
  GitHubRateLimitError,
  type PrCommitMessages,
  type PrHeadWorkflowRuns,
  type PrHeadWorkflowRunsOptions,
  type PullRequest,
  type WorkflowRunJob,
  WorkflowRunsIncompleteError,
} from "./github.ts";
import type { Logger } from "./log.ts";
import type { WorkflowRun } from "./main_ci_support.ts";
import {
  classifyHeadFailure,
  decideFixClaim,
  type FixClaimReaders,
} from "./pr_ci_fix_claim.ts";
import {
  decideFixingRecovery,
  type FixItemState,
} from "./pr_ci_fix_recovery.ts";
import {
  classifyPrCiReason,
  decidePrCiFailed,
  decidePrCiPending,
  type FactoryWorkItemRef,
  isFactoryPrBranch,
  PR_CI_FAILED_KIND,
  type PrCiFixHoldReason,
  type PrCiState,
  type PullRequestRef,
  parsePullRequestUrl,
  planPrHead,
  prCiFailedNoticeMessage,
  prCiFailureLink,
  prCiNextAction,
  prCiNoticePrefix,
  prCiSummary,
  pullRequestPageUrl,
} from "./pr_ci_support.ts";
import { PrFixFlowJobIdRecordError } from "./pr_fix_launch.ts";
import {
  assertGitHubName,
  type FactoryConfig,
  type FactoryOwner,
  type NoticeRecord,
} from "./types.ts";

/** PRのCIの実行をGitHubから読めないことを知らせるnoticeの種類。 */
export const PR_CI_CHECK_DENIED_KIND = "pr_ci_check_denied";

/**
 * 自動で解決したnoticeの`resolved_by`に記録する名前。
 * Consoleが日本語の名前に直すので、変えるときは`console/src/lib/systemView.ts`も直す。
 */
export const PR_CI_RESOLVED_BY = "watch_pr_ci";

/** 1回の実行で、巡回するFactoryのPRの最大の数。新しい作業項目から数える。 */
export const TRACKED_PR_LIMIT = 50;

/** 1回の実行で読み直す、判定待ちの行の最大の数。 */
export const PENDING_BATCH_LIMIT = 200;

/** 1回の実行で読み直す、失敗の行の最大の数。 */
export const FAILED_BATCH_LIMIT = 100;

/** 1回の実行で読み直す、実行なし(`no_ci`)の行の最大の数。 */
export const NO_CI_BATCH_LIMIT = 50;

/** 1回の実行で回復の対象にする、修正中(`fixing`)の行の最大の数。 */
export const FIXING_BATCH_LIMIT = 100;

/** 1回の実行で回復の対象にする、直す作業項目に結ばれていない修正中の行の最大の数。 */
export const ORPHAN_FIXING_BATCH_LIMIT = 50;

/** 1回の実行で起動の候補にする、失敗の行の最大の数。 */
export const CLAIM_BATCH_LIMIT = 50;

/**
 * 1回の実行で起動する行の最大の数。
 * 直す作業項目はClaudeを走らせてPRにpushするので、一度に起動する数を絞り、予算と競合を抑える。
 */
export const CLAIMS_PER_RUN_LIMIT = 2;

/**
 * 実行なし(`no_ci`)の行を読み直す間隔。
 * 実行が遅れて作られた場合のための見直しなので、判定待ちより遅くする。
 */
export const NO_CI_RECHECK_INTERVAL_MS = 60 * 60_000;

/**
 * 実行を読めないという永続的な条件のまま、最初に見てからこの時間がたった判定待ちの行は`expired`にする。
 * 読めない条件は、次の4つである。
 * - 実行の多さ(`WorkflowRunsIncompleteError`)で、実行を読み切れない。
 * - 実行かPRを読む権限が無い(403、404)。
 * - リポジトリが対象から外れた(設定から外れた場合と、オーナーの照合に失敗した場合)。
 * - 読み取りの段階で、分類できない例外(サーバーの5xxを含む)が出た。
 * rate limitは、以降の読み取りを止めるだけで数えない。
 * 読めないまま判定を待ち続けても、人に知らせる手段が無いので、行を終わらせる。
 * 失敗の行と実行なしの行は、期限切れにしない。失敗の通知は、読めなくなっても残す。
 * 設定から外れたリポジトリの失敗と実行なしの行だけは、`superseded`にする。
 */
export const UNREADABLE_EXPIRES_AFTER_MS = 24 * 60 * 60_000;

/**
 * 1回の実行で、新しい読み取りを始めてよい経過時間。超えたら、残りは次の回に回す。
 * 予算を見るのは、PRの発見、行の判定の開始、失敗の確定の前である。
 * 実行の読み取りのページごとには見ない。`watch_main_ci`と同じく、1つの要求の列は途中で止めず、
 * 読み始めた行は読み切る。
 * ただし、失敗の確定(通知の登録とDiscord)は、1回の実行で最初の1件を予算を見ずに進める。
 * 予算切れが続いても、失敗の通知が飢えないためである。
 *
 * scriptのtimeout(600秒)との関係は次のとおりである。
 * - 1回の要求の上限は、ghの実行60秒、5xxの再送(待ち2秒と実行60秒)、rate limitの待ち120秒を足した約240秒。
 *   rate limitの待ちの後の再試行が再び拒まれたら、読み取りをやめる。
 * - 1行の判定は、PRの読み取り、実行の読み取り(最大3ページ)、PRの読み取りの順である。
 *   通常は数秒で終わり、予算の直前に始めた行でも、待ちが重ならなければ収まる。
 * - 失敗の確定には、Discordの待ち(最大30秒)がかかる。
 * - 予算は、この最悪の見積もりを足してもtimeoutに収まる長さにする。
 * rate limitの待ちが重なると、timeoutを超えうる。
 * そのときはjobが打ち切られるが、行ごとの更新は冪等なので、確定しなかった行は次の回に残る。
 */
export const RUN_BUDGET_MS = 120_000;

const DENIED_NEXT_ACTION =
  "PATのRepository accessに対象リポジトリが入っているか、Actions: Read-onlyが付いているかを確かめる";

/**
 * このリポジトリの権限の不足を知らせるnoticeの本文の接頭辞。
 * 自動解決は、種類とこの接頭辞で対象を選ぶ。末尾の区切りまで含めるので、
 * `acme/app: `は`acme/app-extra: `に当たらない。
 */
function repoNoticePrefix(owner: string, repo: string): string {
  return `${owner}/${repo}: `;
}

/** PRのCIの実行を読めないnoticeの本文。リポジトリごとに同じ文になる。 */
export function deniedNoticeMessage(owner: string, repo: string): string {
  return `${repoNoticePrefix(owner, repo)}PRのCIの実行をGitHubから読めません(403か404)。PATの権限が足りないか、リポジトリにアクセスできません。次の操作: ${DENIED_NEXT_ACTION}`;
}

/**
 * 巡回の対象にするかの判定を作る。
 * `isRepoAllowed`は、照合を通ったオーナー(`verifiedOwners`)に合うリポジトリを許す。
 * `isRepoConfigured`は、同じ規則を設定の`owners`の全体に当てる。
 * `factory_repo`は、どちらも常に許す。
 */
export function buildRepoGates(
  config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
  verifiedOwners: readonly FactoryOwner[],
): {
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  readonly isRepoConfigured: (owner: string, repo: string) => boolean;
} {
  const verified = {
    owners: [...verifiedOwners],
    repo_allowlist: config.repo_allowlist,
    factory_repo: config.factory_repo,
  };
  return {
    isRepoAllowed: (owner, repo) => isRepoAllowed(verified, owner, repo),
    isRepoConfigured: (owner, repo) => isRepoAllowed(config, owner, repo),
  };
}

/**
 * 回復だけを行うときの判定を作る。オーナーの照合をしないので、設定に合うリポジトリを許す。
 * 回復は、PRの状態とheadを読んで行を戻すだけで、失敗の通知もClaudeへの入力もしない。
 * 照合はGitHubの呼び出しと通知の追加を伴うため、監視を無効にしている間は行わない。
 * ただし、回復がPRを読めず403か404になると、権限の不足の通知(`pr_ci_check_denied`)は足しうる。
 * 判定が動かない間は、この通知は解決されない。
 */
export function buildRecoveryRepoGates(
  config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
): ReturnType<typeof buildRepoGates> {
  return buildRepoGates(config, config.owners);
}

/**
 * 失敗した行から、直す作業項目を起動する依存。渡さなければ起動しない。
 * リポジトリ名の綴りは、引く先で違う。作業項目を引く`hasActiveFix`と、起動の`claim`には、
 * PRが示すGitHubの正規の綴りを渡す。ほかの関数には、行と同じ小文字を渡す。
 */
export type PrCiClaimDeps = {
  /** 1つのPRで起動できるラウンドの上限。 */
  readonly maxRounds: number;
  /** この時刻より前に見つけた失敗は、起動の対象にしない。 */
  readonly enabledSince: Date;
  /** 起動の候補の行(`listClaimablePrCiChecks`)。 */
  readonly listCandidates: (since: Date, limit: number) => Promise<PrCiCheck[]>;
  readonly hasActiveFix: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<boolean>;
  readonly hasReview: (
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
  ) => Promise<boolean>;
  readonly listCommits: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<PrCommitMessages>;
  /** factory-fixスキルがCI回の節のマーカーを持つか。 */
  readonly hasSkillMarker: () => Promise<boolean>;
  readonly listJobs: (
    owner: string,
    repo: string,
    runId: number,
    headSha: string,
  ) => Promise<readonly WorkflowRunJob[]>;
  readonly budgetExceeded: () => Promise<boolean>;
  readonly mainCiFailed: (owner: string, repo: string) => Promise<boolean>;
  readonly countRounds: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<number>;
  /**
   * 保留の理由を書く。`null`で外す。書いたら`true`。
   * `expected`は、書く前の理由(`null`は保留なし)。いまの理由がこれと違う行は書き換えない。
   */
  readonly setHold: (
    id: number,
    reason: PrCiFixHoldReason | null,
    expected: string | null,
  ) => Promise<boolean>;
  /** 行を`fixing`に移して作業項目を挿入する(`claimPrCiCheckForFix`)。起動できなければ`null`。 */
  readonly claim: (input: ClaimPrCiCheckInput) => Promise<number | null>;
  /** 作業項目のpr_fixフローを起動する。 */
  readonly launch: (workItemId: number) => Promise<void>;
  /** 起動に失敗した作業項目を`failed`にする。 */
  readonly failFixItem: (workItemId: number, note: string) => Promise<void>;
  /** 起動したが記録できなかったフローのジョブを取り消す(`wmill.cancelJob`)。 */
  readonly cancelFlow: (jobId: string, reason: string) => Promise<void>;
};

export type PrCiWatchDeps = {
  /** 渡したときだけ、判定の後に失敗した行の起動を行う。 */
  readonly claim?: PrCiClaimDeps;
  readonly now: () => Date;
  readonly log: Logger;
  readonly instanceName: string;
  /** 許可リストと、照合を通ったオーナーに合うリポジトリか(`buildRepoGates`)。 */
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  /**
   * `isRepoAllowed`と同じ規則を、照合前の`owners`に当てた結果(`buildRepoGates`)。
   * 照合に失敗したオーナーの、許可リストに合うリポジトリは`true`になる。
   * `repo_allowlist`が空でないときは、許可リストの項目まで外れて初めて`false`になる。
   * `isRepoAllowed`が`false`でもこちらが`true`なら、照合が一時的に失敗しているだけかもしれない。
   */
  readonly isRepoConfigured: (owner: string, repo: string) => boolean;
  /** PRを作ったまま`pr_open`の作業項目。新しい順に、最大`TRACKED_PR_LIMIT`件。 */
  readonly listTrackedItems: () => Promise<FactoryWorkItemRef[]>;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
  readonly listRuns: (
    owner: string,
    repo: string,
    headSha: string,
    headRef: string,
    options: PrHeadWorkflowRunsOptions,
  ) => Promise<PrHeadWorkflowRuns>;
  /** そのPRの記録済みの行を、新しいheadから順に返す。 */
  readonly listRowsForPr: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<PrCiCheck[]>;
  readonly record: (record: NewPrCiCheck) => Promise<boolean>;
  readonly listPending: (limit: number) => Promise<PrCiCheck[]>;
  readonly listFailed: (limit: number) => Promise<PrCiCheck[]>;
  readonly listNoCi: (
    checkedBefore: Date,
    limit: number,
  ) => Promise<PrCiCheck[]>;
  /** 修正中(`fixing`)の行を、読み直していない順に返す。 */
  readonly listFixing: (limit: number) => Promise<PrCiCheck[]>;
  /** 直す作業項目に結ばれていない修正中の行を返す(`findOrphanFixingPrCiChecks`)。 */
  readonly listOrphanFixing: (limit: number) => Promise<PrCiCheck[]>;
  /** 直す作業項目の状態を返す。作業項目が無ければ`null`。 */
  readonly readFixItem: (workItemId: number) => Promise<FixItemState | null>;
  /**
   * 修正中の行を`failed`に戻す。この呼び出しで戻したら`true`。
   * `fixWorkItemId`を渡せば、その作業項目に結ばれた行だけを戻す。
   * `withoutFixWorkItem`を渡せば、作業項目に結ばれていない行だけを戻す。
   */
  readonly release: (
    id: number,
    options: {
      readonly holdReason?: PrCiFixHoldReason;
      readonly fixWorkItemId?: number;
      readonly withoutFixWorkItem?: boolean;
    },
  ) => Promise<boolean>;
  /** 条件付きの更新。この呼び出しで移したら`true`。 */
  readonly transition: (
    id: number,
    from: PrCiState,
    to: PrCiTransition,
  ) => Promise<boolean>;
  /** 状態を変えずに読み直した時刻を進める。 */
  readonly touch: (id: number) => Promise<boolean>;
  readonly markNotified: (id: number, reason: string) => Promise<boolean>;
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

export type PrCiWatchResult = {
  /** 巡回したFactoryのPRの数。 */
  readonly tracked: number;
  readonly recorded: number;
  readonly passed: number;
  readonly failed: number;
  readonly superseded: number;
  readonly expired: number;
  readonly no_ci: number;
  /** 回復で`fixing`から`failed`に戻した行の数。 */
  readonly released: number;
  /** 直す作業項目を起動した行の数。 */
  readonly claimed: number;
  /** 起動せず、保留の理由を書いた(変えた)行の数。 */
  readonly held: number;
  /** 実行かPRを読む権限が無かったリポジトリの数。 */
  readonly denied: number;
  /** 例外で処理できなかった数。 */
  readonly errors: number;
};

/** 監視を無効にしているときの結果。 */
export const PR_CI_WATCH_IDLE_RESULT: PrCiWatchResult = {
  tracked: 0,
  recorded: 0,
  passed: 0,
  failed: 0,
  superseded: 0,
  expired: 0,
  no_ci: 0,
  released: 0,
  claimed: 0,
  held: 0,
  denied: 0,
  errors: 0,
};

type Counters = {
  -readonly [K in keyof PrCiWatchResult]: PrCiWatchResult[K];
};

type WatchState = {
  /** rate limitに当たったら、今回はそれ以上GitHubを読まない。 */
  rateLimited: boolean;
  /** この回で、失敗の確定を始めた数。最初の1件は、予算を見ずに確定する。 */
  failedStarted: number;
  /** この回で、行を`fixing`に移して作業項目を作った数。フローの起動に失敗した分も数える。 */
  claimsStarted: number;
  /** この回に読んだPR。判定の最初に使う。判定の最後のheadの確認には使わず、必ず読み直す。 */
  readonly snapshots: Map<string, PullRequest>;
  /** 権限の不足を、この回に知らせたリポジトリ。 */
  readonly deniedRepos: Set<string>;
  /** 実行を読めたことを確かめて、権限の不足の通知を解決したリポジトリ。 */
  readonly readableRepos: Set<string>;
  /** 閉じたPRとして整理を終えたPR。 */
  readonly closedPrs: Set<string>;
  /**
   * この回の発見で、Factoryのブランチと確かめたPR。起動はこのPRの行に限る。
   * 発見は、同じリポジトリのheadで、ブランチが作業項目のものであることを確かめる。
   */
  readonly discoveredPrs: Set<string>;
  /** この回の回復で`failed`に戻した行のID。同じ回では起動しない。 */
  readonly releasedIds: Set<number>;
  /** 起動の判断で読んだ、回の中で変わらない事実。予算、スキルのマーカー、リポジトリごとのmainのCI。 */
  readonly claimFacts: Map<string, boolean>;
  /** この回にスキルを読めなかった失敗。以後の行は読み直さず、同じ失敗として扱う。 */
  skillMarkerFailure: SkillMarkerReadError | null;
  /** `skillMarkerFailure`を記録した後か。1回の実行で1回だけ記録する。 */
  skillMarkerFailureRecorded: boolean;
};

/** factory-fixスキルを読めなかった。対象のPRではなく、Factoryのリポジトリの読み取りの失敗である。 */
class SkillMarkerReadError extends Error {
  constructor(cause: unknown) {
    super(`skill marker could not be read: ${errorMessage(cause)}`, { cause });
    this.name = "SkillMarkerReadError";
  }
}

type Context = {
  readonly deps: PrCiWatchDeps;
  readonly now: Date;
  readonly counters: Counters;
  readonly state: WatchState;
};

function repoKey(ref: { owner: string; repo: string }): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

function prKey(ref: PullRequestRef): string {
  return `${repoKey(ref)}#${String(ref.number)}`;
}

function rowRef(row: PrCiCheck): PullRequestRef {
  return { owner: row.owner, repo: row.repo, number: row.pr_number };
}

function isDenied(err: unknown): boolean {
  return (
    err instanceof GitHubHttpError && (err.status === 403 || err.status === 404)
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 実行の開始から`RUN_BUDGET_MS`以上たったか。たったら、新しい読み取りは始めない。 */
function overBudget(context: Context): boolean {
  return context.deps.now().getTime() - context.now.getTime() >= RUN_BUDGET_MS;
}

async function recordFailureOf(
  context: Context,
  step: string,
  err: unknown,
): Promise<void> {
  context.counters.errors += 1;
  await context.deps.recordFailure(step, err);
}

/** 状態を変えずに、読み直した時刻を進める。進められなくても、他の行を止めない。 */
async function touchSafely(context: Context, row: PrCiCheck): Promise<void> {
  try {
    await context.deps.touch(row.id);
  } catch (err) {
    await recordFailureOf(context, `touch_row:${prKey(rowRef(row))}`, err);
  }
}

/** headのリポジトリがベースと同じか。forkと、削除されたforkは同じでない。 */
function isSameRepoHead(pr: PullRequest): boolean {
  return (
    pr.headRepoFullName !== null &&
    pr.headRepoFullName.toLowerCase() === pr.baseRepoFullName.toLowerCase()
  );
}

function oldestRunTime(runs: readonly WorkflowRun[]): Date | null {
  if (runs.length === 0) return null;
  return new Date(Math.min(...runs.map((run) => run.createdAt.getTime())));
}

/**
 * PRのCI監視を1回分実行する。
 * 例外は、PRごと、行ごとに捕まえて、他の処理を止めない。
 * 時刻は`deps.now()`を最初に1回だけ読み、workerの時計とGitHubの時計のずれは、確定を待つ時間の余裕で吸収する。
 */
export async function runPrCiWatch(
  deps: PrCiWatchDeps,
): Promise<PrCiWatchResult> {
  const context = newContext(deps);
  await discover(context);
  await recoverFixing(context);
  await recheck(context);
  await claimFixes(context);
  return context.counters;
}

/**
 * 回復だけを行う。監視を無効にしている間も、修正中の行を放置しないために使う。
 * 発見も判定も失敗の通知もしない。作業項目の起動もしない。
 * 権限の不足(403、404)で読めないときだけ、`pr_ci_check_denied`の通知を足しうる。解決は判定が行う。
 * 戻す行のPRが閉じていたときだけ、閉じたPRの整理(`closePr`)を行う。失敗のnoticeの解決と、
 * そのPRの未完了の行を`superseded`にすることを含む。
 */
export async function runPrCiRecovery(
  deps: PrCiWatchDeps,
): Promise<PrCiWatchResult> {
  const context = newContext(deps);
  await recoverFixing(context);
  return context.counters;
}

function newContext(deps: PrCiWatchDeps): Context {
  return {
    deps,
    now: deps.now(),
    counters: { ...PR_CI_WATCH_IDLE_RESULT },
    state: {
      rateLimited: false,
      failedStarted: 0,
      claimsStarted: 0,
      snapshots: new Map(),
      deniedRepos: new Set(),
      readableRepos: new Set(),
      closedPrs: new Set(),
      discoveredPrs: new Set(),
      releasedIds: new Set(),
      claimFacts: new Map(),
      skillMarkerFailure: null,
      skillMarkerFailureRecorded: false,
    },
  };
}

// ---------------------------------------------------------------------------
// 読み取りの失敗
// ---------------------------------------------------------------------------

/** 読み取りの失敗のうち、行の扱いが決まっているもの。 */
type ReadFailure = "rate_limited" | "denied" | "incomplete";

/**
 * GitHubの読み取りの失敗を、扱いが決まっているものに分ける。決まっていない失敗は`null`を返す。
 * rate limitは、以降のGitHubの読み取りを止める。
 * 権限の不足(403、404)は、リポジトリごとに1回だけnoticeにする。
 */
async function absorbReadError(
  context: Context,
  ref: PullRequestRef,
  err: unknown,
): Promise<ReadFailure | null> {
  const { deps, state } = context;
  if (err instanceof GitHubRateLimitError) {
    state.rateLimited = true;
    deps.log.warn("pr ci reading stopped by the rate limit", {
      repo: repoKey(ref),
      error: errorMessage(err),
    });
    return "rate_limited";
  }
  if (isDenied(err)) {
    await noteDenied(context, ref, err);
    return "denied";
  }
  if (err instanceof WorkflowRunsIncompleteError) {
    deps.log.warn("pr ci runs are not usable", {
      repo: repoKey(ref),
      pr: ref.number,
      error: errorMessage(err),
    });
    return "incomplete";
  }
  return null;
}

async function noteDenied(
  context: Context,
  ref: PullRequestRef,
  err: unknown,
): Promise<void> {
  const { deps, state, counters } = context;
  const key = repoKey(ref);
  deps.log.warn("pr ci is not readable", {
    repo: key,
    pr: ref.number,
    error: errorMessage(err),
  });
  if (state.deniedRepos.has(key)) return;
  state.deniedRepos.add(key);
  counters.denied += 1;
  try {
    await deps.addNotice({
      kind: PR_CI_CHECK_DENIED_KIND,
      message: deniedNoticeMessage(ref.owner, ref.repo),
    });
  } catch (noticeErr) {
    await recordFailureOf(context, `denied_notice:${key}`, noticeErr);
  }
}

/** 実行を読めたら、そのリポジトリの権限の不足の通知を、この回に1度だけ解決する。 */
async function noteReadable(
  context: Context,
  ref: PullRequestRef,
): Promise<void> {
  const { deps, state } = context;
  const key = repoKey(ref);
  if (state.readableRepos.has(key)) return;
  await deps.resolveNotices(
    PR_CI_CHECK_DENIED_KIND,
    repoNoticePrefix(ref.owner, ref.repo),
    PR_CI_RESOLVED_BY,
  );
  state.readableRepos.add(key);
}

// ---------------------------------------------------------------------------
// 発見
// ---------------------------------------------------------------------------

/** PRを読み、この回の読み取りとして覚える。 */
async function readPr(
  context: Context,
  ref: PullRequestRef,
): Promise<PullRequest> {
  const pr = await context.deps.getPr(ref.owner, ref.repo, ref.number);
  context.state.snapshots.set(prKey(ref), pr);
  return pr;
}

/** この回に読んだPRがあればそれを、無ければ読んで返す。 */
async function snapshotOf(
  context: Context,
  ref: PullRequestRef,
): Promise<PullRequest> {
  return context.state.snapshots.get(prKey(ref)) ?? readPr(context, ref);
}

/**
 * Factoryが作ったPRの今のheadを記録し、古いheadの行を整理する。
 * 作業項目の`pr_url`から引いたPRだけを対象にし、許可リストに合うリポジトリだけを読む。
 */
async function discover(context: Context): Promise<void> {
  const { deps, state, counters } = context;
  let items: FactoryWorkItemRef[];
  try {
    items = await deps.listTrackedItems();
  } catch (err) {
    await recordFailureOf(context, "list_tracked", err);
    return;
  }
  for (const item of items) {
    if (state.rateLimited || overBudget(context)) break;
    const ref = item.prUrl === null ? null : parsePullRequestUrl(item.prUrl);
    if (ref === null || !deps.isRepoAllowed(ref.owner, ref.repo)) continue;
    counters.tracked += 1;
    try {
      await discoverPr(context, item, ref);
    } catch (err) {
      if ((await absorbReadError(context, ref, err)) === null) {
        await recordFailureOf(context, `discover_pr:${prKey(ref)}`, err);
      }
    }
  }
}

async function discoverPr(
  context: Context,
  item: FactoryWorkItemRef,
  ref: PullRequestRef,
): Promise<void> {
  const { deps, counters } = context;
  // `parsePullRequestUrl`は先頭が`.`のリポジトリ名も通すが、DBへの記録は通さない。
  // 例外にすると毎回失敗として記録されるので、読まずに飛ばす。
  try {
    assertGitHubName(ref.owner);
    assertGitHubName(ref.repo);
  } catch {
    deps.log.warn("pr ci skipped a repository whose name is not supported", {
      repo: repoKey(ref),
      pr: ref.number,
    });
    return;
  }
  const pr = await readPr(context, ref);
  if (pr.state === "closed") {
    await closePr(context, ref);
    return;
  }
  // 下書きと、forkのPRと、Factoryのものでないブランチには、行を作らない。
  // 下書きでも、Factoryのブランチなら起動の判断の対象にする(保留の理由を書くため)。
  if (!isSameRepoHead(pr) || !isFactoryPrBranch(pr.headRef, ref, item)) return;
  context.state.discoveredPrs.add(prKey(ref));
  if (pr.draft) return;
  const rows = await deps.listRowsForPr(ref.owner, ref.repo, ref.number);
  const plan = planPrHead(
    pr.headSha,
    rows.map((row) => ({
      id: row.id,
      headSha: row.head_sha,
      state: row.state,
    })),
  );
  // 新しいheadの行を先に記録する。旧行の整理が途中で止まっても、次の回に同じ計画で整理し直せる。
  if (plan.record) {
    const inserted = await deps.record({
      owner: ref.owner,
      repo: ref.repo,
      pr_number: ref.number,
      head_sha: pr.headSha,
      work_item_id: item.id,
      run_created_at: null,
    });
    if (inserted) counters.recorded += 1;
  }
  for (const old of plan.supersede) {
    const moved = await deps.transition(old.id, old.from, {
      state: "superseded",
    });
    if (moved) counters.superseded += 1;
  }
  if (plan.reopenId !== null) {
    await deps.transition(plan.reopenId, "superseded", {
      state: "pending",
      reopen: true,
    });
  }
}

/**
 * 閉じた(マージされた)PRの行を整理する。判定待ち、失敗、修正中、実行なしの行を`superseded`にし、
 * そのPRの失敗のnoticeを解決する。通ったPRなどの終わった行は、記録として残す。
 * 解決は冪等なので、行の更新より先に行う。更新に失敗した回は、次の回にやり直せる。
 * 行が1件も無いPRには何もしない。
 */
async function closePr(context: Context, ref: PullRequestRef): Promise<void> {
  const { deps, state, counters } = context;
  const key = prKey(ref);
  if (state.closedPrs.has(key)) return;
  const rows = await deps.listRowsForPr(ref.owner, ref.repo, ref.number);
  if (rows.length > 0) {
    await deps.resolveNotices(
      PR_CI_FAILED_KIND,
      prCiNoticePrefix(ref.owner, ref.repo, ref.number),
      PR_CI_RESOLVED_BY,
    );
    for (const row of rows) {
      if (
        row.state !== "pending" &&
        row.state !== "failed" &&
        row.state !== "no_ci" &&
        row.state !== "fixing"
      ) {
        continue;
      }
      const moved = await deps.transition(row.id, row.state, {
        state: "superseded",
      });
      if (moved) counters.superseded += 1;
    }
  }
  state.closedPrs.add(key);
}

// ---------------------------------------------------------------------------
// 回復
// ---------------------------------------------------------------------------

/**
 * 回復の対象の行。修正中の行に、直す作業項目に結ばれていない行を足して、重複を除く。
 * 作業項目に結ばれていない行は、`updated_at`から10分以上たったもの(`listOrphanFixing`)に限る。
 * 起動の直後の行を、起動の途中として戻さないためである。
 */
function mergeFixingRows(
  fixing: readonly PrCiCheck[],
  orphans: readonly PrCiCheck[],
): PrCiCheck[] {
  const orphanIds = new Set(orphans.map((row) => row.id));
  const seen = new Set<number>();
  const rows: PrCiCheck[] = [];
  for (const row of [...fixing, ...orphans]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.fix_work_item_id === null && !orphanIds.has(row.id)) continue;
    rows.push(row);
  }
  return rows;
}

/**
 * 直す作業項目が終わった修正中の行を、`failed`か`superseded`に戻す。
 * 監視の設定に依らず、起動もしない。行き先は`decideFixingRecovery`が決める。
 * 作業項目の状態を先に読み、その後でPRのheadを読む。
 * 先にPRのheadを読むと、読んでいる間に作業項目がpushした場合に、古いheadの行を`failed`に戻してしまうためである。
 * 例外は行ごとに捕まえ、読み直した時刻を進めて、後ろの行が飢えないようにする。
 */
async function recoverFixing(context: Context): Promise<void> {
  const { deps } = context;
  let rows: PrCiCheck[];
  try {
    const fixing = await deps.listFixing(FIXING_BATCH_LIMIT);
    const orphans = await deps.listOrphanFixing(ORPHAN_FIXING_BATCH_LIMIT);
    rows = mergeFixingRows(fixing, orphans);
  } catch (err) {
    await recordFailureOf(context, "list_fixing", err);
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (overBudget(context)) {
      deps.log.warn("pr ci recovery stopped by the time budget", {
        left: rows.length - index,
      });
      break;
    }
    try {
      await recoverRow(context, row);
    } catch (err) {
      await recordFailureOf(
        context,
        `recover_fixing:${prKey(rowRef(row))}`,
        err,
      );
      await touchSafely(context, row);
    }
  }
}

async function recoverRow(context: Context, row: PrCiCheck): Promise<void> {
  const { deps, counters } = context;
  const ref = rowRef(row);
  const item =
    row.fix_work_item_id === null
      ? null
      : await deps.readFixItem(row.fix_work_item_id);
  const decision = decideFixingRecovery(item, context.now);
  if (decision.kind === "keep") {
    await touchSafely(context, row);
    return;
  }
  if (decision.kind === "pushed") {
    await supersede(context, row);
    return;
  }
  const head = await readFixingHead(context, row, ref);
  if (head === "unread") {
    await touchSafely(context, row);
    return;
  }
  if (head === "closed") {
    await closePr(context, ref);
    return;
  }
  if (head === "moved") {
    await supersede(context, row);
    return;
  }
  const released = await deps.release(row.id, {
    ...(decision.hold === null ? {} : { holdReason: decision.hold }),
    ...(row.fix_work_item_id === null
      ? { withoutFixWorkItem: true }
      : { fixWorkItemId: row.fix_work_item_id }),
  });
  if (!released) return;
  counters.released += 1;
  context.state.releasedIds.add(row.id);
  deps.log.info("pr ci fixing row returned to failed", {
    repo: repoKey(row),
    pr: row.pr_number,
    sha: row.head_sha,
    hold: decision.hold,
  });
}

/** 修正中の行のheadが、PRの今のheadかを、PRを読み直して調べる。 */
type FixingHead =
  | "same"
  | "moved"
  | "closed"
  /** 今回は読めなかった(rate limitか権限の不足)。次の回に回す。 */
  | "unread";

/**
 * 許可リストに合わないリポジトリは読まない。
 * - 設定から外れたリポジトリ(`isRepoConfigured`が`false`)は、headが動いていても`same`として戻す。
 *   戻した`failed`の行を判定が`superseded`にするのは、最初に見てから24時間たった行だけで、
 *   それより新しい行は読み直した時刻を進めるだけである。
 * - 設定には合うが照合を通っていないリポジトリは、照合が一時的に失敗しているだけかもしれない。
 *   headが動いたか分からないまま戻すと、古いheadの行を直し直しうるので、`unread`にして次の回に回す。
 */
async function readFixingHead(
  context: Context,
  row: PrCiCheck,
  ref: PullRequestRef,
): Promise<FixingHead> {
  const { deps, state } = context;
  if (!deps.isRepoAllowed(ref.owner, ref.repo)) {
    return deps.isRepoConfigured(ref.owner, ref.repo) ? "unread" : "same";
  }
  if (state.rateLimited) return "unread";
  try {
    const pr = await readPr(context, ref);
    if (pr.state === "closed") return "closed";
    return pr.headSha === row.head_sha ? "same" : "moved";
  } catch (err) {
    if ((await absorbReadError(context, ref, err)) === null) throw err;
    return "unread";
  }
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 判定待ち、失敗、実行なしの行を読み直して確定する。 */
async function recheck(context: Context): Promise<void> {
  const { deps } = context;
  let rows: PrCiCheck[];
  try {
    const pending = await deps.listPending(PENDING_BATCH_LIMIT);
    const failed = await deps.listFailed(FAILED_BATCH_LIMIT);
    const noCi = await deps.listNoCi(
      new Date(context.now.getTime() - NO_CI_RECHECK_INTERVAL_MS),
      NO_CI_BATCH_LIMIT,
    );
    rows = [...pending, ...failed, ...noCi];
  } catch (err) {
    await recordFailureOf(context, "list_rows", err);
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (overBudget(context)) {
      deps.log.warn("pr ci judging stopped by the time budget", {
        left: rows.length - index,
      });
      break;
    }
    await judgeRowSafely(context, row);
  }
}

/**
 * 1行を判定する。例外は捕まえて記録し、読み直した時刻を進める。
 * 進めないと、同じ行が巡回の先頭に残り続け、後ろの行が読み直されない。
 */
async function judgeRowSafely(context: Context, row: PrCiCheck): Promise<void> {
  try {
    await judgeRow(context, row);
  } catch (err) {
    await recordFailureOf(context, `judge_pr:${prKey(rowRef(row))}`, err);
    await touchSafely(context, row);
  }
}

/**
 * 読み取りの段階で分類できない例外が出た行を扱う。
 * 例外が続いても判定待ちの行が残り続けないよう、読めない行と同じ期限で終わらせる。
 * 終わらせない行は、読み直した時刻だけを進める。
 * 通知の登録など、読んだ後の段階の例外には使わない。実行を読めた行を、読めない行として終わらせないためである。
 */
async function settleReadException(
  context: Context,
  row: PrCiCheck,
  err: unknown,
): Promise<void> {
  await recordFailureOf(context, `judge_pr:${prKey(rowRef(row))}`, err);
  let expired = false;
  try {
    expired = await expireStalePending(context, row);
  } catch (expireErr) {
    await recordFailureOf(
      context,
      `expire_pr:${prKey(rowRef(row))}`,
      expireErr,
    );
  }
  if (!expired) await touchSafely(context, row);
}

/** 実行を読んだ結果。 */
type RowRead =
  | {
      readonly kind: "runs";
      readonly runs: WorkflowRun[];
      readonly headIsCurrent: boolean;
    }
  /** PRが閉じている。 */
  | { readonly kind: "closed" }
  /** 行のheadが、読む前から、PRの今のheadでない。 */
  | { readonly kind: "stale" }
  /** 永続的な条件で読めない。 */
  | { readonly kind: "unreadable" }
  /** 今回は読めなかった(rate limit)。何も決めず、次の回に回す。 */
  | { readonly kind: "skip" };

async function judgeRow(context: Context, row: PrCiCheck): Promise<void> {
  const { deps, state } = context;
  const ref = rowRef(row);
  if (state.closedPrs.has(prKey(ref))) return;
  if (!deps.isRepoAllowed(ref.owner, ref.repo)) {
    // 設定から外れたときだけ、恒久的に対象外とみなす。オーナーの照合の失敗は、次の回に戻りうる。
    await settleUnreadable(
      context,
      row,
      !deps.isRepoConfigured(ref.owner, ref.repo),
    );
    return;
  }
  if (state.rateLimited) return;
  let read: RowRead;
  try {
    read = await readRow(context, row, ref);
  } catch (err) {
    await settleReadException(context, row, err);
    return;
  }
  switch (read.kind) {
    case "skip":
      return;
    case "closed":
      await closePr(context, ref);
      return;
    case "stale":
      await supersede(context, row);
      return;
    case "unreadable":
      await settleUnreadable(context, row, false);
      return;
    case "runs":
      // 読んだ後の段階なので、例外は`judgeRowSafely`に任せる(読めない行として終わらせない)。
      await noteReadable(context, ref);
      await applyRuns(context, row, ref, read.runs, read.headIsCurrent);
  }
}

/**
 * 行のheadの実行を読む。順序は、PRを読む、実行を読む、PRのheadを読み直す、である。
 * 最初のPRの読み取りは、ブランチ名とベースのリポジトリのIDを知るためで、この回の発見で読んだものを使える。
 * 行のheadが既に今のheadでなければ、実行を読まずに終える。
 * 後のPRのheadの読み取りは、実行を読んだ後に取り、`headIsCurrent`にする。
 */
async function readRow(
  context: Context,
  row: PrCiCheck,
  ref: PullRequestRef,
): Promise<RowRead> {
  const { deps } = context;
  try {
    const first = await snapshotOf(context, ref);
    if (first.state === "closed") return { kind: "closed" };
    if (first.headSha !== row.head_sha) return { kind: "stale" };
    if (first.baseRepoId === null) {
      deps.log.warn("pr ci base repository id is missing", {
        repo: repoKey(ref),
        pr: ref.number,
      });
      return { kind: "unreadable" };
    }
    const result = await deps.listRuns(
      ref.owner,
      ref.repo,
      row.head_sha,
      first.headRef,
      { baseRepoId: first.baseRepoId, prNumber: ref.number },
    );
    if (
      result.droppedOtherRepository > 0 ||
      result.droppedOtherPullRequest > 0
    ) {
      deps.log.info("pr ci runs were dropped", {
        repo: repoKey(ref),
        pr: ref.number,
        other_repository: result.droppedOtherRepository,
        other_pull_request: result.droppedOtherPullRequest,
      });
    }
    const latest = await readPr(context, ref);
    if (latest.state === "closed") return { kind: "closed" };
    return {
      kind: "runs",
      runs: result.runs,
      headIsCurrent: latest.headSha === row.head_sha,
    };
  } catch (err) {
    const failure = await absorbReadError(context, ref, err);
    if (failure === null) throw err;
    return failure === "rate_limited"
      ? { kind: "skip" }
      : { kind: "unreadable" };
  }
}

/** 読んだ実行から、行の行き先を決めて適用する。 */
async function applyRuns(
  context: Context,
  row: PrCiCheck,
  ref: PullRequestRef,
  runs: readonly WorkflowRun[],
  headIsCurrent: boolean,
): Promise<void> {
  const { now } = context;
  const oldest = oldestRunTime(runs);
  const extra = oldest === null ? {} : { runCreatedAt: oldest };
  if (row.state === "failed") {
    const outcome = decidePrCiFailed({ runs, now, headIsCurrent });
    if (outcome === "passed") await settlePassed(context, row, ref, extra);
    else if (outcome === "superseded") await supersede(context, row);
    else await touchSafely(context, row);
    return;
  }
  // 実行なしの行は、実行が現れるまで読み直す。現れていなければ状態を変えない。
  if (row.state === "no_ci" && runs.length === 0) {
    await touchSafely(context, row);
    return;
  }
  const outcome = decidePrCiPending({
    runs,
    firstSeenAt: row.first_seen_at,
    now,
    headIsCurrent,
  });
  switch (outcome) {
    case "passed":
      await settlePassed(context, row, ref, extra);
      return;
    case "failed":
      await settleFailed(context, row, ref, runs, extra);
      return;
    case "superseded":
      await supersede(context, row);
      return;
    case "no_ci":
      await moveWithoutVerdict(context, row, "no_ci", extra);
      return;
    case "expired":
      await moveWithoutVerdict(context, row, "expired", extra);
      return;
    case "pending":
      await moveWithoutVerdict(context, row, "pending", extra);
  }
}

/**
 * 通知を伴わない移行を適用する。
 * 実行なしの行は、期限切れにも実行なしにもせず、実行が現れていれば判定待ちに戻す。
 * 判定待ちの行が判定待ちのままなら、状態を変えずに読み直した時刻を進める。
 */
async function moveWithoutVerdict(
  context: Context,
  row: PrCiCheck,
  to: "pending" | "no_ci" | "expired",
  extra: { runCreatedAt?: Date },
): Promise<void> {
  const { deps, counters } = context;
  const target = row.state === "no_ci" && to === "expired" ? "pending" : to;
  if (target === row.state) {
    await touchSafely(context, row);
    return;
  }
  // 今のheadに失敗が無いまま終わるので、旧headの失敗のnoticeは古くなっている。
  // 解決は冪等なので、行の更新より先に行う。
  if (target === "expired" || target === "no_ci") {
    await deps.resolveNotices(
      PR_CI_FAILED_KIND,
      prCiNoticePrefix(row.owner, row.repo, row.pr_number),
      PR_CI_RESOLVED_BY,
    );
  }
  const moved = await deps.transition(row.id, row.state, {
    state: target,
    ...extra,
  });
  if (!moved) return;
  if (target === "expired") {
    counters.expired += 1;
    deps.log.info("pr ci row expired", {
      repo: repoKey(row),
      pr: row.pr_number,
      sha: row.head_sha,
    });
  }
  if (target === "no_ci") counters.no_ci += 1;
}

async function supersede(context: Context, row: PrCiCheck): Promise<void> {
  const moved = await context.deps.transition(row.id, row.state, {
    state: "superseded",
  });
  if (moved) context.counters.superseded += 1;
}

/**
 * 最初に見てから`UNREADABLE_EXPIRES_AFTER_MS`たった判定待ちの行を、通知せずに`expired`にしてログに残す。
 * 移したら`true`を返す。判定待ちでない行と、期限前の行は何もせず`false`を返す。
 */
async function expireStalePending(
  context: Context,
  row: PrCiCheck,
): Promise<boolean> {
  const { deps, counters, now } = context;
  if (
    row.state !== "pending" ||
    now.getTime() - row.first_seen_at.getTime() < UNREADABLE_EXPIRES_AFTER_MS
  ) {
    return false;
  }
  const moved = await deps.transition(row.id, "pending", { state: "expired" });
  if (moved) {
    counters.expired += 1;
    deps.log.warn("pr ci row expired because its runs were unreadable", {
      repo: repoKey(row),
      pr: row.pr_number,
      sha: row.head_sha,
    });
  }
  return true;
}

/**
 * 読めない行を扱う。`removed`は、リポジトリが設定から外れた(`isRepoConfigured`が`false`)ことを表す。
 * `repo_allowlist`が空でないときは、許可リストの項目まで外れて初めて外れたと数える。
 * オーナーの照合に失敗しているだけの回は含まない。
 * 最初に見てから`UNREADABLE_EXPIRES_AFTER_MS`たつと、判定待ちの行は、どちらの条件でも通知せずに`expired`にする。
 * 失敗と実行なしの行は、`removed`のときだけ`superseded`にし、そのPRの失敗のnoticeを解決する。
 * 設定から外れたリポジトリの失敗は、人が確かめる手段が無いためである。
 * 権限の不足(403、404)や実行の多さで読めない回は、失敗の行を`superseded`にせず、noticeも解決しない。
 * 一時的な不通で、今も続く失敗の通知を消さないためである。
 * 解決は冪等なので、行の更新より先に行う。
 * 期限の前と、`superseded`にしない行は、読み直した時刻だけを進める。
 */
async function settleUnreadable(
  context: Context,
  row: PrCiCheck,
  removed: boolean,
): Promise<void> {
  const { deps, now } = context;
  if (await expireStalePending(context, row)) return;
  if (
    removed &&
    row.state !== "pending" &&
    now.getTime() - row.first_seen_at.getTime() >= UNREADABLE_EXPIRES_AFTER_MS
  ) {
    await deps.resolveNotices(
      PR_CI_FAILED_KIND,
      prCiNoticePrefix(row.owner, row.repo, row.pr_number),
      PR_CI_RESOLVED_BY,
    );
    await supersede(context, row);
    deps.log.warn("pr ci row superseded because its repository was removed", {
      repo: repoKey(row),
      pr: row.pr_number,
      sha: row.head_sha,
    });
    return;
  }
  await touchSafely(context, row);
}

async function settlePassed(
  context: Context,
  row: PrCiCheck,
  ref: PullRequestRef,
  extra: { runCreatedAt?: Date },
): Promise<void> {
  const { deps, counters } = context;
  // 解決は冪等なので、状態の更新より先に行う。更新に失敗した回は、次の回に解決をやり直せる。
  await deps.resolveNotices(
    PR_CI_FAILED_KIND,
    prCiNoticePrefix(ref.owner, ref.repo, ref.number),
    PR_CI_RESOLVED_BY,
  );
  const moved = await deps.transition(row.id, row.state, {
    state: "passed",
    ...extra,
  });
  if (moved) counters.passed += 1;
}

async function settleFailed(
  context: Context,
  row: PrCiCheck,
  ref: PullRequestRef,
  runs: readonly WorkflowRun[],
  extra: { runCreatedAt?: Date },
): Promise<void> {
  const { deps, counters, state } = context;
  // 通知の登録とDiscordは、予算の後に始めない。状態を変えずに、次の回に回す。
  // ただし、1回の実行で最初の1件は予算を見ずに確定する。予算切れが続いても、失敗の通知が飢えないためである。
  const first = state.failedStarted === 0;
  state.failedStarted += 1;
  if (!first && overBudget(context)) {
    deps.log.warn("pr ci failure left to the next run by the time budget", {
      repo: repoKey(ref),
      pr: ref.number,
      sha: row.head_sha,
    });
    return;
  }
  const reason = classifyPrCiReason(runs);
  const link = prCiFailureLink({
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.number,
    runs,
  });
  const message = prCiFailedNoticeMessage({
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.number,
    headSha: row.head_sha,
    link,
    reason,
  });
  // 通知を先に登録する。状態の更新が先に成功して通知が失敗すると、通知が永久に出ないため。
  const noticeId = await deps.addNotice({ kind: PR_CI_FAILED_KIND, message });
  if (noticeId !== null) {
    const sent = await deps.notify({
      kind: "needs_human",
      instance_name: deps.instanceName,
      owner: ref.owner,
      repo: ref.repo,
      url: pullRequestPageUrl(ref.owner, ref.repo, ref.number),
      reason,
      target: { kind: "pr", number: ref.number },
      next_action: prCiNextAction(reason),
    });
    // 通知(notice)は残るので、行は`failed`に移す。Discordに届かなかったことだけを記録する。
    if (sent.status === "not_sent") {
      deps.log.warn("pr ci failure notice was not delivered", {
        repo: repoKey(ref),
        pr: ref.number,
        sha: row.head_sha,
        notice_id: noticeId,
        reason: sent.reason,
      });
    }
  }
  const moved = await deps.transition(row.id, row.state, {
    state: "failed",
    summary: prCiSummary(runs),
    ...extra,
  });
  if (!moved) return;
  await deps.markNotified(row.id, reason);
  counters.failed += 1;
  deps.log.warn("pr ci failed", {
    repo: repoKey(ref),
    pr: ref.number,
    sha: row.head_sha,
    reason,
  });
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

/** 起動の判断で、回の中で変わらない事実を、1回だけ読んで覚える。読めなければ覚えずに例外を伝える。 */
async function readFactOnce(
  context: Context,
  key: string,
  read: () => Promise<boolean>,
): Promise<boolean> {
  const known = context.state.claimFacts.get(key);
  if (known !== undefined) return known;
  const value = await read();
  context.state.claimFacts.set(key, value);
  return value;
}

/** PRが示す`owner/repo`を、GitHubの正規の綴りの2つに分ける。形が違えば`null`。 */
function canonicalRepoNames(
  pr: PullRequest,
): { owner: string; repo: string } | null {
  const parts = pr.baseRepoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) return null;
  return { owner, repo };
}

/**
 * 失敗した行のうち、直す作業項目を起動してよいものを起動する。
 * 候補は、失敗の行で、保留がないか一時的な保留で、`enabledSince`以後に見つけたものである。
 * 次の行は起動しない。
 * - この回の発見で読んでいないPRの行。発見はFactoryのブランチと確かめる。
 * - この回の回復で戻した行。戻した直後の状態で、すぐ起動し直さないためである。
 * 1回の実行で作業項目を作るのは`CLAIMS_PER_RUN_LIMIT`件までで、予算を過ぎたら新しい行を始めない。
 * フローの起動に失敗した分も数える。起動の失敗が続いても、1回の実行で作業項目を作り続けないためである。
 * 保留の理由は、判断のたびに見直す。一時的な保留が解けた行は、保留を外してその回のうちに判断を続ける。
 */
async function claimFixes(context: Context): Promise<void> {
  const { deps, state } = context;
  const claim = deps.claim;
  if (claim === undefined) return;
  let rows: PrCiCheck[];
  try {
    rows = await claim.listCandidates(claim.enabledSince, CLAIM_BATCH_LIMIT);
  } catch (err) {
    await recordFailureOf(context, "list_claimable", err);
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (state.rateLimited) break;
    if (state.claimsStarted >= CLAIMS_PER_RUN_LIMIT) break;
    if (overBudget(context)) {
      deps.log.warn("pr ci claim stopped by the time budget", {
        left: rows.length - index,
      });
      break;
    }
    const ref = rowRef(row);
    if (
      state.releasedIds.has(row.id) ||
      !state.discoveredPrs.has(prKey(ref)) ||
      !deps.isRepoAllowed(ref.owner, ref.repo)
    ) {
      // 候補の一覧の先頭に居座って、後ろの行を飢えさせないために、読み直した時刻を進める。
      await touchSafely(context, row);
      continue;
    }
    try {
      await claimRow(context, claim, row, ref);
    } catch (err) {
      await absorbClaimError(context, ref, err);
      await touchSafely(context, row);
    }
  }
}

/**
 * 起動の判断の読み取りの失敗を扱う。
 * スキルの読み取りの失敗は、対象のPRの権限の不足ではないので、PRのリポジトリのnoticeにせず、
 * 手順名`skill_marker`で1回だけ記録する。rate limitだけは、以後の読み取りを止める。
 */
async function absorbClaimError(
  context: Context,
  ref: PullRequestRef,
  err: unknown,
): Promise<void> {
  const { state } = context;
  if (err instanceof SkillMarkerReadError) {
    if (err.cause instanceof GitHubRateLimitError) {
      await absorbReadError(context, ref, err.cause);
      return;
    }
    if (!state.skillMarkerFailureRecorded) {
      state.skillMarkerFailureRecorded = true;
      await recordFailureOf(context, "skill_marker", err);
    }
    return;
  }
  if ((await absorbReadError(context, ref, err)) === null) {
    await recordFailureOf(context, `claim_fix:${prKey(ref)}`, err);
  }
}

/** スキルのマーカーを、この回で1回だけ読む。読めなければ、以後の行も同じ失敗にする。 */
async function readSkillMarker(
  context: Context,
  claim: PrCiClaimDeps,
): Promise<boolean> {
  const { state } = context;
  if (state.skillMarkerFailure !== null) throw state.skillMarkerFailure;
  try {
    return await readFactOnce(context, "skill_marker", claim.hasSkillMarker);
  } catch (err) {
    state.skillMarkerFailure = new SkillMarkerReadError(err);
    throw state.skillMarkerFailure;
  }
}

/** 起動の判断が読む事実を、この行について組む。回の中で変わらない事実は、回の間で共有する。 */
function claimReaders(
  context: Context,
  claim: PrCiClaimDeps,
  row: PrCiCheck,
  ref: PullRequestRef,
  names: { owner: string; repo: string },
): FixClaimReaders {
  const { deps } = context;
  const repo = repoKey(ref);
  return {
    hasActiveFix: () =>
      claim.hasActiveFix(names.owner, names.repo, row.pr_number),
    hasReview: () =>
      claim.hasReview(row.owner, row.repo, row.pr_number, row.head_sha),
    readPr: () => readPr(context, ref),
    readCommits: () => claim.listCommits(row.owner, row.repo, row.pr_number),
    hasSkillMarker: () => readSkillMarker(context, claim),
    classify: async (pr) => {
      if (pr.baseRepoId === null) return "unreadable";
      const found = await deps.listRuns(
        row.owner,
        row.repo,
        row.head_sha,
        pr.headRef,
        { baseRepoId: pr.baseRepoId, prNumber: row.pr_number },
      );
      return classifyHeadFailure(found.runs, (runId) =>
        claim.listJobs(row.owner, row.repo, runId, row.head_sha),
      );
    },
    budgetExceeded: () => readFactOnce(context, "budget", claim.budgetExceeded),
    mainCiFailed: () =>
      readFactOnce(context, `main_ci:${repo}`, () =>
        claim.mainCiFailed(row.owner, row.repo),
      ),
    countRounds: () => claim.countRounds(row.owner, row.repo, row.pr_number),
  };
}

/**
 * 起動したがジョブIDを記録できなかったフローを取り消す。取り消せたら`true`。
 * 取り消せなかったときは、人が気づけるように失敗を記録して`false`を返す。
 */
async function cancelStartedFlow(
  context: Context,
  claim: PrCiClaimDeps,
  row: PrCiCheck,
  workItemId: number,
  err: PrFixFlowJobIdRecordError,
): Promise<boolean> {
  const { deps } = context;
  try {
    await claim.cancelFlow(
      err.flowJobId,
      "pr ci fix: the job id of the flow was not recorded",
    );
    return true;
  } catch (cancelErr) {
    deps.log.warn("pr ci fix flow started without a recorded job id", {
      repo: repoKey(row),
      pr: row.pr_number,
      work_item_id: workItemId,
      flow_job_id: err.flowJobId,
      error: errorMessage(err.cause),
      cancel_error: errorMessage(cancelErr),
    });
    await recordFailureOf(context, "record_fix_job_id", err);
    return false;
  }
}

async function claimRow(
  context: Context,
  claim: PrCiClaimDeps,
  row: PrCiCheck,
  ref: PullRequestRef,
): Promise<void> {
  const { deps, counters, state } = context;
  const snapshot = state.snapshots.get(prKey(ref));
  const names = snapshot === undefined ? null : canonicalRepoNames(snapshot);
  if (names === null) {
    deps.log.warn(
      "pr ci claim skipped a pull request without a repository name",
      {
        repo: repoKey(ref),
        pr: ref.number,
      },
    );
    await touchSafely(context, row);
    return;
  }
  const decision = await decideFixClaim({
    row,
    instanceName: deps.instanceName,
    maxRounds: claim.maxRounds,
    readers: claimReaders(context, claim, row, ref, names),
  });
  if (decision.kind === "skip") {
    await touchSafely(context, row);
    return;
  }
  if (decision.kind === "hold") {
    if (row.fix_hold_reason !== decision.reason) {
      if (await claim.setHold(row.id, decision.reason, row.fix_hold_reason)) {
        counters.held += 1;
      }
    }
    await touchSafely(context, row);
    return;
  }
  // 一時的な保留が解けた行は、保留を外してから起動する。
  // 読んだ後に別の実行が理由を書き換えていたら外せないので、その行は起動せず、次の回に判断し直す。
  if (
    row.fix_hold_reason !== null &&
    !(await claim.setHold(row.id, null, row.fix_hold_reason))
  ) {
    await touchSafely(context, row);
    return;
  }
  const workItemId = await claim.claim({
    id: row.id,
    owner: names.owner,
    repo: names.repo,
    headSha: decision.pr.headSha,
    title: decision.pr.title,
    claimedBy: null,
  });
  if (workItemId === null) {
    await touchSafely(context, row);
    return;
  }
  state.claimsStarted += 1;
  await launchClaimed(context, claim, row, ref, workItemId);
}

/**
 * 起動した作業項目のフローを起動する。起動に失敗したら、作業項目を`failed`にして、行を`failed`に戻す。
 * 作業項目を失敗にできなくても、行は戻す。作業項目が動いている間は、次の判断が
 * `last_fix_unsettled`で保留し、作業項目が終わった後に再び起動の候補になる。
 * 戻した行は`fix_attempts`を減らさないので、起動し直すたびに回数の上限へ近づく。
 * フローが起動した後にジョブIDの記録だけが失敗したときは、動いているフローが次の起動と
 * 二重になるのを防ぐために、起動したジョブを取り消す。取り消せたら起動の失敗と同じに片付ける。
 * 取り消せなかったときは、動いているフローを残すために、作業項目を失敗にも行を戻しもせず、
 * 警告と失敗の記録を残す。
 */
async function launchClaimed(
  context: Context,
  claim: PrCiClaimDeps,
  row: PrCiCheck,
  ref: PullRequestRef,
  workItemId: number,
): Promise<void> {
  const { deps, counters } = context;
  try {
    await claim.launch(workItemId);
  } catch (err) {
    let note = "pr ci fix: the flow could not start";
    if (err instanceof PrFixFlowJobIdRecordError) {
      if (!(await cancelStartedFlow(context, claim, row, workItemId, err))) {
        counters.claimed += 1;
        return;
      }
      note =
        "pr ci fix: the flow was cancelled because its job id was not recorded";
    }
    await recordFailureOf(context, `launch_fix:${prKey(ref)}`, err);
    try {
      await claim.failFixItem(workItemId, note);
    } catch (failErr) {
      await recordFailureOf(context, `fail_fix_item:${prKey(ref)}`, failErr);
    }
    await deps.release(row.id, { fixWorkItemId: workItemId });
    return;
  }
  counters.claimed += 1;
  deps.log.info("pr ci fix launched", {
    repo: repoKey(row),
    pr: row.pr_number,
    sha: row.head_sha,
    work_item_id: workItemId,
  });
}
