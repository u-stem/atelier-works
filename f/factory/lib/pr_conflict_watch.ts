// FactoryのPRのマージの競合の監視(`watch_pr_conflicts`)の流れを、外部の操作を注入して組み立てる。
// 検知と通知を行う。PRにもリポジトリにも書き込まない。
// 競合を直す設定が有効なときは、競合を直す作業項目(`pr_fix`の競合回)を起動する(`PrConflictFixDeps`)。
// 起動の依存を渡さないときは、検知と通知だけを行う。
//
// 対象のPRは、作業項目の存在や更新時刻に頼らずに見つける。
// 次の和集合のリポジトリごとに、開いているPRを列挙する。
// - 状態が`pr_open`の作業項目を持つリポジトリ。
// - 競合の記録(`pr_conflict_checks`)の行を持つリポジトリ。
// - PATのアカウントが作った開いているPRを、照合を通ったオーナーごとに検索して見つけたリポジトリ。
//   検索はリポジトリを見つけるためだけに使い、PRの判定は一覧と`getPr`で行う。
// - 設定で明示されたリポジトリ(`factory_repo`と、`repo_allowlist`の各項目)。`owners`は展開しない。
// 列挙したPRのうち、Factoryのブランチ(`factory/issue-<N>-wi-<id>`)で、PATのアカウントが作った、
// 下書きでなく、forkでないものだけを、PRとして読む。
// 作業項目は`cleanup_db`が消すので、判定に使わない。
// 上の和集合に入らないリポジトリ(作業項目も競合の行も無く、検索にも現れず、設定にも明示されていない)のPRは、見つけられない。
//
// 競合とみなすのは、`mergeable`が偽で`mergeable_state`が`dirty`のときだけである(`decidePrConflict`)。
// GitHubが計算していない(`mergeable`が`null`)PRは何もせず、次の回に判定し直す。
//
// 通知は競合の1回につき1回である。競合は、行が無い状態か、競合から離れた状態から競合に移った時点で始まる。
// 競合のままheadが進んでも、通知は重ねない。通知の登録とDiscordの後に、通知した時刻を記録する。
// 記録が先に成功して通知が失敗すると、通知が出なくなるためである。
//
// 競合を直す設定が有効なときの、1回の巡回の流れは次のとおりである。
// 1. 回復: 直す作業項目が結ばれた行を、作業項目の状態に合わせて戻す。設定の有効と無効に依らず、通知の判断より先に行う。
//    先に行うのは、終わった作業項目のある行が、通知の判断で1回余分に待たされないためである。
// 2. 通知の判断: 通知していない競合の行を、通知する、待つ、起動の判断に回す、のどれかに決める(`decideConflictNotify`)。
//    直す作業項目が結ばれた行は、設定が無効になっていても待つ。作業項目が動く間に通知すると、
//    人とFactoryが同じブランチへpushしうるためである。回復が結びを外すと、次の判断で通知に進む。
// 3. 起動の判断: 通知の判断が起動に回した行だけを、`decideConflictFixClaim`で判断する。
//    判断が例外を投げても、起動の文が何も返さなくても、通知は猶予の経過で必ず出る。
// 保留の理由は、直す作業項目を起動しなかった理由を行に書く。最終の保留は猶予を待たずに通知する。
// 通知の解決は、競合が終わった(解けた、PRが閉じた、設定が対象から外した)ときだけ行う。
// 始まったときには解決しない。並んだ2つの実行の一方が、他方の出したばかりの通知を解決してしまうのを避けるためである。
//
// 開いているPRの一覧で読まなかった競合の行は、PRを読み直して、解けたか閉じたかを確かめる。
// PRが閉じたと読めた行と、設定が対象から外したリポジトリの行だけを閉じる。
// PATがリポジトリを読めなくなっただけ(403、404)では、通知を解決せず、行も閉じない。
// オーナーの照合に失敗した回も、設定は変わっていないので、行を閉じない。
// 外部由来の文字列(題名、ブランチ名)は、通知にもログにも載せない。
// 例外は、PRごと、リポジトリごとに捕まえて、他を止めない。rate limitは、以降の読み取りを止める。

import type {
  ClaimPrConflictInput,
  PrConflictCheck,
  PrConflictMarkResult,
  PrConflictObservation,
  PrConflictRecorded,
  PrConflictSettledState,
  ReleasePrConflictFixOptions,
} from "./db.ts";
import type { NotifyBestEffortResult, NotifyEvent } from "./discord.ts";
import {
  GitHubHttpError,
  GitHubPaginationLimitError,
  GitHubRateLimitError,
  type OpenPullRequest,
  type PrCommitMessages,
  type PullRequest,
  parseGitHubRepoUrl,
  type Viewer,
} from "./github.ts";
import type { Logger } from "./log.ts";
import type { MainCiState } from "./main_ci_support.ts";
import { pullRequestKey } from "./pr_ci_human_support.ts";
import { type PullRequestRef, pullRequestPageUrl } from "./pr_ci_support.ts";
import { isSameRepoHead, RUN_BUDGET_MS } from "./pr_ci_watch.ts";
import {
  type ConflictFixClaimDecision,
  type ConflictFixClaimReaders,
  decideConflictFixClaim,
  decideConflictNotify,
} from "./pr_conflict_fix_claim.ts";
import type { ConflictFixItemState } from "./pr_conflict_fix_recovery.ts";
import { decideConflictFixRecovery } from "./pr_conflict_fix_recovery.ts";
import {
  decidePrConflict,
  isFinalPrConflictFixHold,
  isPrConflictFixHoldReason,
  PR_CONFLICT_KIND,
  PR_CONFLICT_REASON,
  PR_CONFLICT_RESOLVED_BY,
  type PrConflictFixHoldReason,
  type PrConflictSkipReason,
  prConflictNextAction,
  prConflictNoticeMessage,
  prConflictNoticePrefix,
} from "./pr_conflict_support.ts";
import { PrFixFlowJobIdRecordError } from "./pr_fix_launch.ts";
import {
  assertGitHubName,
  type FactoryConfig,
  type FactoryOwner,
  type NoticeRecord,
  parseImplementBranchWorkItemId,
} from "./types.ts";

