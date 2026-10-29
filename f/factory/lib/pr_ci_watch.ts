// FactoryのPRのCI監視(`watch_pr_ci`)の流れを、外部の操作を注入して組み立てる。
// 発見(Factoryが作ったPRの今のheadを記録し、古いheadの行を整理する)の後に、
// 判定(判定待ち、失敗、実行なしの行を読み直して確定する)を行う。
// 失敗は通知し、通ったheadはそのPRの失敗の通知を解決し、閉じたPRの行は整理する。
// 発見と判定の間に、回復(失敗を直す作業項目が終わった`fixing`の行を戻す)を行う。
// 判定の後に、起動(失敗した行を直す作業項目を起動する)と人のPRの発見を行い、最後に保留した失敗の通知(`notifyDeferred`)を行う。
// 起動は`deps.claim`を渡したときだけ動く。起動してよいかの判断は`pr_ci_fix_claim.ts`にあり、
// ここは読み取りと書き込みの順序を受け持つ。
// 回復と保留した通知は監視の設定に依らず動き、作業項目の起動はしない(`runPrCiRecovery`)。
// 保留した通知を最後に置くのは、同じ回の判定と起動が書いた状態を見て、通知するかを決めるためである。
// 自動で直す対象の失敗は、確定した時点では通知せず、直せるかが決まるたびに`notifyDeferred`が通知する。同じ状態では重ねない。
// 通知する時機の判断は`pr_ci_notify.ts`にある。それ以外の失敗は、確定した時点ですぐ通知する。
// GitHub、DB、Discordの呼び出しは`PrCiWatchDeps`で渡し、テストで差し替える。
// 外部の文字列(workflow名、実行の結論、ログ)は、通知の本文にもDiscordにも載せない。
// 要約(`summary`列)にだけ、検証・整形した名前を残す。
//
// 起動の後に、許可された人が作ったPRも記録する(`humanDiscovery`を渡したときだけ)。
// FactoryのPRの判定と起動が、人のPRの発見に時間を使われないための順序である。新しい行の判定は次の回になる。
// 人のPRの行は`work_item_id`がNULLで、失敗は確定した時点で通知するだけにする。
// 直す作業項目は起動せず、回復の対象にもならない。
//
// 1つの行の判定は、実行を読む、PRのheadを読む、判定する、の順に行う。
// 先にPRのheadを読むと、読んでいる間に進んだheadの実行を、今のheadの失敗として扱ってしまう。