/** 1回の実行で読む、競合している行の最大の数。 */
export const CONFLICT_ROW_LIMIT = 200;

/** 1回の実行で回復する、直す作業項目が結ばれた行の最大の数。 */
export const CONFLICT_FIXING_BATCH_LIMIT = 100;

/** 1回の実行で、直す作業項目を起動する最大の数。起動に失敗した分も数える。 */
export const CONFLICT_CLAIMS_PER_RUN_LIMIT = 2;

/** 行が直す作業項目に結ばれたまま、これ以上たったら警告する(ミリ秒)。 */
export const FIX_BOUND_WARN_AFTER_MS = 2 * 60 * 60_000;

type RepoRef = { owner: string; repo: string };

/**
 * 直す作業項目が結ばれた行を戻す依存。渡さなければ回復しない。
 * 競合を直す設定の有効と無効に関わらず、渡す。
 */
export type PrConflictRecoveryDeps = {
  /** 直す作業項目が結ばれた行を、読み直していない順に返す(`listPrConflictFixing`)。 */
  readonly listFixing: (limit: number) => Promise<PrConflictCheck[]>;
  /**
   * 直す作業項目の状態を読む。作業項目が無ければ`null`。
   * `rowEpisode`は、結ばれた行の今の競合の回である。
   */
  readonly readFixItem: (
    workItemId: number,
    rowEpisode: number,
  ) => Promise<ConflictFixItemState | null>;
  /** 行の結びを外す(`releasePrConflictFix`)。外したら`true`、行が別の作業項目に結ばれていたら`false`。 */
  readonly release: (
    id: number,
    options: ReleasePrConflictFixOptions,
  ) => Promise<boolean>;
};

/**
 * 競合を直す作業項目を起動する依存。渡さなければ起動せず、通知は検知した時点で出す。
 * リポジトリ名の綴りは、引く先で違う。作業項目を引く関数と起動には、PRが示すGitHubの正規の綴りを渡す。
 * ほかの関数には、行と同じ小文字を渡す。
 */
export type PrConflictFixDeps = {
  /** 行の結びを外す(`releasePrConflictFix`)。起動に失敗した作業項目の行を戻すのに使う。 */
  readonly release: (
    id: number,
    options: ReleasePrConflictFixOptions,
  ) => Promise<boolean>;
  /** 競合の1回で起動できる数の上限(`pr_conflict_fix_max_rounds`)。 */
  readonly maxRounds: number;
  /** 1つのPRで起動できる数の上限(`pr_conflict_fix_max_rounds_per_pr`)。 */
  readonly maxRoundsPerPr: number;
  /** この時刻より前に始まった競合の回は、起動の対象にしない。 */
  readonly enabledSince: Date;
  /** 一時の保留のまま通知を待つ時間(分)。 */
  readonly graceMin: number;
  readonly hasActiveFix: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<boolean>;
  readonly getDefaultBranch: (owner: string, repo: string) => Promise<string>;
  readonly listCommits: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<PrCommitMessages>;
  /** factory-fixスキルが、競合を直す節のマーカーを持つか。 */
  readonly hasSkillMarker: () => Promise<boolean>;
  readonly budgetExceeded: () => Promise<boolean>;
  /** 既定のブランチの先頭のコミットのmainのCIの状態。記録が無ければ`null`。 */
  readonly mainCiState: (
    owner: string,
    repo: string,
    defaultBranch: string,
  ) => Promise<MainCiState | null>;
  readonly countEpisodeRounds: (
    checkId: number,
    episode: number,
  ) => Promise<number>;
  readonly countPrRounds: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<number>;
  /** 競合を直す作業項目が、失敗せずに終わったか、pushした後に終わった時刻の最新。無ければ`null`。 */
  readonly lastFixSettledAt: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<Date | null>;
  /**
   * 保留の理由を書く(`setPrConflictFixHold`)。`null`で外す。`expected`は書く前の理由で、いまの理由がこれと違う行は書き換えない。
   * 書いたら`true`。
   */
  readonly setHold: (
    id: number,
    reason: PrConflictFixHoldReason | null,
    expected: string | null,
  ) => Promise<boolean>;
  /** 行に作業項目を結んで挿入する(`claimPrConflictForFix`)。起動できなければ`null`。 */
  readonly claim: (input: ClaimPrConflictInput) => Promise<number | null>;
  /** 作業項目のpr_fixフローを起動する。 */
  readonly launch: (workItemId: number) => Promise<void>;
  /** 起動に失敗した作業項目を`failed`にする。 */
  readonly failFixItem: (workItemId: number, note: string) => Promise<void>;
  /** 起動したが記録できなかったフローのジョブを取り消す(`wmill.cancelJob`)。 */
  readonly cancelFlow: (jobId: string, reason: string) => Promise<void>;
};

/**
 * 回復と起動の依存の組。起動の依存は、回復の依存と一緒にだけ渡せる。
 * 回復が無いと、起動した作業項目の結びが外れず、その行は通知も起動もされなくなるためである。
 */
export type PrConflictFixWiring =
  | { readonly recovery?: PrConflictRecoveryDeps; readonly fix?: undefined }
  | {
      readonly recovery: PrConflictRecoveryDeps;
      readonly fix: PrConflictFixDeps;
    };