import { configuredRepos, isRepoAllowed } from "./config.ts";
import type {
  ClaimPrCiCheckInput,
  NewPrCiCheck,
  PrCiCheck,
  PrCiTransition,
} from "./db.ts";
import type { NotifyBestEffortResult, NotifyEvent } from "./discord.ts";
import {
  type GhOwnerRepoJudgement,
  isArchivedWithinFreshness,
  judgeGhOwnerRepos,
  judgeGhRepoFreshness,
  skippedStaleReasons,
  usableGhPullRequests,
  usableTableRows,
} from "./gh_collect_read.ts";
import {
  GitHubHttpError,
  GitHubRateLimitError,
  type OpenPullRequest,
  type PrCommitMessages,
  type PrHeadWorkflowRuns,
  type PrHeadWorkflowRunsOptions,
  type PullRequest,
  parseGitHubRepoUrl,
  type Viewer,
  type WorkflowRunJob,
  WorkflowRunsIncompleteError,
} from "./github.ts";
import type { Logger } from "./log.ts";
import { shortSha, type WorkflowRun } from "./main_ci_support.ts";
import { type LabelerPolicy, labelerPolicyFor } from "./poll_support.ts";
import {
  classifyHeadFailure,
  decideFixClaim,
  type FixClaimReaders,
  type WorkerEnvHoldReason,
  type WorkerEnvProblem,
} from "./pr_ci_fix_claim.ts";
import {
  decideFixingRecovery,
  type FixItemState,
} from "./pr_ci_fix_recovery.ts";
import {
  type HumanPrCandidate,
  humanPrAuthors,
  humanPrCandidatesFromOpenList,
  humanPrCandidatesFromRows,
  isAllowedPrAuthor,
  isHumanPrCandidate,
  notifyPolicyFor,
  pullRequestKey,
} from "./pr_ci_human_support.ts";
import {
  decideDeferredNotice,
  defersFailureNotice,
  type PrCiNotifyPolicy,
} from "./pr_ci_notify.ts";
import {
  CONFIG_MISFIT_KIND,
  classifyPrCiReason,
  configMisfitNoticeMessage,
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
  prCiFixHoldInfo,
  prCiHeadNoticePrefix,
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
  type GhOwnerOpenPrSnapshot,
  type GhRepoOpenPrSnapshot,
  type NoticeRecord,
  type WorkItemStatus,
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
 * 1回の実行で、人のPRとして記録する数の上限。
 * 追跡対象のFactoryのPRと、作者が許可されていないPRなどを除いた後に数える。
 * 除く前に数えると、Factoryのブランチなどが枠を埋めて、人のPRを見落とすためである。
 */
export const HUMAN_PR_LIMIT = 20;

/**
 * 1回の実行で、人のPRとして読む(PRを取得する)数の上限。
 * 記録済みでheadが動いていないPRは記録の枠を使わないので、読み取りの数にも上限を置く。
 */
export const HUMAN_PR_READ_LIMIT = 60;

/**
 * 1回の実行で判定する、記録済みの人の行の最大の数。判定待ち、失敗、実行なしの合計である。
 * 人の行は、FactoryのPRの行と同じ時間と、PATのcoreの枠を使う。上限を置かないと、記録した人のPRが増えるほど、
 * FactoryのPRの判定を圧迫する。超えた分は、読み直していない順に次の回へ回す。
 */
export const HUMAN_RECHECK_LIMIT = 40;

/**
 * 人のPRの発見(表と一覧の読み取りと、PRの読み取り)に使える時間。
 * 判定と起動の時間を、人のPRの発見が食わないようにする。
 */
export const HUMAN_DISCOVERY_BUDGET_MS = 30_000;

/** 1回の実行で、保留した失敗の通知を判断する行の最大の数。 */
export const DEFERRED_NOTICE_BATCH_LIMIT = 200;

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
 * 人のPRの発見の依存を組む。設定が偽のときは、PATのアカウントを読まずに`undefined`を返す。
 * PATのアカウントを読めなかったときも`undefined`を返し、失敗を記録する。人のPRの発見だけを飛ばし、
 * FactoryのPRの監視は止めないためである。
 * 表で探す範囲は、照合を通ったオーナーである。設定で明示したリポジトリ(`factory_repo`と`repo_allowlist`の項目)は、
 * 別に渡す。`factory_repo`は許可リストに関わらず常に対象で、`owners`の外にもありうる。
 * `factory_repo`を読めないときは、失敗を記録して、そのほかの範囲で発見を続ける。
 */
export async function buildHumanDiscovery(input: {
  readonly config: Pick<
    FactoryConfig,
    | "pr_ci_watch_human_prs"
    | "allowed_labeler_logins"
    | "allowed_labeler_ids"
    | "factory_repo"
    | "repo_allowlist"
  >;
  readonly useTable: PrCiHumanDiscoveryDeps["useTable"];
  readonly staleAfterMs: PrCiHumanDiscoveryDeps["staleAfterMs"];
  readonly readOwnerPrs: PrCiHumanDiscoveryDeps["readOwnerPrs"];
  readonly readRepoPrs: PrCiHumanDiscoveryDeps["readRepoPrs"];
  readonly listOpenPrs: PrCiHumanDiscoveryDeps["listOpenPrs"];
  readonly verifiedOwners: readonly FactoryOwner[];
  readonly getViewer: () => Promise<Viewer>;
  readonly getPr: PrCiHumanDiscoveryDeps["getPr"];
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
}): Promise<PrCiHumanDiscoveryDeps | undefined> {
  const { config } = input;
  if (!config.pr_ci_watch_human_prs) return undefined;
  let viewer: Viewer;
  try {
    viewer = await input.getViewer();
  } catch (err) {
    await input.recordFailure("human_discovery_viewer", err);
    return undefined;
  }
  try {
    parseGitHubRepoUrl(config.factory_repo);
  } catch (err) {
    await input.recordFailure("human_discovery_factory_repo", err);
  }
  return {
    policy: labelerPolicyFor(viewer.login, config),
    scopes: input.verifiedOwners.map((owner) => ({ owner: owner.name })),
    explicitRepos: configuredRepos(config),
    useTable: input.useTable,
    staleAfterMs: input.staleAfterMs,
    readOwnerPrs: input.readOwnerPrs,
    readRepoPrs: input.readRepoPrs,
    listOpenPrs: input.listOpenPrs,
    getPr: input.getPr,
  };
}

/**
 * 失敗した行から、直す作業項目を起動する依存。渡さなければ起動しない。
 * リポジトリ名の綴りは、引く先で違う。作業項目を引く`hasActiveFix`と、起動の`claim`には、
 * PRが示すGitHubの正規の綴りを渡す。ほかの関数には、行と同じ小文字を渡す。
 */
export type PrCiClaimDeps = {
  /** 1つのPRで起動できるラウンドの上限。 */
  readonly maxRounds: number;
  /** 時間設定が、修正・検証ステップのtimeoutに収まらない理由。収まるときは`null`。 */
  readonly configMisfit: string | null;
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
  /**
   * PRのブランチ名(`headRef`)が指すIssueの作業項目の状態を読む。
   * 引けないとき(ブランチの形が違う、削除済み、別のリポジトリ)は`null`。
   */
  readonly readBranchItemStatus: (
    owner: string,
    repo: string,
    headRef: string,
  ) => Promise<WorkItemStatus | null>;
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
  /**
   * 検査を動かすworkerの環境が前提を満たさない問題。満たすとき、検査コマンドが無いときは`null`。
   * 実行の中で1回だけ読む。
   */
  readonly workerEnvProblem: () => Promise<WorkerEnvProblem | null>;
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
   * `resetNotified`が真なら、通知した理由を同時に空に戻す。
   */
  readonly setHold: (
    id: number,
    reason: PrCiFixHoldReason | null,
    expected: string | null,
    resetNotified: boolean,
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

/** 収集の表で探す所有者の範囲。 */
export type HumanOwnerScope = {
  /** 所有者の名前。 */
  readonly owner: string;
};

/** 設定で明示したリポジトリ。 */
export type HumanExplicitRepo = {
  readonly owner: string;
  readonly repo: string;
};

/**
 * 許可された人が作ったPRを見つけて記録する依存。渡さなければ見つけない。
 * 作者は、`policy`のPATのアカウントと許可されたログイン名である。
 */
export type PrCiHumanDiscoveryDeps = {
  readonly policy: LabelerPolicy;
  /** 収集の表で探す所有者。オーナーの照合を通ったものである。 */
  readonly scopes: readonly HumanOwnerScope[];
  /** 設定で明示したリポジトリ(`factory_repo`と`repo_allowlist`の項目)。表を使えないときは、RESTの一覧で読む。 */
  readonly explicitRepos: readonly HumanExplicitRepo[];
  /**
   * 見つかったPRを読む。rate limitのときは、待たずに`GitHubRateLimitError`を投げる(`getPrWithoutWait`)。
   * FactoryのPRの読み取り(`PrCiWatchDeps.getPr`)とは分ける。人のPRの発見が、解除を待って全体の時間を使わないためである。
   */
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
  /**
   * リポジトリの開いているPRをすべて返す(`listOpenPullRequestsWithoutWait`)。
   * rate limitのときは、待たずに`GitHubRateLimitError`を投げる。多すぎて読み切れないときは例外を投げる。
   */
  readonly listOpenPrs: (
    owner: string,
    repo: string,
  ) => Promise<OpenPullRequest[]>;
  /** 収集の表を読んでよいか(収集の2つの設定が真か)。偽なら表を読まず、明示したリポジトリだけをRESTの一覧で読む。 */
  readonly useTable: boolean;
  /** 収集の記録を使わずに止める閾値(ミリ秒)。 */
  readonly staleAfterMs: number;
  /** 所有者のPRの行を、リポジトリの行と合わせて1つの文で読む。 */
  readonly readOwnerPrs: (owner: string) => Promise<GhOwnerOpenPrSnapshot>;
  /** 1つのリポジトリのPRの行を、リポジトリの行と合わせて1つの文で読む。所有者の範囲に入らない明示リポジトリに使う。 */
  readonly readRepoPrs: (
    owner: string,
    repo: string,
  ) => Promise<GhRepoOpenPrSnapshot>;
};

export type PrCiWatchDeps = {
  /** 渡したときだけ、判定の後に失敗した行の起動を行う。 */
  readonly claim?: PrCiClaimDeps;
  /** 渡したときだけ、判定と起動の後に許可された人のPRを記録する。 */
  readonly humanDiscovery?: PrCiHumanDiscoveryDeps;
  /**
   * 失敗の通知を保留するかと、保留した通知を出す時機を決める設定。
   * 自動修正が無効なら、失敗は確定した時点で通知する。
   */
  readonly notifyPolicy: PrCiNotifyPolicy;
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
  /** 失敗に確定して、まだ通知していない行を返す(`listUnnotifiedFailedPrCiChecks`)。 */
  readonly listUnnotifiedFailed: (limit: number) => Promise<PrCiCheck[]>;
  /** 直す作業項目の状態を返す。作業項目が無ければ`null`。 */
  readonly readFixItem: (workItemId: number) => Promise<FixItemState | null>;
  /**
   * 修正中の行を`failed`に戻す。この呼び出しで戻したら`true`。
   * `fixWorkItemId`を渡せば、その作業項目に結ばれた行だけを戻す。
   * `withoutFixWorkItem`を渡せば、作業項目に結ばれていない行だけを戻す。
   * `resetNotified`を渡せば、通知した理由を空に戻す。
   */
  readonly release: (
    id: number,
    options: {
      readonly holdReason?: PrCiFixHoldReason;
      readonly fixWorkItemId?: number;
      readonly withoutFixWorkItem?: boolean;
      readonly resetNotified?: boolean;
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
  /** 保留の理由が`config_misfit`の失敗の行すべての保留と通知した理由を外す。外した行数を返す。 */
  readonly releaseConfigMisfitHolds: () => Promise<number>;
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
  /** 保留していた失敗を、状態を見て通知した行の数。 */
  readonly notified: number;
  /** 実行かPRを読む権限が無かったリポジトリの数。 */
  readonly denied: number;
  /** 例外で処理できなかった数。 */
  readonly errors: number;
  /** 収集が無効で表を読まなかったか。真の間は、設定で明示したリポジトリ以外の人のPRを見つけられない。 */
  readonly human_collect_disabled: boolean;
  /** 表が新しくないため、処理せず見送った、明示でないリポジトリの数。 */
  readonly human_skipped_stale: number;
  /** 見送った理由ごとのリポジトリの数。理由は表の鮮度の判定の語である。 */
  readonly human_skipped_stale_reasons: Readonly<Record<string, number>>;
  /** 表の代わりにRESTの一覧で読んだ、明示のリポジトリの数。読めなかった一覧も数える。 */
  readonly human_rest_lists: number;
  /** 一覧で読んだ理由ごとのリポジトリの数。表の鮮度の判定の語に、`read_failed`と`collect_disabled`を足したもの。 */
  readonly human_rest_reasons: Readonly<Record<string, number>>;
  /** 時間の予算かrate limitで読み残した、所有者とリポジトリの数。次の回に回る。 */
  readonly human_deferred: number;
  /** 表から候補にした、作者の分かる候補の数。 */
  readonly human_table_candidates: number;
};

/**
 * 監視を無効にしているときの結果。
 * 呼び出し側が写して使うので、入れ子の理由の表も凍結する。書き換えると次の回に残るためである。
 */
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
  notified: 0,
  denied: 0,
  errors: 0,
  human_collect_disabled: false,
  human_skipped_stale: 0,
  human_skipped_stale_reasons: Object.freeze({}),
  human_rest_lists: 0,
  human_rest_reasons: Object.freeze({}),
  human_deferred: 0,
  human_table_candidates: 0,
};

type Counters = Omit<
  { -readonly [K in keyof PrCiWatchResult]: PrCiWatchResult[K] },
  "human_skipped_stale_reasons" | "human_rest_reasons"
> & {
  human_skipped_stale_reasons: Record<string, number>;
  human_rest_reasons: Record<string, number>;
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
  /**
   * 追跡対象の作業項目が指すPRの鍵(`pullRequestKey`)。人のPRの発見が、FactoryのPRを除くのに使う。
   * 作業項目の一覧を読めなかった回は`null`で、人のPRの発見をしない。
   */
  trackedPrKeys: Set<string> | null;
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
  /** この回に読んだ、workerの環境の保留の理由。読み終えていなければ`undefined`で、前提を満たすときは`null`。 */
  workerEnvRead: { readonly reason: WorkerEnvHoldReason | null } | undefined;
  /** この回にworkerの環境を読めなかった失敗。以後の行は読み直さず、同じ失敗として扱う。 */
  workerEnvFailure: WorkerEnvReadError | null;
  /** `workerEnvFailure`を記録した後か。1回の実行で1回だけ記録する。 */
  workerEnvFailureRecorded: boolean;
};

/** factory-fixスキルを読めなかった。対象のPRではなく、Factoryのリポジトリの読み取りの失敗である。 */
class SkillMarkerReadError extends Error {
  constructor(cause: unknown) {
    super(`skill marker could not be read: ${errorMessage(cause)}`, { cause });
    this.name = "SkillMarkerReadError";
  }
}

/** workerの環境を読めなかった。対象のPRではなく、監視のworkerの状態の読み取りの失敗である。 */
class WorkerEnvReadError extends Error {
  constructor(cause: unknown) {
    super(`worker environment could not be read: ${errorMessage(cause)}`, {
      cause,
    });
    this.name = "WorkerEnvReadError";
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
  return pullRequestKey(ref);
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
export function isSameRepoHead(
  pr: Pick<PullRequest, "headRepoFullName" | "baseRepoFullName">,
): boolean {
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
  await discoverHuman(context);
  await notifyDeferred(context);
  return context.counters;
}

/**
 * 回復と、保留した失敗の通知だけを行う。監視を無効にしている間も、修正中の行を放置せず、
 * 保留した通知を取りこぼさないために使う。
 * 発見も判定もしない。作業項目の起動もしない。保留した通知はDBだけを読み、GitHubを読まない。
 * 回復がPRを読めず403か404になったときだけ、`pr_ci_check_denied`の通知を足しうる。解決は判定が行う。
 * 戻す行のPRが閉じていたときだけ、閉じたPRの整理(`closePr`)を行う。失敗のnoticeの解決と、
 * そのPRの未完了の行を`superseded`にすることを含む。
 */
export async function runPrCiRecovery(
  deps: PrCiWatchDeps,
): Promise<PrCiWatchResult> {
  const context = newContext(deps);
  await recoverFixing(context);
  await notifyDeferred(context);
  return context.counters;
}

function newContext(deps: PrCiWatchDeps): Context {
  return {
    deps,
    now: deps.now(),
    // 理由の表は、凍結した定数と共有せず、回ごとに新しく作る。
    counters: {
      ...PR_CI_WATCH_IDLE_RESULT,
      human_skipped_stale_reasons: {},
      human_rest_reasons: {},
    },
    state: {
      rateLimited: false,
      failedStarted: 0,
      claimsStarted: 0,
      snapshots: new Map(),
      trackedPrKeys: null,
      deniedRepos: new Set(),
      readableRepos: new Set(),
      closedPrs: new Set(),
      discoveredPrs: new Set(),
      releasedIds: new Set(),
      claimFacts: new Map(),
      skillMarkerFailure: null,
      skillMarkerFailureRecorded: false,
      workerEnvRead: undefined,
      workerEnvFailure: null,
      workerEnvFailureRecorded: false,
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
  const trackedPrKeys = new Set<string>();
  for (const item of items) {
    const ref = item.prUrl === null ? null : parsePullRequestUrl(item.prUrl);
    if (ref !== null) trackedPrKeys.add(prKey(ref));
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
  state.trackedPrKeys = trackedPrKeys;
}

async function discoverPr(
  context: Context,
  item: FactoryWorkItemRef,
  ref: PullRequestRef,
): Promise<void> {
  const { deps } = context;
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
  await recordPrHead(context, ref, pr, item.id);
}

/**
 * PRの今のheadの行を記録し、古いheadの行を整理する。
 * `workItemId`はFactoryのPRなら作業項目のID、人のPRなら`null`である。
 * 新しい行を記録したか、`superseded`の行を`pending`に戻したときに`true`を返す。
 */
async function recordPrHead(
  context: Context,
  ref: PullRequestRef,
  pr: PullRequest,
  workItemId: number | null,
): Promise<boolean> {
  const { deps, counters } = context;
  let added = false;
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
      work_item_id: workItemId,
      run_created_at: null,
    });
    if (inserted) {
      counters.recorded += 1;
      added = true;
    }
  }
  for (const old of plan.supersede) {
    const moved = await deps.transition(old.id, old.from, {
      state: "superseded",
    });
    if (moved) counters.superseded += 1;
  }
  if (plan.reopenId !== null) {
    const reopened = await deps.transition(plan.reopenId, "superseded", {
      state: "pending",
      reopen: true,
    });
    if (reopened) added = true;
  }
  return added;
}

/** 候補の出所。表の候補にだけ、404と403の扱いを足す。 */
type HumanHit = HumanPrCandidate & { readonly origin: "table" | "rest" };

function withOrigin(
  candidates: readonly HumanPrCandidate[],
  origin: HumanHit["origin"],
): HumanHit[] {
  return candidates.map((candidate) => ({ ...candidate, origin }));
}

/** 理由ごとの件数に1を足す。 */
function countReason(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/** 所有者の表の読み取りの結果。 */
type OwnerTable =
  | {
      readonly kind: "read";
      readonly judged: ReadonlyMap<string, GhOwnerRepoJudgement>;
      readonly dbNow: Date;
    }
  | { readonly kind: "failed" }
  | { readonly kind: "deferred" };

/** 1回の発見の途中で持つ状態。 */
type HumanRun = {
  readonly human: PrCiHumanDiscoveryDeps;
  readonly authors: readonly string[];
  readonly found: HumanHit[];
  readonly outOfTime: () => boolean;
  /** RESTの一覧を続けてよいか。rate limitで閉じる。 */
  listOpen: boolean;
  /** 時間の予算で止めたことを、ログに残したか。 */
  stoppedByTime: boolean;
};

/** 時間の予算で止めた段。候補を集める段(表と一覧の読み取り)と、候補のPRを読み直す段である。 */
type HumanStage = "collect_candidates" | "read_prs";

/** 時間の予算で止めたことを、段ごとに1回の発見で1度だけログに残す。 */
function noteStoppedByTime(context: Context, run: HumanRun): void {
  if (run.stoppedByTime) return;
  run.stoppedByTime = true;
  warnStoppedByTime(context, "collect_candidates");
}

function warnStoppedByTime(context: Context, stage: HumanStage): void {
  context.deps.log.warn("pr ci human discovery stopped by the time budget", {
    stage,
  });
}

/**
 * 所有者の全体を表で読み、記録が新しいリポジトリの候補を集める。読めた所有者の判定は返す。
 * 記録が新しくなく、設定でも明示していないリポジトリは、処理せず理由別に数える。失敗にはしない。
 * 収集の停止は鮮度の監視が知らせ、見送った数と理由は結果に出る。
 * 読めなかった所有者は、失敗として記録する。時間の予算が尽きた後の所有者は、読まずに数える。
 */
async function readHumanOwnerTables(
  context: Context,
  run: HumanRun,
  explicitNames: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Map<string, OwnerTable>> {
  const { deps, counters } = context;
  const { human } = run;
  const tables = new Map<string, OwnerTable>();
  if (!human.useTable) return tables;
  for (const scope of human.scopes) {
    const ownerKey = scope.owner.toLowerCase();
    if (run.outOfTime()) {
      noteStoppedByTime(context, run);
      counters.human_deferred += 1;
      tables.set(ownerKey, { kind: "deferred" });
      continue;
    }
    let snapshot: GhOwnerOpenPrSnapshot;
    try {
      snapshot = await human.readOwnerPrs(scope.owner);
    } catch (err) {
      await recordFailureOf(context, `read_gh_owner_prs:${scope.owner}`, err);
      tables.set(ownerKey, { kind: "failed" });
      continue;
    }
    const judged = judgeGhOwnerRepos(scope.owner, snapshot, human.staleAfterMs);
    tables.set(ownerKey, { kind: "read", judged, dbNow: snapshot.db_now });
    const rows = usableTableRows(scope.owner, judged, deps.isRepoAllowed);
    run.found.push(
      ...withOrigin(humanPrCandidatesFromRows(rows, run.authors), "table"),
    );
    for (const reason of skippedStaleReasons(
      scope.owner,
      judged,
      explicitNames.get(ownerKey) ?? new Set(),
      deps.isRepoAllowed,
    )) {
      counters.human_skipped_stale += 1;
      countReason(counters.human_skipped_stale_reasons, reason);
    }
  }
  return tables;
}

/** 明示したリポジトリの読み方。表の行で足りるか、時間切れで読み残すか、理由を付けてRESTの一覧で読むか。 */
type ExplicitRead =
  | { readonly kind: "covered" }
  | { readonly kind: "deferred" }
  | { readonly kind: "list"; readonly reason: string };

/**
 * 所有者の範囲に入らない明示リポジトリを、そのリポジトリの行で読む。`owners`の外の`factory_repo`がこれに当たる。
 * 記録が新しければ、その行から候補を集める。archive済みの印は、記録が鮮度の内にあるときだけ信用して読まない。
 * 古い記録の印は、解除された後も残りうる。
 */
async function readHumanRepoTable(
  context: Context,
  run: HumanRun,
  entry: HumanExplicitRepo,
): Promise<ExplicitRead> {
  const { human } = run;
  if (run.outOfTime()) {
    noteStoppedByTime(context, run);
    return { kind: "deferred" };
  }
  let snapshot: GhRepoOpenPrSnapshot;
  try {
    snapshot = await human.readRepoPrs(entry.owner, entry.repo);
  } catch (err) {
    await recordFailureOf(
      context,
      `read_gh_repo_prs:${entry.owner}/${entry.repo}`,
      err,
    );
    return { kind: "list", reason: "read_failed" };
  }
  if (
    snapshot.repo !== null &&
    isArchivedWithinFreshness(
      { ...snapshot.repo, repo: entry.repo.toLowerCase() },
      snapshot.db_now,
      human.staleAfterMs,
    )
  ) {
    return { kind: "covered" };
  }
  const freshness = judgeGhRepoFreshness(
    snapshot.repo,
    snapshot.prs,
    snapshot.db_now,
    human.staleAfterMs,
  );
  if (freshness.kind === "stale") {
    return { kind: "list", reason: freshness.reason };
  }
  const repoId = snapshot.repo?.repo_id ?? null;
  const rows =
    repoId === null
      ? []
      : usableGhPullRequests(entry.owner, entry.repo, repoId, snapshot.prs);
  run.found.push(
    ...withOrigin(humanPrCandidatesFromRows(rows, run.authors), "table"),
  );
  return { kind: "covered" };
}

/**
 * 明示したリポジトリを、表で足りるか、RESTの一覧で読むかに分ける。
 * 収集が無効のときと、表を読めなかったときは、一覧で読む。明示したリポジトリは、表から外れる道が多く、
 * 読めないままにすると、通知なしに止まるためである。
 * 所有者の表を読めたときは、行が無いか記録が新しくないものを一覧で読む。
 * archive済みの印は、記録が鮮度の内にあるときだけ信用して読まない。
 */
async function planExplicitRead(
  context: Context,
  run: HumanRun,
  tables: ReadonlyMap<string, OwnerTable>,
  entry: HumanExplicitRepo,
): Promise<ExplicitRead> {
  const { human } = run;
  if (!human.useTable) return { kind: "list", reason: "collect_disabled" };
  const table = tables.get(entry.owner.toLowerCase());
  if (table === undefined) return readHumanRepoTable(context, run, entry);
  if (table.kind === "deferred") return { kind: "deferred" };
  if (table.kind === "failed") return { kind: "list", reason: "read_failed" };
  const item = table.judged.get(entry.repo.toLowerCase());
  if (item === undefined) return { kind: "list", reason: "no_record" };
  if (isArchivedWithinFreshness(item.row, table.dbNow, human.staleAfterMs)) {
    return { kind: "covered" };
  }
  if (item.freshness.kind === "stale") {
    return { kind: "list", reason: item.freshness.reason };
  }
  return { kind: "covered" };
}

/**
 * 明示したリポジトリの開いているPRをRESTの一覧で読み、候補を集める。
 * rate limitに拒まれたら、失敗にはせず、以降の一覧を止める。読み残したリポジトリは数える。
 * 時間の予算が尽きた後のリポジトリも、読まずに数える。
 */
async function listHumanRepo(
  context: Context,
  run: HumanRun,
  entry: HumanExplicitRepo,
  reason: string,
): Promise<void> {
  const { deps, counters } = context;
  if (!run.listOpen) {
    counters.human_deferred += 1;
    return;
  }
  if (run.outOfTime()) {
    noteStoppedByTime(context, run);
    counters.human_deferred += 1;
    return;
  }
  counters.human_rest_lists += 1;
  countReason(counters.human_rest_reasons, reason);
  let open: OpenPullRequest[];
  try {
    open = await run.human.listOpenPrs(entry.owner, entry.repo);
  } catch (err) {
    if (err instanceof GitHubRateLimitError) {
      deps.log.warn("pr ci human list stopped by the rate limit", {
        error: errorMessage(err),
      });
      run.listOpen = false;
      counters.human_deferred += 1;
      return;
    }
    await recordFailureOf(
      context,
      `list_open_prs:${entry.owner}/${entry.repo}`,
      err,
    );
    return;
  }
  run.found.push(
    ...withOrigin(
      humanPrCandidatesFromOpenList(entry.owner, entry.repo, open, run.authors),
      "rest",
    ),
  );
}

/** 記録が通す名前か。通さない名前のリポジトリは、読まない。 */
function hasReadableNames(entry: HumanExplicitRepo): boolean {
  try {
    assertGitHubName(entry.owner);
    assertGitHubName(entry.repo);
    return true;
  } catch {
    return false;
  }
}

/**
 * 表から候補にした、作者の分かる候補の数。表の候補どうしの重ねを除き、読む時点の許可を当てた後に数える。
 * 追跡中の除外と、読む数の上限の前に数えるので、1回に読める数とは別に、表の規模を見られる。
 */
function countTableCandidates(
  hits: readonly HumanHit[],
  isAllowed: (owner: string, repo: string) => boolean,
): number {
  const seen = new Set<string>();
  for (const hit of hits) {
    if (hit.origin !== "table" || hit.authorUnknown) continue;
    if (!isAllowed(hit.owner.toLowerCase(), hit.repo.toLowerCase())) continue;
    seen.add(pullRequestKey(hit));
  }
  return seen.size;
}

/**
 * 許可された人が作ったPRの候補を見つけ、見つかったPRの今のheadを記録する。
 * 行の`work_item_id`はNULLにする。追跡対象のFactoryのPRと、Factoryの実装ブランチの形のブランチは記録しない。
 * 候補は次の元から集める。
 * - 収集の表: 照合を通った所有者ごとに全体を読み、リポジトリごとに鮮度を判定して、新しいリポジトリの行だけを候補にする。
 *   新しくなく、設定で明示してもいないリポジトリは、処理せず結果の`human_skipped_stale`に理由別に数える。
 * - RESTの一覧: 設定で明示したリポジトリ(`factory_repo`と`repo_allowlist`の項目)のうち、表が新しくないものを読む。
 *   表を読めなかったとき(失敗として記録する)と、収集が無効のときも読む。
 *   `owners`の外の`factory_repo`は、所有者の表に行が無いので、そのリポジトリの行を読み、新しくなければ一覧で読む。
 *   一覧は作者のログイン名と下書きで候補を絞り、アカウントの種別は読み直した値で確かめる。
 * 一覧がrate limitで拒まれても、全体のrate limitにはせず、残りの一覧を止める。表の候補は読み続ける。
 * 時間の予算が尽きた後の所有者とリポジトリは、読まずに`human_deferred`に数える。
 * 候補は、作者の分かる候補を更新の新しい順に、その後に作者の分からない候補を新しい順に並べて読む。
 * 一覧の候補の並びには、更新の時刻の代わりに作成の時刻を使う。
 * 候補のPRを読んだ応答のリポジトリが候補と違えば記録しない。表の候補の404と403は、通知を作らずにログに残す。
 * FactoryのPRの判定と起動を人のPRの発見が遅らせないよう、起動の後に置き、全体の経過時間と
 * `HUMAN_DISCOVERY_BUDGET_MS`の両方を見る。ここで記録した行の判定は、次の回に行う。
 * 新しく記録した行と、`reopen`した行の数が`HUMAN_PR_LIMIT`に達したら、残りは読まない。
 * 記録済みでheadが動いていないPRは数えない。読む数は`HUMAN_PR_READ_LIMIT`までである。
 * 読んでrate limitに拒まれたら、全体のrate limitにはせず、残りのPRだけを止める。
 * PRは、待たない読み取り(`PrCiHumanDiscoveryDeps.getPr`)で読み、同じ回の判定には再利用しない。
 */
async function discoverHuman(context: Context): Promise<void> {
  const { deps, state } = context;
  const human = deps.humanDiscovery;
  const trackedPrKeys = state.trackedPrKeys;
  if (human === undefined || trackedPrKeys === null) return;
  if (state.rateLimited || overBudget(context)) return;
  context.counters.human_collect_disabled = !human.useTable;
  const startedAt = deps.now().getTime();
  const outOfTime = (): boolean =>
    overBudget(context) ||
    deps.now().getTime() - startedAt >= HUMAN_DISCOVERY_BUDGET_MS;

  const run: HumanRun = {
    human,
    authors: humanPrAuthors(human.policy),
    found: [],
    outOfTime,
    listOpen: true,
    stoppedByTime: false,
  };
  const found = run.found;
  // 設定で明示したリポジトリのうち、読む時点で許されるもの。許されないものは表にも一覧にも使わない。
  const explicit = human.explicitRepos.filter((entry) =>
    deps.isRepoAllowed(entry.owner.toLowerCase(), entry.repo.toLowerCase()),
  );
  const explicitNames = new Map<string, Set<string>>();
  for (const entry of explicit) {
    const ownerKey = entry.owner.toLowerCase();
    const names = explicitNames.get(ownerKey) ?? new Set<string>();
    names.add(entry.repo.toLowerCase());
    explicitNames.set(ownerKey, names);
  }
  const tables = await readHumanOwnerTables(context, run, explicitNames);
  for (const entry of explicit.filter(hasReadableNames)) {
    const plan = await planExplicitRead(context, run, tables, entry);
    if (plan.kind === "deferred") {
      context.counters.human_deferred += 1;
    } else if (plan.kind === "list") {
      await listHumanRepo(context, run, entry, plan.reason);
    }
  }
  // 作者の分からない候補は末尾に回す。作者を確かめられた候補が、読む枠を先に使えるようにするためである。
  const newestFirst = (a: HumanHit, b: HumanHit): number =>
    b.updatedAtMs - a.updatedAtMs;
  const ordered = [
    ...found.filter((hit) => !hit.authorUnknown).sort(newestFirst),
    ...found.filter((hit) => hit.authorUnknown).sort(newestFirst),
  ];
  context.counters.human_table_candidates = countTableCandidates(
    ordered,
    deps.isRepoAllowed,
  );

  const seen = new Set<string>();
  let reads = 0;
  let added = 0;
  // 時間の予算かrate limitで読み残した候補を、読み残した数に足す。
  // 数と上限で読まなかった候補は、意図した上限なので足さない。重ねと追跡中のPRは、読まない候補なので足さない。
  const leftUnread = (from: number): void => {
    const unread = new Set<string>();
    for (const rest of ordered.slice(from)) {
      const key = pullRequestKey(rest);
      if (!seen.has(key) && !trackedPrKeys.has(key)) unread.add(key);
    }
    context.counters.human_deferred += unread.size;
  };
  for (const [index, hit] of ordered.entries()) {
    if (added >= HUMAN_PR_LIMIT || reads >= HUMAN_PR_READ_LIMIT) break;
    if (state.rateLimited || outOfTime()) {
      warnStoppedByTime(context, "read_prs");
      leftUnread(index);
      break;
    }
    const ref: PullRequestRef = {
      owner: hit.owner.toLowerCase(),
      repo: hit.repo.toLowerCase(),
      number: hit.number,
    };
    const key = prKey(ref);
    if (seen.has(key) || trackedPrKeys.has(key)) continue;
    seen.add(key);
    if (!deps.isRepoAllowed(ref.owner, ref.repo)) continue;
    try {
      assertGitHubName(ref.owner);
      assertGitHubName(ref.repo);
    } catch {
      deps.log.warn("pr ci skipped a repository whose name is not supported", {
        repo: repoKey(ref),
        pr: ref.number,
      });
      continue;
    }
    reads += 1;
    try {
      const pr = await human.getPr(ref.owner, ref.repo, ref.number);
      // 名前の付け替えや移管の途中で、別のリポジトリのPRを記録しない。
      if (pr.baseRepoFullName.toLowerCase() !== `${ref.owner}/${ref.repo}`) {
        deps.log.warn(
          "pr ci skipped a candidate that belongs to another repository",
          { repo: repoKey(ref), pr: ref.number },
        );
        continue;
      }
      const author = {
        login: pr.authorLogin,
        id: pr.authorId,
        type: pr.authorType,
      };
      if (
        !isAllowedPrAuthor(author, human.policy) ||
        !isHumanPrCandidate({ pr, ref, trackedPrKeys })
      ) {
        continue;
      }
      if (await recordPrHead(context, ref, pr, null)) added += 1;
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        deps.log.warn("pr ci human discovery stopped by the rate limit", {
          stage: "read_prs",
          error: errorMessage(err),
        });
        // 読もうとして拒まれた候補も、読み残した数に入れる。
        seen.delete(key);
        leftUnread(index);
        break;
      }
      // 収集の読み取りトークンに見えて、書き込みのPATに見えないリポジトリがありうる。
      // 表の候補の404と403は、PATの権限の不足を示すとは限らないので、通知を作らずにログに残すだけにする。
      // RESTの一覧の候補は、PATが一覧を読めたリポジトリのものなので、読めなければ通知にする。
      if (
        hit.origin === "table" &&
        err instanceof GitHubHttpError &&
        (err.status === 404 || err.status === 403)
      ) {
        deps.log.warn(
          "pr ci skipped a table candidate that could not be read",
          {
            repo: repoKey(ref),
            pr: ref.number,
          },
        );
        continue;
      }
      if ((await absorbReadError(context, ref, err)) === null) {
        await recordFailureOf(context, `discover_human_pr:${key}`, err);
      }
    }
  }
  deps.log.info("pr ci human discovery finished", {
    found: found.length,
    reads,
    added,
  });
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

/**
 * 解けるのを待たない保留か。この保留を書く行は、先に出した「待つ」の通知の後でも、
 * 改めて「人が直す」と通知する必要があるので、通知した理由を空に戻す。
 */
function isDeterministicHold(reason: PrCiFixHoldReason): boolean {
  return !prCiFixHoldInfo(reason).temporary;
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
    ...(decision.hold !== null && isDeterministicHold(decision.hold)
      ? { resetNotified: true }
      : {}),
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

/**
 * 読み直す行の並びを決める。FactoryのPRの行は、順序を変えずに先に置く。
 * 人の行(`work_item_id`が空)は後ろに置き、読み直していない順に`HUMAN_RECHECK_LIMIT`件までにする。
 * 超えた分は何も書き換えないので、次の回の先頭に残る。読んだ行は`checked_at`が進むため、全員が順に回る。
 * 人の行がFactoryのPRの行の判定の時間と、PATのcoreの枠を食わないための上限である。
 */
function orderRowsForRecheck(
  rows: readonly PrCiCheck[],
  log: Logger,
): PrCiCheck[] {
  const factoryRows = rows.filter((row) => row.work_item_id !== null);
  const humanRows = rows
    .filter((row) => row.work_item_id === null)
    .sort(
      (a, b) => a.checked_at.getTime() - b.checked_at.getTime() || a.id - b.id,
    );
  if (humanRows.length > HUMAN_RECHECK_LIMIT) {
    log.warn("pr ci human rows are left to the next run", {
      left: humanRows.length - HUMAN_RECHECK_LIMIT,
    });
  }
  return [...factoryRows, ...humanRows.slice(0, HUMAN_RECHECK_LIMIT)];
}

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
    rows = orderRowsForRecheck([...pending, ...failed, ...noCi], deps.log);
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

/**
 * 人のPRの行に限り、同じPRの古いheadの失敗のnoticeを解決する。
 * 人のPRは、直された後も新しいheadで失敗が続くことがあり、古いheadのnoticeが残ると、
 * 1つのPRに未解決のnoticeが重なる。FactoryのPRの行は変えない。
 * 今のheadのnoticeは解決しない。通知をやり直した回に、同じ本文が重複と見なされ、Discordが重ならないためである。
 * 古いheadは、そのPRの記録済みの行から求める。解決は冪等なので、通知の登録より先に行う。
 * 解決に失敗しても、失敗を記録して通知へ進む。
 */
async function resolveOlderHeadNotices(
  context: Context,
  row: PrCiCheck,
): Promise<void> {
  if (row.work_item_id !== null) return;
  const { deps } = context;
  try {
    const rows = await deps.listRowsForPr(row.owner, row.repo, row.pr_number);
    // 先頭7文字が今のheadと同じheadは除く。本文は先頭7文字で表すので、今のheadのnoticeに当たるためである。
    const currentShort = shortSha(row.head_sha);
    const olderHeads = new Set(
      rows
        .map((other) => other.head_sha)
        .filter((sha) => shortSha(sha) !== currentShort),
    );
    for (const sha of olderHeads) {
      await deps.resolveNotices(
        PR_CI_FAILED_KIND,
        prCiHeadNoticePrefix(row.owner, row.repo, row.pr_number, sha),
        PR_CI_RESOLVED_BY,
      );
    }
  } catch (err) {
    // 古いnoticeが残るだけなので、新しい失敗の通知は止めない。
    await recordFailureOf(
      context,
      `resolve_older_notices:${prKey(rowRef(row))}`,
      err,
    );
  }
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
  if (
    defersFailureNotice({
      reason,
      firstSeenAt: row.first_seen_at,
      policy: notifyPolicyFor(row, deps.notifyPolicy),
    })
  ) {
    // 自動で直す対象の失敗は、状態だけを`failed`にする。通知は、直せるかが決まってから`notifyDeferred`が出す。
    const moved = await deps.transition(row.id, row.state, {
      state: "failed",
      summary: prCiSummary(runs),
      ...extra,
    });
    if (!moved) return;
    counters.failed += 1;
    deps.log.warn("pr ci failed; the notice is held for the automatic fix", {
      repo: repoKey(ref),
      pr: ref.number,
      sha: row.head_sha,
      reason,
    });
    return;
  }
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
  await resolveOlderHeadNotices(context, row);
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
// 保留した失敗の通知
// ---------------------------------------------------------------------------

/**
 * 失敗に確定して、まだ通知していない行のうち、いま通知してよいものを通知する。
 * 行の今の状態だけで決める(`decideDeferredNotice`)。設定やGitHubの読み取りの結果に頼らないので、
 * 監視が無効でも、予算が尽きても動く。
 * 通知の登録、Discord、通知した理由の記録の順に行う。登録が先なのは、記録が先に成功して登録が失敗すると、
 * 通知が永久に出ないためである。記録に失敗した回は、次の回に同じ手順をやり直し、重複は通知の索引が防ぐ。
 * 1回の実行で最初の1件は、予算を見ずに通知する。予算切れが続いても、通知が飢えないためである。
 */
async function notifyDeferred(context: Context): Promise<void> {
  const { deps } = context;
  await resolveConfigMisfitNotice(context);
  let rows: PrCiCheck[];
  try {
    rows = await deps.listUnnotifiedFailed(DEFERRED_NOTICE_BATCH_LIMIT);
  } catch (err) {
    await recordFailureOf(context, "list_unnotified", err);
    return;
  }
  let started = 0;
  for (const [index, row] of rows.entries()) {
    // 通知した理由コードが空でない行は、確定した時点で通知した行である。
    // `ci_other_conclusion`で通知した行を、`ci_failure`として通知し直さないために除く。
    // 一覧のSQLも同じ条件で絞るので、ここは一覧の契約が崩れたときの二重の防御である。
    if (
      row.notified_reason !== null ||
      !deps.isRepoConfigured(row.owner, row.repo)
    ) {
      continue;
    }
    const decision = decideDeferredNotice({
      row: {
        fixHoldReason: row.fix_hold_reason,
        firstSeenAt: row.first_seen_at,
        updatedAt: row.updated_at,
      },
      policy: notifyPolicyFor(row, deps.notifyPolicy),
      now: context.now,
    });
    if (decision.kind === "wait") continue;
    // 設定が収まった後に残った保留は、通知しない。保留を外す更新が失敗した回に残りうる。次の回に外れる。
    if (
      decision.hold === "config_misfit" &&
      (deps.claim === undefined || deps.claim.configMisfit === null)
    ) {
      continue;
    }
    if (started > 0 && overBudget(context)) {
      deps.log.warn("pr ci deferred notices stopped by the time budget", {
        left: rows.length - index,
      });
      break;
    }
    started += 1;
    try {
      await sendDeferredNotice(context, row, decision.hold, decision.discord);
    } catch (err) {
      await recordFailureOf(
        context,
        `notify_deferred:${prKey(rowRef(row))}`,
        err,
      );
    }
  }
}

/**
 * 時間設定が収まったか、起動する設定でなくなったときに、設定全体の不整合を解消する。
 * 起動の依存(`claim`)は、監視と自動修正が有効なときだけ渡るので、無いときは起動しない設定である。
 * 設定の不整合は起動の前に確かめるので、設定を直せば解消してよい。
 * 先に、保留の理由が`config_misfit`の行の保留と通知した理由を外し、その後にnoticeを解決する。
 * 巡回の枠から外れたPRの行は、起動の判断で保留を外されない。ここで外さないと、noticeだけが消えて、
 * 保留と通知済みの印が残る。外した行は、巡回の枠に入れば次の起動の判断で決め直され、
 * 枠の外なら、保留の理由なしの通知(`UNHELD_FAILURE_NOTICE_AFTER_MS`)で知らせ直される。
 * 保留を外せなかった回は、noticeを残す。残るだけで、次の回に同じ手順をやり直す。
 * 解決は冪等で、失敗しても通知は止めない。
 */
async function resolveConfigMisfitNotice(context: Context): Promise<void> {
  const { deps } = context;
  if (deps.claim !== undefined && deps.claim.configMisfit !== null) return;
  try {
    await deps.releaseConfigMisfitHolds();
  } catch (err) {
    await recordFailureOf(context, "release_config_misfit_holds", err);
    return;
  }
  try {
    await deps.resolveNotices(CONFIG_MISFIT_KIND, "", PR_CI_RESOLVED_BY);
  } catch (err) {
    await recordFailureOf(context, "resolve_config_misfit", err);
  }
}

async function sendDeferredNotice(
  context: Context,
  row: PrCiCheck,
  hold: PrCiFixHoldReason | null,
  discord: boolean,
): Promise<void> {
  const { deps, counters } = context;
  const ref = rowRef(row);
  const link = pullRequestPageUrl(ref.owner, ref.repo, ref.number);
  // 通知を遅らせるのは、`ci_failure`の行だけである(`defersFailureNotice`)。
  // `ci_other_conclusion`の行は確定した時点で通知し、理由コードを記録するので、通常はここに来ない。
  // 確定時の記録だけが失敗した行は来うる。その限界は`docs/internals/pr-ci.md`に書いてある。
  // 理由コードを行から読み直さず固定するのは、この前提に立つためである。
  const reason = "ci_failure";
  const message = prCiFailedNoticeMessage({
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.number,
    headSha: row.head_sha,
    link,
    reason,
    ...(hold === null ? {} : { hold }),
  });
  // 時間設定の不整合は設定全体の誤りなので、PRごとのnoticeにせず、設定全体で1件のnoticeにまとめる。
  // Discordは、そのnoticeを新しく残した回の行のPRを宛先にして、1回だけ送る。
  const wholeConfig = hold === "config_misfit";
  if (!wholeConfig) await resolveOlderHeadNotices(context, row);
  const noticeId = await deps.addNotice(
    wholeConfig
      ? { kind: CONFIG_MISFIT_KIND, message: configMisfitNoticeMessage() }
      : { kind: PR_CI_FAILED_KIND, message },
  );
  if (noticeId !== null && discord) {
    const sent = await deps.notify({
      kind: "needs_human",
      instance_name: deps.instanceName,
      owner: ref.owner,
      repo: ref.repo,
      url: link,
      reason: hold === null ? reason : `${reason}(自動修正の保留: ${hold})`,
      target: { kind: "pr", number: ref.number },
      next_action:
        hold === null
          ? prCiNextAction(reason)
          : prCiFixHoldInfo(hold).nextAction,
    });
    if (sent.status === "not_sent") {
      deps.log.warn("pr ci deferred notice was not delivered", {
        repo: repoKey(ref),
        pr: ref.number,
        sha: row.head_sha,
        notice_id: noticeId,
        reason: sent.reason,
      });
    }
  }
  await deps.markNotified(row.id, reason);
  counters.notified += 1;
  deps.log.warn("pr ci failure notified after the automatic fix was decided", {
    repo: repoKey(ref),
    pr: ref.number,
    sha: row.head_sha,
    hold,
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
  if (err instanceof WorkerEnvReadError) {
    if (!state.workerEnvFailureRecorded) {
      state.workerEnvFailureRecorded = true;
      await recordFailureOf(context, "worker_env", err);
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

/**
 * workerの環境が前提を満たさない保留の理由を、この回で1回だけ読む。満たすときは`null`。
 * 読めなければ、以後の行も同じ失敗にする。パスの列挙に費用がかかるので、行ごとに読み直さない。
 * 問題があれば、パスを含むメッセージを警告ログに1回だけ残す。
 */
async function readWorkerEnv(
  context: Context,
  claim: PrCiClaimDeps,
): Promise<WorkerEnvHoldReason | null> {
  const { state, deps } = context;
  if (state.workerEnvFailure !== null) throw state.workerEnvFailure;
  if (state.workerEnvRead !== undefined) return state.workerEnvRead.reason;
  try {
    const problem = await claim.workerEnvProblem();
    state.workerEnvRead = { reason: problem?.reason ?? null };
    if (problem !== null) {
      deps.log.warn("pr ci claim held by the worker environment", {
        reason: problem.reason,
        problem: problem.message,
      });
    }
    return state.workerEnvRead.reason;
  } catch (err) {
    state.workerEnvFailure = new WorkerEnvReadError(err);
    throw state.workerEnvFailure;
  }
}

/** 起動の判断が読む事実を、この行について組む。回の中で変わらない事実は、回の間で共有する。 */
function claimReaders(
  context: Context,
  claim: PrCiClaimDeps,
  row: PrCiCheck,
  ref: PullRequestRef,
  names: { owner: string; repo: string },
  headRef: string,
): FixClaimReaders {
  const { deps } = context;
  const repo = repoKey(ref);
  return {
    hasActiveFix: () =>
      claim.hasActiveFix(names.owner, names.repo, row.pr_number),
    hasReview: () =>
      claim.hasReview(row.owner, row.repo, row.pr_number, row.head_sha),
    readPr: () => readPr(context, ref),
    readBranchItemStatus: () =>
      claim.readBranchItemStatus(names.owner, names.repo, headRef),
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
    workerEnv: () => readWorkerEnv(context, claim),
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
  if (snapshot === undefined || names === null) {
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
    configMisfit: claim.configMisfit,
    readers: claimReaders(context, claim, row, ref, names, snapshot.headRef),
  });
  if (decision.kind === "skip") {
    if (decision.why === "branch_held") {
      deps.log.info("pr ci fix waits while the factory holds the branch", {
        repo: repoKey(row),
        pr: row.pr_number,
      });
    }
    await touchSafely(context, row);
    return;
  }
  if (decision.kind === "hold") {
    if (row.fix_hold_reason !== decision.reason) {
      if (
        await claim.setHold(
          row.id,
          decision.reason,
          row.fix_hold_reason,
          // 確定時に「人が直す」と知らせた行は、同じ保留に着くだけなので戻さない。
          isDeterministicHold(decision.reason) &&
            row.notified_reason !== "ci_other_conclusion",
        )
      ) {
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
    !(await claim.setHold(row.id, null, row.fix_hold_reason, false))
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