export type PrConflictWatchDeps = PrConflictFixWiring & {
  readonly now: () => Date;
  readonly log: Logger;
  readonly instanceName: string;
  /** 許可リストと、照合を通ったオーナーに合うリポジトリか(`buildRepoGates`)。読み取りの対象を決める。 */
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  /**
   * 同じ規則を、照合前の`owners`に当てた結果(`buildRepoGates`)。設定だけで決まり、照合の成否に依らない。
   * 行を閉じるかどうかは、こちらで決める。照合の一時的な失敗で、行を閉じないためである。
   */
  readonly isRepoConfigured: (owner: string, repo: string) => boolean;
  /** PATのアカウントを返す。Factoryが作ったPRの作者の確認に使う。 */
  readonly getViewer: () => Promise<Viewer>;
  /** 設定で明示されたリポジトリ(`factory_repo`と`repo_allowlist`の項目)。 */
  readonly explicitRepos: readonly RepoRef[];
  /** 状態が`pr_open`の作業項目を持つリポジトリ。重複は無い。 */
  readonly listOpenRepos: () => Promise<RepoRef[]>;
  /** 競合の記録の行を持つリポジトリ。重複は無い。 */
  readonly listConflictRepos: () => Promise<RepoRef[]>;
  /** 開いているPRを検索するオーナー。オーナーの照合を通ったものである。 */
  readonly searchOwners: readonly FactoryOwner[];
  /**
   * そのオーナーで、`author`が作った開いているPRを検索し、そのリポジトリを返す(`searchOpenAuthoredPrs`)。
   * リポジトリを見つけるためだけに使う。rate limitの解除は待たず、拒まれたら`GitHubRateLimitError`を投げる。
   */
  readonly searchOpenRepos: (
    owner: FactoryOwner,
    author: string,
  ) => Promise<RepoRef[]>;
  /** リポジトリの開いているPRをすべて返す。多すぎて読み切れないときは例外を投げる。 */
  readonly listOpenPrs: (
    owner: string,
    repo: string,
  ) => Promise<OpenPullRequest[]>;
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
  /** 今の競合で通知した時刻を記録し、結果を区別して返す(`markPrConflictNotified`)。 */
  readonly markNotified: (id: number) => Promise<PrConflictMarkResult>;
  /** 通知(notice)をidで1件解決する。この呼び出しで解決したら`true`。 */
  readonly resolveNotice: (id: number) => Promise<boolean>;
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
  /** 直す作業項目を起動した数。 */
  readonly claimed: number;
  /** 起動せず、保留の理由を書いた(変えた)数。 */
  readonly held: number;
  /** 回復で、直す作業項目との結びを外した行の数。 */
  readonly released: number;
  /** 直す作業項目が動いているので、通知も起動もせず待った行の数。 */
  readonly waiting: number;
  /** 閉じた行の数。PRが閉じたときと、設定が対象から外したときを含む。 */
  readonly closed: number;
  /** 判定を見送ったPRの数。 */
  readonly skipped: number;
  /** 失敗したPRとリポジトリの数。 */
  readonly errors: number;
  /**
   * 予算かrate limitで読み残した数。読み残したリポジトリ、PR、競合の行の合計である。
   * 読み残したものは、次の回に回る。
   */
  readonly deferred: number;
  /** rate limitで読み取りを止めたか。 */
  readonly rateLimited: boolean;
  /** PATが拒まれて(401)読み取りを止めたか。 */
  readonly unauthorized: boolean;
};

/** 何も読まずに終わったときの結果。 */
export const PR_CONFLICT_WATCH_IDLE_RESULT: PrConflictWatchResult = {
  tracked: 0,
  conflicted: 0,
  notified: 0,
  resolved: 0,
  claimed: 0,
  held: 0,
  released: 0,
  waiting: 0,
  closed: 0,
  skipped: 0,
  errors: 0,
  deferred: 0,
  rateLimited: false,
  unauthorized: false,
};

type Counters = {
  tracked: number;
  conflicted: number;
  notified: number;
  resolved: number;
  claimed: number;
  held: number;
  released: number;
  waiting: number;
  closed: number;
  skipped: number;
  errors: number;
  deferred: number;
  rateLimited: boolean;
  unauthorized: boolean;
};

type Deferred = { repos: number; prs: number; rows: number };

/** 起動の判断で読む、回の中で変わらない事実。最初の読み取りを共有し、行ごとに読み直さない。 */
type Facts = {
  /** スキルのマーカーと日次の予算。鍵は事実の名前。 */
  readonly flags: Map<string, Promise<boolean>>;
  /** リポジトリごとの既定のブランチ。 */
  readonly defaultBranch: Map<string, Promise<string>>;
  /** リポジトリごとの、既定のブランチの先頭のmainのCI。 */
  readonly mainCi: Map<string, Promise<MainCiState | null>>;
  /** この回で、直す作業項目を作った数。フローの起動に失敗した分も数える。 */
  claimsStarted: number;
  /** この回で記録した失敗。同じ失敗(共有した読み取りの失敗)を、行の数だけ記録しないために覚える。 */
  readonly reported: Set<unknown>;
};

type Context = {
  readonly deps: PrConflictWatchDeps;
  readonly startedAt: Date;
  readonly counters: Counters;
  readonly deferred: Deferred;
  /** この回の最初に読んだ、競合している行。PRの鍵で引く。 */
  readonly rows: ReadonlyMap<string, PrConflictCheck>;
  readonly facts: Facts;
};

/** `slot`に最初の読み取りを覚え、2回目からは同じ結果を返す。失敗も同じ失敗として返す。 */
function readOnce<T>(
  slot: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const known = slot.get(key);
  if (known !== undefined) return known;
  const started = read();
  slot.set(key, started);
  return started;
}

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
  const { rateLimited, unauthorized } = context.counters;
  return rateLimited || unauthorized || overBudget(context);
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
 * rate limitなら以降の読み取りを止める。PATが拒まれた(401)ときも以降の読み取りを止め、失敗を1件だけ記録する。
 * 権限の不足(403、404)ならログだけに残し、それ以外は失敗として記録する。
 * 404は、リポジトリを読む権限を失った場合にも返るので、PRが無くなったとは扱わない。
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
  if (isStatus(err, 401)) {
    if (!counters.unauthorized) {
      counters.unauthorized = true;
      await recordFailureOf(context, step, err);
    }
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
 * 設定で明示されたリポジトリ。`factory_repo`と、`repo_allowlist`の各項目である。
 * `owners`はオーナーの全リポジトリを指すので展開しない。読めない項目は飛ばす。
 */
export function configuredRepos(
  config: Pick<FactoryConfig, "factory_repo" | "repo_allowlist">,
): RepoRef[] {
  const repos: RepoRef[] = [];
  for (const url of [config.factory_repo, ...config.repo_allowlist]) {
    try {
      repos.push(parseGitHubRepoUrl(url));
    } catch {
      // 読めない項目は、許可の判定にも合わないので、列挙の対象にしない。
    }
  }
  return mergeRepos(repos);
}

function repoKey(entry: RepoRef): string {
  return `${entry.owner}/${entry.repo}`.toLowerCase();
}

/** `found`のうち、`others`のどれにも入らないリポジトリの鍵。 */
function onlyFound(
  found: readonly RepoRef[],
  others: readonly (readonly RepoRef[])[],
): Set<string> {
  const known = new Set(others.flatMap((list) => list.map(repoKey)));
  return new Set(found.map(repoKey).filter((key) => !known.has(key)));
}

/** 重複を除いて重ねる。大文字小文字は区別せず、最初の綴りを残す。 */
function mergeRepos(...lists: readonly (readonly RepoRef[])[]): RepoRef[] {
  const seen = new Set<string>();
  const merged: RepoRef[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const key = repoKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ owner: entry.owner, repo: entry.repo });
    }
  }
  return merged;
}

/**
 * 競合の監視を1回分実行する。
 * 競合している行を読めなければ、何も読まずに失敗として記録して終わる。
 */
export async function runPrConflictWatch(
  deps: PrConflictWatchDeps,
): Promise<PrConflictWatchResult> {
  const counters = { ...PR_CONFLICT_WATCH_IDLE_RESULT };
  const deferred: Deferred = { repos: 0, prs: 0, rows: 0 };
  const startedAt = deps.now();
  const rows = new Map<string, PrConflictCheck>();
  const context: Context = {
    deps,
    startedAt,
    counters,
    deferred,
    rows,
    facts: {
      flags: new Map(),
      defaultBranch: new Map(),
      mainCi: new Map(),
      claimsStarted: 0,
      reported: new Set(),
    },
  };
  // 回復を先に行う。競合している行は、回復が結びを外した後に読む。
  await recoverFixing(context);
  try {
    for (const row of await deps.listConflicted(CONFLICT_ROW_LIMIT)) {
      rows.set(pullRequestKey(rowRef(row)), row);
    }
  } catch (err) {
    counters.errors += 1;
    await deps.recordFailure("list_conflicted", err);
    return counters;
  }
  const seen = await watchOpenPrs(context);
  await watchRemainingRows(context, seen);
  counters.deferred = deferred.repos + deferred.prs + deferred.rows;
  if (counters.deferred > 0) {
    deps.log.warn("pr conflict left reads to the next run", {
      repos: deferred.repos,
      prs: deferred.prs,
      rows: deferred.rows,
      rate_limited: counters.rateLimited,
    });
  }
  return counters;
}

/**
 * 設定が有効なときだけ、`start`を呼んで監視を実行する。無効なら`start`を呼ばず、何も読まず何も書かずに終わる。
 * `start`は、変数の取得、GitHubの照合、DBの読み取りを含む。無効のときにそれらが起きないことを、ここで保証する。
 */
export async function runPrConflictWatchIfEnabled(
  enabled: boolean,
  log: Logger,
  start: () => Promise<PrConflictWatchResult>,
): Promise<PrConflictWatchResult> {
  if (!enabled) {
    log.info("pr conflict watch is disabled");
    return PR_CONFLICT_WATCH_IDLE_RESULT;
  }
  return start();
}

/**
 * 開いているPRのうち、Factoryが作ったPRか。
 * Factoryのブランチの形で、PATのアカウントが作り、下書きでなく、forkでないものである。
 * 同じ形の名前のブランチを作った他の人のPRを、Factoryのものとして扱わないために、作者を確かめる。
 * 数値IDが分かるときは、名前の付け替えを避けるためIDも確かめる。
 */
function isCandidate(pr: OpenPullRequest, viewer: Viewer): boolean {
  return (
    !pr.draft &&
    isSameRepoHead(pr) &&
    parseImplementBranchWorkItemId(pr.headRef) !== null &&
    pr.authorLogin !== null &&
    pr.authorLogin.toLowerCase() === viewer.login.toLowerCase() &&
    (pr.authorId === null || pr.authorId === viewer.id)
  );
}

/**
 * 列挙するリポジトリの和集合を作る。読めない元は失敗として記録し、読めた元だけで進める。
 * 検索のrate limitは別の枠なので、記録せず、ほかの読み取りも止めない。
 */
async function collectRepos(
  context: Context,
  viewer: Viewer,
): Promise<{ repos: RepoRef[]; searchOnly: ReadonlySet<string> }> {
  const { deps } = context;
  const read = async (
    step: string,
    load: () => Promise<RepoRef[]>,
  ): Promise<RepoRef[]> => {
    try {
      return await load();
    } catch (err) {
      await recordFailureOf(context, step, err);
      return [];
    }
  };
  const open = await read("list_open_repos", deps.listOpenRepos);
  const conflict = await read("list_conflict_repos", deps.listConflictRepos);
  const searched: RepoRef[] = [];
  for (const owner of deps.searchOwners) {
    if (stopped(context)) break;
    try {
      searched.push(...(await deps.searchOpenRepos(owner, viewer.login)));
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        deps.log.warn("pr conflict search stopped by the rate limit", {
          owner: owner.name,
        });
        break;
      }
      if (isStatus(err, 401)) {
        await absorbReadError(context, "search_open_repos", owner.name, err);
        break;
      }
      await recordFailureOf(context, `search_open_repos:${owner.name}`, err);
    }
  }
  const repos = mergeRepos(open, conflict, deps.explicitRepos, searched);
  // リポジトリ名は出さず、元ごとの件数だけを出す。検索が期待どおり動いたかを、件数で確かめられる。
  deps.log.info("pr conflict repositories collected", {
    work_items: open.length,
    conflict_rows: conflict.length,
    explicit: deps.explicitRepos.length,
    searched: searched.length,
    total: repos.length,
  });
  return {
    repos,
    searchOnly: onlyFound(searched, [open, conflict, deps.explicitRepos]),
  };
}

/**
 * このリポジトリの開いているPRを読むか。許可リストと照合に合い、名前を記録できるものだけである。
 * 先頭が`.`などの名前は、記録が通さないので読まない。
 */
function isReadable(deps: PrConflictWatchDeps, entry: RepoRef): boolean {
  if (!deps.isRepoAllowed(entry.owner, entry.repo)) return false;
  try {
    assertGitHubName(entry.owner);
    assertGitHubName(entry.repo);
    return true;
  } catch {
    return false;
  }
}

/** 開いているFactoryのPRを読んで扱う。読めたPRの鍵の集合を返す。 */
async function watchOpenPrs(context: Context): Promise<Set<string>> {
  const { deps, deferred } = context;
  const seen = new Set<string>();
  let viewer: Viewer;
  try {
    viewer = await deps.getViewer();
  } catch (err) {
    await absorbReadError(context, "viewer", "viewer", err);
    return seen;
  }
  const collected = await collectRepos(context, viewer);
  const repos = collected.repos.filter((entry) => isReadable(deps, entry));
  for (const [index, { owner, repo }] of repos.entries()) {
    if (stopped(context)) {
      deferred.repos += repos.length - index;
      break;
    }
    let open: OpenPullRequest[];
    try {
      open = await deps.listOpenPrs(owner, repo);
    } catch (err) {
      if (err instanceof GitHubRateLimitError) deferred.repos += 1;
      // 検索だけが見つけたリポジトリは、設定でも作業項目でも選んでいない。
      // 件数の上限を超えても対応できないので、毎回の失敗として記録せず、ログだけに残す。
      if (
        err instanceof GitHubPaginationLimitError &&
        collected.searchOnly.has(repoKey({ owner, repo }))
      ) {
        deps.log.warn(
          "pr conflict could not list all the open pull requests of a searched repository",
          { repo: `${owner}/${repo}` },
        );
        continue;
      }
      await absorbReadError(
        context,
        `list_open_prs:${owner}/${repo}`,
        `${owner}/${repo}`,
        err,
      );
      continue;
    }
    const candidates = open.filter((pr) => isCandidate(pr, viewer));
    for (const [at, candidate] of candidates.entries()) {
      if (stopped(context)) {
        deferred.prs += candidates.length - at;
        break;
      }
      await watchOpenPr(context, owner, repo, candidate.number, seen);
    }
  }
  return seen;
}

async function watchOpenPr(
  context: Context,
  owner: string,
  repo: string,
  number: number,
  seen: Set<string>,
): Promise<void> {
  const { deps, counters } = context;
  const ref: PullRequestRef = { owner, repo, number };
  const key = pullRequestKey(ref);
  try {
    const pr = await deps.getPr(owner, repo, number);
    // 読めたPRだけを、読んだものとして数える。読めなかったPRの行は、あとの整理で読み直す。
    seen.add(key);
    counters.tracked += 1;
    await applyDecision(context, ref, pr);
  } catch (err) {
    if (err instanceof GitHubRateLimitError) context.deferred.prs += 1;
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
      await touchIfTracked(context, ref);
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
      if (row.notified_at === null)
        await handleUnnotified(context, ref, row, pr);
      return;
    }
  }
}

/** 競合の行を持つPRは、読み直した時刻を進めて、順番を後ろに回す。行が無ければ何もしない。 */
async function touchIfTracked(
  context: Context,
  ref: PullRequestRef,
): Promise<void> {
  const row = context.rows.get(pullRequestKey(ref));
  if (row !== undefined) await context.deps.touch(row.id);
}

/** 判定を見送った理由を数え、見送るはずのない理由はlogに残す。 */
function skip(
  context: Context,
  ref: PullRequestRef,
  reason: PrConflictSkipReason,
): void {
  context.counters.skipped += 1;
  if (reason === "not_dirty" || reason === "invalid_sha") {
    context.deps.log.warn("pr conflict skipped an unusual pull request", {
      pr: pullRequestKey(ref),
      reason,
    });
  }
}

/**
 * 競合を通知する。通知(notice)を登録し、通知した時刻を記録し、記録できたときだけDiscordに送る。
 * 通知を先に登録する。通知した時刻の記録が先に成功して登録が失敗すると、通知が永久に出ないため。
 * Discordは記録の後に送る。記録は直す作業項目の起動と排他なので、起動した行や解けた行にDiscordが届かない。
 * 同じ本文の未解決の通知があって登録しなかった回でも、記録できればDiscordに送る。前の回が記録の前に止まっても、Discordを失わないためである。
 */
async function notifyConflict(
  context: Context,
  ref: PullRequestRef,
  rowId: number,
  hold: PrConflictFixHoldReason | undefined,
): Promise<void> {
  const { deps, counters } = context;
  const noticeId = await deps.addNotice({
    kind: PR_CONFLICT_KIND,
    message: prConflictNoticeMessage({
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.number,
      ...(hold === undefined ? {} : { hold }),
    }),
  });
  const marked = await deps.markNotified(rowId);
  if (marked === "marked") {
    counters.notified += 1;
    deps.log.warn("pr conflict notified", { pr: pullRequestKey(ref) });
    const sent = await deps.notify({
      kind: "needs_human",
      instance_name: deps.instanceName,
      owner: ref.owner,
      repo: ref.repo,
      url: pullRequestPageUrl(ref.owner, ref.repo, ref.number),
      reason:
        hold === undefined
          ? PR_CONFLICT_REASON
          : `${PR_CONFLICT_REASON}(自動修正の保留: ${hold})`,
      target: { kind: "pr", number: ref.number },
      next_action: prConflictNextAction(hold ?? null),
    });
    // 通知(notice)は残るので、Discordに届かなかったことだけを記録する。
    if (sent.status === "not_sent") {
      deps.log.warn("pr conflict notice was not delivered", {
        pr: pullRequestKey(ref),
        notice_id: noticeId,
        reason: sent.reason,
      });
    }
    return;
  }
  // 記録できなかった。解けたか閉じた行は、解決する側が登録前の通知を見逃したので、この実行が登録した通知を解決する。
  // 直す作業項目が結ばれた行も、作業項目が動く間は人に頼まないので解決する。行は未通知のまま残り、次の巡回で判断し直す。
  // 他の実行が記録済みのときは、競合が続くので解決しない。どの場合もDiscordは送らない。
  if (
    (marked === "not_conflicted" || marked === "fix_bound") &&
    noticeId !== null
  ) {
    await deps.resolveNotice(noticeId);
  }
}

// ---------------------------------------------------------------------------
// 回復
// ---------------------------------------------------------------------------

/**
 * 直す作業項目が結ばれた行を、作業項目の状態に合わせて戻す。
 * 競合を直す設定の有効と無効に依らず、通知の判断より先に行う。
 * 無効の間に止めると、結びが残り、有効にし直した後に起動できなくなる。
 * 例外は行ごとに捕まえ、読み直した時刻を進めて、後ろの行が飢えないようにする。
 */
async function recoverFixing(context: Context): Promise<void> {
  const { deps } = context;
  const recovery = deps.recovery;
  if (recovery === undefined) return;
  let rows: PrConflictCheck[];
  try {
    rows = await recovery.listFixing(CONFLICT_FIXING_BATCH_LIMIT);
  } catch (err) {
    await recordFailureOf(context, "list_fixing", err);
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (overBudget(context)) {
      deps.log.warn("pr conflict recovery stopped by the time budget", {
        left: rows.length - index,
      });
      break;
    }
    try {
      await recoverRow(context, recovery, row);
    } catch (err) {
      await recordFailureOf(
        context,
        `recover_fixing:${pullRequestKey(rowRef(row))}`,
        err,
      );
    }
    await touchSafely(context, row);
  }
}

/** 行の結びを外してよいかを、作業項目の状態から決め、外す。行が既に外れていたら、何もしない。 */
async function recoverRow(
  context: Context,
  recovery: PrConflictRecoveryDeps,
  row: PrConflictCheck,
): Promise<void> {
  const { deps, counters } = context;
  const workItemId = row.fix_work_item_id;
  if (workItemId === null) return;
  const item = await recovery.readFixItem(workItemId, row.episode);
  const decision = decideConflictFixRecovery(item);
  if (decision.kind === "keep") {
    // 状態を読めない作業項目や、止まったまま終わらない作業項目で、結びが残り続けても、通知は出ない。
    // 人が気づけるよう、長く残った行は警告を残す。
    const boundMs = deps.now().getTime() - row.updated_at.getTime();
    if (boundMs >= FIX_BOUND_WARN_AFTER_MS) {
      deps.log.warn("pr conflict fix has been running for a long time", {
        pr: pullRequestKey(rowRef(row)),
        work_item_id: workItemId,
        status: item?.status ?? null,
      });
    }
    return;
  }
  const hold = decision.kind === "release" ? decision.hold : null;
  // 結びを外すのは、行がこの作業項目に結ばれているときだけである。
  // 別の作業項目に起動し直された行や、既に外れた行は、`false`が返り、正常として扱う。
  const released = await recovery.release(row.id, {
    fixWorkItemId: workItemId,
    ...(hold === null ? {} : { holdReason: hold }),
  });
  if (!released) return;
  counters.released += 1;
  deps.log.info("pr conflict fix row released", {
    pr: pullRequestKey(rowRef(row)),
    kind: decision.kind,
    hold,
  });
}

// ---------------------------------------------------------------------------
// 通知していない競合の行
// ---------------------------------------------------------------------------

/**
 * 通知していない競合の行を、通知する、待つ、起動の判断に回す、のどれかに決める。
 * 直す作業項目が結ばれた行は、設定が無効でも、有効にした時刻より前に始まった競合でも待つ。
 * 作業項目が動く間に通知して人が直し始めると、人とFactoryが同じブランチへpushしうるためである。
 * 作業項目が終われば、回復が結びを外し、次の巡回で通常の判断に戻る。
 * 結びの無い行でも、競合を直す作業項目が動いていれば、猶予の後の通知を待つ。
 */
async function decideRowAction(
  context: Context,
  row: PrConflictCheck,
): Promise<"notify" | "defer" | "claim"> {
  if (row.fix_work_item_id !== null) return "defer";
  const { fix, log } = context.deps;
  const input = {
    fixEnabled: fix !== undefined,
    enabledSince: fix?.enabledSince ?? null,
    graceMin: fix?.graceMin ?? 0,
    now: context.deps.now(),
    row,
  };
  const decision = decideConflictNotify(input);
  // 最終の保留と、起動が無効な行は、直した直後でも通知する。猶予の後の通知だけを、直した直後の窓で待たせる。
  if (
    decision !== "notify" ||
    fix === undefined ||
    isFinalPrConflictFixHold(row.fix_hold_reason)
  ) {
    return decision;
  }
  // 行に結ばれていなくても、競合を直す作業項目が動いていることがある(古いイメージで止まった作業項目の自動の再開など)。
  // そのまま通知すると人とFactoryが同じブランチへpushしうるので、動く間は待つ。読めなくても、通知を止めない。
  try {
    if (await fix.hasActiveFix(row.owner, row.repo, row.pr_number)) {
      return "defer";
    }
  } catch (err) {
    log.warn("pr conflict could not read the active fix work item", {
      pr: pullRequestKey(rowRef(row)),
      error: errorMessage(err),
    });
  }
  let lastFixSettledAt: Date | null = null;
  try {
    lastFixSettledAt = await fix.lastFixSettledAt(
      row.owner,
      row.repo,
      row.pr_number,
    );
  } catch (err) {
    // 読めなくても、通知を止めない。
    log.warn("pr conflict could not read the time of the last fix", {
      pr: pullRequestKey(rowRef(row)),
      error: errorMessage(err),
    });
  }
  return decideConflictNotify({ ...input, lastFixSettledAt });
}

/** 通知に載せる保留の理由。起動の設定が無効なとき、語彙に無い理由のときは載せない。 */
function noticeHold(
  context: Context,
  row: PrConflictCheck,
): PrConflictFixHoldReason | undefined {
  if (context.deps.fix === undefined) return undefined;
  const reason = row.fix_hold_reason;
  return isPrConflictFixHoldReason(reason) ? reason : undefined;
}

async function handleUnnotified(
  context: Context,
  ref: PullRequestRef,
  row: PrConflictCheck,
  pr: PullRequest,
): Promise<void> {
  const action = await decideRowAction(context, row);
  if (action === "notify") {
    await notifyConflict(context, ref, row.id, noticeHold(context, row));
    return;
  }
  if (action === "defer") {
    context.counters.waiting += 1;
    return;
  }
  const { fix } = context.deps;
  if (fix === undefined) return;
  await claimRow(context, fix, ref, row, pr);
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

/** PRが示す`owner/repo`を、GitHubの正規の綴りの2つに分ける。形が違えば`null`。 */
function canonicalRepoNames(
  pr: PullRequest,
): { owner: string; repo: string } | null {
  const parts = pr.baseRepoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) return null;
  return { owner, repo };
}

/** 起動の判断が読む事実を、この行について組む。回の中で変わらない事実は、回の間で共有する。 */
function claimReaders(
  context: Context,
  fix: PrConflictFixDeps,
  ref: PullRequestRef,
  row: PrConflictCheck,
  names: { owner: string; repo: string },
): ConflictFixClaimReaders {
  const { deps, facts } = context;
  const repo = repoKey(names);
  const defaultBranch = (): Promise<string> =>
    readOnce(facts.defaultBranch, repo, () =>
      fix.getDefaultBranch(names.owner, names.repo),
    );
  return {
    hasActiveFix: () =>
      fix.hasActiveFix(names.owner, names.repo, row.pr_number),
    readPr: () => deps.getPr(ref.owner, ref.repo, ref.number),
    readDefaultBranch: defaultBranch,
    readCommits: () => fix.listCommits(names.owner, names.repo, row.pr_number),
    hasSkillMarker: () =>
      readOnce(facts.flags, "skill_marker", fix.hasSkillMarker),
    budgetExceeded: () => readOnce(facts.flags, "budget", fix.budgetExceeded),
    mainCiState: () =>
      readOnce(facts.mainCi, repo, async () =>
        fix.mainCiState(names.owner, names.repo, await defaultBranch()),
      ),
    countEpisodeRounds: () => fix.countEpisodeRounds(row.id, row.episode),
    countPrRounds: () => fix.countPrRounds(row.owner, row.repo, row.pr_number),
    lastFixSettledAt: () =>
      fix.lastFixSettledAt(row.owner, row.repo, row.pr_number),
  };
}

/**
 * 競合の行について、直す作業項目を起動してよいかを判断し、保留の理由を書くか、起動する。
 * 判断が例外を投げたときは、失敗を記録して続ける。行は変えないので、次の巡回で判断し直し、
 * 猶予が過ぎれば`decideConflictNotify`が通知に倒す。
 * 1回の実行で作業項目を作るのは`CONFLICT_CLAIMS_PER_RUN_LIMIT`件までで、読み取りを止めた後は新しく始めない。
 * 上限は、起動する直前にだけ見る。上限に達した後の行にも、保留の判断は行う。
 */
async function claimRow(
  context: Context,
  fix: PrConflictFixDeps,
  ref: PullRequestRef,
  row: PrConflictCheck,
  pr: PullRequest,
): Promise<void> {
  const { deps, counters, facts } = context;
  const key = pullRequestKey(ref);
  const names = canonicalRepoNames(pr);
  if (names === null) {
    deps.log.warn("pr conflict claim skipped a pull request without a name", {
      pr: key,
    });
    return;
  }
  if (stopped(context)) return;
  let decision: ConflictFixClaimDecision;
  try {
    decision = await decideConflictFixClaim({
      row,
      instanceName: deps.instanceName,
      maxRounds: fix.maxRounds,
      maxRoundsPerPr: fix.maxRoundsPerPr,
      now: deps.now(),
      readers: claimReaders(context, fix, ref, row, names),
    });
  } catch (err) {
    // 共有した読み取りの失敗は、同じ失敗が行の数だけ届く。1回の実行で1回だけ記録する。
    if (facts.reported.has(err)) return;
    facts.reported.add(err);
    await absorbReadError(context, `claim_conflict_fix:${key}`, key, err);
    return;
  }
  if (decision.kind === "skip") return;
  if (decision.kind === "hold") {
    if (
      row.fix_hold_reason !== decision.reason &&
      (await fix.setHold(row.id, decision.reason, row.fix_hold_reason))
    ) {
      counters.held += 1;
    }
    return;
  }
  // 上限に達した行は、通知せず、次の巡回に回す。保留の判断は、上限の前に済んでいる。
  // 古い一時の保留が付いたままだと、猶予の後の通知が、事実と違う理由を示す。解けた保留は外す。
  // 外すのは、読んだ理由のままの行だけで、最終の保留には触れない。保留が無ければ書かない。
  if (facts.claimsStarted >= CONFLICT_CLAIMS_PER_RUN_LIMIT) {
    if (
      row.fix_hold_reason !== null &&
      !isFinalPrConflictFixHold(row.fix_hold_reason)
    ) {
      await fix.setHold(row.id, null, row.fix_hold_reason);
    }
    return;
  }
  // 一時の保留が解けた行は、起動の文が同じ文の中で保留を外す。
  const workItemId = await fix.claim({
    id: row.id,
    owner: names.owner,
    repo: names.repo,
    headSha: decision.pr.headSha,
    title: decision.pr.title,
    claimedBy: null,
  });
  if (workItemId === null) return;
  facts.claimsStarted += 1;
  await launchClaimed(context, fix, ref, row, workItemId);
}

/**
 * 起動したフローのジョブを取り消す。取り消せたら`true`。
 * 取り消せなかったときは、人が気づけるように失敗を記録して`false`を返す。
 */
async function cancelStartedFlow(
  context: Context,
  fix: PrConflictFixDeps,
  err: PrFixFlowJobIdRecordError,
): Promise<boolean> {
  try {
    await fix.cancelFlow(
      err.flowJobId,
      "pr conflict fix: the job id of the flow was not recorded",
    );
    return true;
  } catch (cancelErr) {
    context.deps.log.warn("pr conflict fix flow started without a job id", {
      flow_job_id: err.flowJobId,
      error: errorMessage(cancelErr),
    });
    await recordFailureOf(context, "record_conflict_fix_job_id", err);
    return false;
  }
}

/**
 * 作成した作業項目のフローを起動する。起動に失敗したら、作業項目を`failed`にして、行の結びを外す。
 * 作業項目を失敗にできなくても、結びは外す。作業項目が動いている間は、次の判断が
 * `last_fix_unsettled`で保留し、作業項目が終わった後に再び起動の候補になる。
 * 結びを外しても`fix_attempts`は減らさないので、起動し直すたびに回数の上限へ近づく。
 * フローが起動した後にジョブIDの記録だけが失敗したときは、動いているフローが次の起動と
 * 二重になるのを防ぐために、起動したジョブを取り消す。取り消せたら起動の失敗と同じに片付ける。
 * 取り消せなかったときは、動いているフローを残すために、作業項目を失敗にも結びを外しもしない。
 */
async function launchClaimed(
  context: Context,
  fix: PrConflictFixDeps,
  ref: PullRequestRef,
  row: PrConflictCheck,
  workItemId: number,
): Promise<void> {
  const { deps, counters } = context;
  const key = pullRequestKey(ref);
  try {
    await fix.launch(workItemId);
  } catch (err) {
    let note = "pr conflict fix: the flow could not start";
    if (err instanceof PrFixFlowJobIdRecordError) {
      if (!(await cancelStartedFlow(context, fix, err))) return;
      note =
        "pr conflict fix: the flow was cancelled because its job id was not recorded";
    }
    await recordFailureOf(context, `launch_conflict_fix:${key}`, err);
    try {
      await fix.failFixItem(workItemId, note);
    } catch (failErr) {
      await recordFailureOf(context, `fail_conflict_fix_item:${key}`, failErr);
    }
    try {
      await fix.release(row.id, { fixWorkItemId: workItemId });
    } catch (releaseErr) {
      await recordFailureOf(context, `release_conflict_fix:${key}`, releaseErr);
    }
    return;
  }
  counters.claimed += 1;
  deps.log.info("pr conflict fix launched", {
    pr: key,
    work_item_id: workItemId,
  });
}

/**
 * 競合が終わったPRの通知を解決し、競合の行があれば移す。
 * 通知の解決を先にする。解決に失敗した回は、行を競合のまま残し、次の回にやり直す。
 * 行を移した後に、もう一度解決する。行を移す前の解決と移した後の間に、別の実行が通知を登録することがあり、
 * 通知を登録した実行が行の状態を確かめるのは、その後だからである。
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
  await deps.resolveNotices(
    PR_CONFLICT_KIND,
    prConflictNoticePrefix(ref.owner, ref.repo, ref.number),
    PR_CONFLICT_RESOLVED_BY,
  );
  if (!moved) return;
  if (to === "resolved") counters.resolved += 1;
  else counters.closed += 1;
  deps.log.info("pr conflict row settled", {
    pr: pullRequestKey(ref),
    state: to,
  });
}

/** 読み直した時刻を進める。進められなくても失敗として記録して、他の行を続ける。 */
async function touchSafely(
  context: Context,
  row: PrConflictCheck,
): Promise<void> {
  try {
    await context.deps.touch(row.id);
  } catch (err) {
    await recordFailureOf(
      context,
      `touch_row:${pullRequestKey(rowRef(row))}`,
      err,
    );
  }
}

/**
 * 開いているPRの一覧で読めなかった競合の行を整理する。PRを読み直し、閉じたか競合が解けたときだけ行を移す。
 * それ以外は、読み直した時刻だけを進める。通知は出さない。
 * - 設定が対象から外したリポジトリの行は、PRを読まずに閉じる。設定だけで決め、照合の成否には依らない。
 * - オーナーの照合に失敗した回のリポジトリの行は、読まずに時刻だけを進める。
 * - PRを読めない(403、404)行は、閉じずにログと時刻だけにする。権限を失っただけで、通知を消さないためである。
 */
async function watchRemainingRows(
  context: Context,
  seen: ReadonlySet<string>,
): Promise<void> {
  const { deps, deferred } = context;
  const pending = [...context.rows].filter(([key]) => !seen.has(key));
  for (const [index, [key, row]] of pending.entries()) {
    if (stopped(context)) {
      deferred.rows += pending.length - index;
      break;
    }
    const ref = rowRef(row);
    try {
      if (!deps.isRepoConfigured(ref.owner, ref.repo)) {
        await leaveConflict(context, ref, "closed");
        continue;
      }
      if (!deps.isRepoAllowed(ref.owner, ref.repo)) {
        deps.log.warn("pr conflict kept a row whose owner is not verified", {
          pr: key,
        });
        await deps.touch(row.id);
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
      if (err instanceof GitHubRateLimitError) deferred.rows += 1;
      await absorbReadError(context, `pr_conflict:${key}`, key, err);
      if (isStatus(err, 403, 404)) await touchSafely(context, row);
    }
  }
}
