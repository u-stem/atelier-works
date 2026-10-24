// 10分ごとに、dependabotが開いたPRを探し、自動でマージできるかをフローと同じ収集とゲートで評価する。
// 通ったPRだけ作業項目を`picked`で作り、フロー`f/factory/dependabot`を起動する。
// 待つ間は作業項目を作らない。人に回すと決めたPRは、作業項目を作ってすぐ`needs_human`で終え、1回だけ通知する。
// リポジトリにマージの保留があるときと、保留を読めないときも、作業項目を作らずに待つ。影響調査(Claudeの実行)も走らせない。
// 保留が解けるか読めるようになれば、次の取得で自動で再開する。待ったPRの数は、周回ごとに1件の通知にまとめる。
// `dependabot_enabled`が偽なら、GitHubにもDBにも触れずに終える。
// 対象のリポジトリは`factory_repo`と`repo_allowlist`に明示したものだけで、オーナーの全リポジトリは見ない。
// 候補の列挙は、収集が有効なときは収集の表から読む。
// 表を使えないリポジトリ(記録が古い、行が無い、読めないなど)は、RESTの開いているPRの一覧で読む。
// 表でarchive済みと分かり、記録が鮮度の内にあるリポジトリは、マージできないので読まない。
// 表と一覧の値は候補を絞ることにだけ使い、マージに至る判断は、PRごとにRESTで読み直した値と収集の事実で行う。
//
// 判断は`processDependabotPr`と`pollDependabot`にあり、`main`は入出力をつなぐだけである。
// 1件のPRの失敗では例外を投げず、失敗を記録して次のPRへ進む。
// GitHubのレート制限に当たったら、その周回の残りを調べず、解除の時刻まで周回を飛ばす。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  defaultSqlClient,
  dependabotGateWaitingCancels,
  hasDependabotItemForHead,
  insertDependabotWorkItemUnlessActive,
  listActive,
  type NewDependabotWorkItem,
  readGhRepoOpenPullRequests,
  recordFailure,
  resolveUnresolvedNoticesByPrefix,
  setFlowJobId,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import {
  buildCollectDeps,
  type CollectResult,
  collectGateInput,
} from "./lib/dependabot_collect.ts";
import {
  classifyMergeHolds,
  DEPENDABOT_FLOW_PATH,
  dependabotReason,
  type MergeHoldCheck,
  type MergeHoldFailure,
  sanitizeUntrustedProse,
} from "./lib/dependabot_flow_support.ts";
import {
  evaluateGateGroup,
  type GateCommon,
  type GateTargetFacts,
  isPublishedLongEnough,
  resolveRepoPolicy,
} from "./lib/dependabot_support.ts";
import { type NotifyEvent, notifyBestEffort } from "./lib/discord.ts";
import {
  type GhRepoStaleReason,
  ghDetailStaleAfterMs,
  judgeGhRepoFreshness,
  usableGhPullRequests,
} from "./lib/gh_collect_read.ts";
import {
  type GhClient,
  GitHubRateLimitError,
  getAccountId,
  getPrWithCreatedAt,
  getViewer,
  listOpenPullRequests,
  type OpenPullRequest,
  type PullRequestWithCreatedAt,
} from "./lib/github.ts";
import {
  type HoldReadOutcome,
  type HoldRow,
  listActiveHolds,
} from "./lib/holds.ts";
import { parseFlowJobId } from "./lib/implement_launch_support.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import { isCommitSha } from "./lib/main_ci_support.ts";
import { listMainCiTargets } from "./lib/main_ci_watch.ts";
import {
  filterByRepoAllowlist,
  filterVerifiedOwners,
} from "./lib/poll_support.ts";
import {
  type RepoOwnerGateResult,
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "./lib/repo_owner_gate.ts";
import {
  type FactoryConfig,
  type FactoryOwner,
  type GhPullRequest,
  type GhRepoOpenPrSnapshot,
  isGitHubName,
  type WorkItem,
} from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";
import { describeReason, nextActionFor } from "./steps/pr_workflow_support.ts";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** 対象にするPRの作者。ゲートも同じ作者を求める。 */
const DEPENDABOT_AUTHOR_LOGIN = "dependabot[bot]";

/** 対象にするPRのbase。収集も同じブランチを求める。 */
const DEPENDABOT_BASE_REF = "main";

/** アプリのPRの作者のloginの末尾。RESTは付けて返し、収集の表は付けずに保存する。 */
const BOT_LOGIN_SUFFIX = "[bot]";

/**
 * 待ちの上限を、公開の日数(`dependabot_min_published_days`)に足す日数。
 * 待ちの起点から、公開の日数にこの日数を足した時間を超えて待ちが続けば、人に回す。
 * 必須のチェックの失敗の放置やレート制限の連続で、いつまでも黙って待たないためである。
 */
export const WAIT_LIMIT_EXTRA_DAYS = 7;

/**
 * 公開の日数のほかの待ち(チェックの未完了、マージできるかの計算中など)で、次に確かめるまでの間(ミリ秒)。
 * 同じheadで続けて待った回数で選び、最後の値を上限にする。目安は次の周回、30分後、60分後である。
 * 周期10分の実行時刻のずれで1周多く飛ばさないよう、それぞれ1分短くする。
 */
export const WAIT_BACKOFF_MS: readonly number[] = Object.freeze([
  9 * MINUTE_MS,
  29 * MINUTE_MS,
  59 * MINUTE_MS,
]);

/** レート制限が解除の時刻を示さなかったときに、周回を飛ばす時間(ミリ秒)。 */
export const RATE_LIMIT_DEFAULT_PAUSE_MS = 15 * MINUTE_MS;

/**
 * フローが待ちで止まった後に、同じheadのフローを起動し直すまでの間(ミリ秒)。
 * 取得の評価が通っても、フローの側の収集が待ちを返すことがある(レート制限、チェックの再実行など)。
 * そのたびに周回ごとにフローを起動しないよう、間を置く。
 */
export const FLOW_WAIT_COOLDOWN_MS = 60 * MINUTE_MS;

/** 同じheadで、フローが待ちで止まった回数がこれに達したら、人に回す。 */
export const MAX_FLOW_GATE_WAITS = 3;

/**
 * 作業項目の保持期間(`retention_work_items_days`)から差し引く余裕(日)。
 * 作業項目の行は、PRより後に作られるので、行が消えうるのは、作ってから保持期間を過ぎたPRだけである。
 * 時計のずれと掃除の時刻の差を見込み、1日早めに扱う。
 */
const RETENTION_MARGIN_DAYS = 1;

/** 通知に載せる理由の上限。 */
const NOTIFY_REASON_MAX_CHARS = 1_000;

/** 何もしなかったときの理由。 */
export const DEPENDABOT_SKIP_REASON = {
  /** 同じPRに終端でないpr_reviewかpr_fixがある。人が頼んだ作業を先にする。 */
  prWorkflowActive: "a review or a fix of the pull request is active",
  /** 同じPRに終端でないdependabotの作業項目がある。フローが動いている。 */
  dependabotActive: "a dependabot work item of the pull request is active",
  /** 閉じた、draft、base、作者のどれかで対象でない。 */
  notTarget: "the pull request is not a target",
  /** 候補の名前と、GitHubが返したbaseのリポジトリの名前が合わない。改名か移管の疑いがある。 */
  repoMismatch: "the pull request belongs to another repository name",
  /** 閉じているかマージされている。 */
  notOpen: "the pull request is not open",
  /** headが完全なshaでない。 */
  headNotSha: "the head is not a full sha",
  /** 同じheadを処理済み。 */
  headHandled: "the head was already handled",
  /** フローが待ちで止まった直後。 */
  flowWaitCooldown: "the flow stopped to wait for this head recently",
  /** 待っているheadの、次に確かめる時刻の前。 */
  throttled: "the head is waiting until its next check",
  /** ほかの取得が先に作業項目を作った。 */
  insertLost: "another poll created the work item first",
} as const;

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${String(number)}`.toLowerCase();
}

/** 待ちの記録のキー。headごとに分け、新しいheadは前のheadの待ちを引き継がない。 */
export function headWaitKey(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
): string {
  return `${prKey(owner, repo, number)}@${headSha}`;
}

/** PRのキー(`owner/repo#番号`)から、リポジトリの部分を取り出す。 */
function repoPartOf(prPart: string): string {
  const hash = prPart.lastIndexOf("#");
  return hash < 0 ? prPart : prPart.slice(0, hash);
}

/** 待ちの記録のキーから、PRの部分を取り出す。 */
function prPartOf(key: string): string {
  const at = key.lastIndexOf("@");
  return at < 0 ? key : key.slice(0, at);
}

// ---- 1件のPR ----

/** 評価する候補のPR。`createdAtMs`は並びにだけ使い、処理には使わない。 */
export type DependabotPrCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** PRを作った時刻(epochミリ秒)。 */
  readonly createdAtMs: number;
};

/** 同じheadの待ちの記録。 */
export type HeadWaitState = {
  /** このheadで初めて待ちを見た時刻。待ちの上限の起点の1つ。 */
  readonly firstWaitAtMs: number;
  /** このheadで続けて待った回数。 */
  readonly waitCount: number;
  /** 次に評価する時刻。これより前の周回では評価しない。 */
  readonly nextCheckAtMs: number;
};

/** `processDependabotPr`が使うI/O。テストでは偽物に差し替える。 */
export type PollDependabotDeps = {
  /** PRを読む。作成の時刻(`createdAtMs`)はRESTの値で、保持期間と待ちの上限の判定に使う。 */
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequestWithCreatedAt>;
  readonly hasItemForHead: (
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
  ) => Promise<boolean>;
  readonly gateWaitingCancels: (
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
  ) => Promise<{ readonly count: number; readonly lastAt: Date | null }>;
  /**
   * リポジトリのマージの保留を読む(`listActiveHolds`)。
   * PRごとに呼ぶ。読めないときは失敗を返すか例外を投げ、呼び出し側は保留なしとは扱わない。
   */
  readonly listMergeHolds: (
    owner: string,
    repo: string,
  ) => Promise<HoldReadOutcome<readonly HoldRow[]>>;
  /** フローの準備と同じ収集(`collectGateInput`)。 */
  readonly collect: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<CollectResult>;
  /**
   * リポジトリのオーナーと`factory_repo_id`の照合(`verifyRepoOwnerId`)。
   * 作業項目を作る前に呼ぶ。落ちたときは関門がnoticeを残し、理由を返す。
   */
  readonly checkRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<RepoOwnerGateResult>;
  readonly insertItem: (item: NewDependabotWorkItem) => Promise<number | null>;
  readonly updateStatus: (
    id: number,
    from: "picked",
    to: "needs_human" | "failed",
    note: string,
  ) => Promise<boolean>;
  /** フローを起動し、ジョブのIDを返す。IDでない応答は例外にする。 */
  readonly startFlow: (workItemId: number) => Promise<string>;
  readonly setFlowJobId: (id: number, jobId: string) => Promise<void>;
  readonly notify: (event: NotifyEvent) => Promise<void>;
  readonly recordFailure: (
    step: string,
    err: unknown,
    workItemId: number | null,
  ) => Promise<void>;
};

export type PollDependabotContext = {
  readonly nowMs: number;
  readonly instanceName: string;
  readonly viewerLogin: string;
  readonly minPublishedDays: number;
  /** `dependabot_group_enabled`。偽なら、2つ以上のパッケージが変わるPRをゲートが止める。 */
  readonly allowGroups: boolean;
  readonly retentionDays: number;
  /** このPRの終端でない作業項目。 */
  readonly activeForPr: readonly Pick<WorkItem, "kind">[];
  /** 前の周回までの待ちの記録(`headWaitKey`がキー)。 */
  readonly waits: ReadonlyMap<string, HeadWaitState>;
};

export type DependabotPollOutcome =
  | { readonly kind: "started"; readonly workItemId: number }
  | {
      readonly kind: "escalated";
      readonly workItemId: number;
      readonly note: string;
    }
  | {
      readonly kind: "failed";
      readonly workItemId: number;
      readonly note: string;
    }
  | {
      readonly kind: "waiting";
      readonly reason: string;
      /** 待っているheadの記録のキー(`headWaitKey`)。 */
      readonly key: string;
      /** 次の周回へ引き継ぐ待ちの記録。 */
      readonly wait: HeadWaitState;
    }
  | {
      /** マージの保留があるか、保留を読めないので、作業項目を作らずに待つ。待ちの記録は変えない。 */
      readonly kind: "held";
      readonly check: Exclude<MergeHoldCheck, { kind: "clear" }>;
    }
  | { readonly kind: "skipped"; readonly reason: string };

/** 処理済みの記録が保持期間で消えたかもしれないほど、PRが古いか。 */
function olderThanRetention(
  createdAtMs: number,
  nowMs: number,
  retentionDays: number,
): boolean {
  const days = Math.max(0, retentionDays - RETENTION_MARGIN_DAYS);
  return nowMs - createdAtMs >= days * DAY_MS;
}

/** 続けて待った回数から、次に確かめるまでの間を選ぶ。 */
function backoffFor(waitCount: number): number {
  const index = Math.min(Math.max(waitCount, 1), WAIT_BACKOFF_MS.length) - 1;
  return WAIT_BACKOFF_MS[index] ?? RATE_LIMIT_DEFAULT_PAUSE_MS;
}

function prUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${String(number)}`;
}

/** 失敗の記録の段の名前。リポジトリの大小文字が経路によって違っても、同じ名前にそろえる。 */
function stepName(
  stage: string,
  owner: string,
  repo: string,
  suffix = "",
): string {
  return `${stage}:${owner}/${repo}${suffix}`.toLowerCase();
}

/**
 * `owner/repo`の形のリポジトリ名を分ける。
 * 2つの部分のどちらかがGitHubの名前の形でないとき、または形が違うときは`null`。
 */
function splitRepoFullName(
  fullName: string,
): { owner: string; repo: string } | null {
  const parts = fullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !isGitHubName(owner) || !isGitHubName(repo)) {
    return null;
  }
  return { owner, repo };
}

function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * 公開の日数が足りない対象のうち、最も遅く足りる時刻(公開日+最小日数、ミリ秒)を返す。
 * 全対象が足りるときと、足りない対象の公開日が読めないときは`null`を返し、間引きの間隔に任せる。
 * ゲートは読めない公開日を止めるので、後者は通常起きない。読める日付だけで時刻を決めて確認を遅らせないための備えである。
 */
function nextPublishCheckAtMs(
  targets: readonly Pick<GateTargetFacts, "publishedAtIso">[],
  common: Pick<GateCommon, "nowMs" | "minPublishedDays">,
): number | null {
  let latest: number | null = null;
  for (const { publishedAtIso } of targets) {
    if (
      isPublishedLongEnough(
        publishedAtIso,
        common.nowMs,
        common.minPublishedDays,
      )
    ) {
      continue;
    }
    const publishedMs = Date.parse(publishedAtIso);
    if (!Number.isFinite(publishedMs)) return null;
    const checkAtMs = publishedMs + common.minPublishedDays * DAY_MS;
    latest = latest === null ? checkAtMs : Math.max(latest, checkAtMs);
  }
  return latest;
}

/**
 * dependabotのPR1件を評価し、フローを起動するか、人に回すか、待つかを決めて実行する。
 * 手順は次のとおり。
 * 1. 同じPRに終端でないpr_reviewかpr_fixがあれば、何もしない。人が頼んだ作業を先にする。
 *    終端でないdependabotの作業項目があれば、フローが動いているので何もしない。
 * 2. PRを読み、baseのリポジトリの名前が候補と大小文字を除いて同じで、開いた、draftでない、baseが`main`、作者が`dependabot[bot]`、headが完全なshaのものだけを続ける。
 *    以後の処理には、GitHubが返したリポジトリの名前とPRの作成の時刻を使う。候補の値は並びにだけ使う。
 * 3. そのheadを処理済み(`hasDependabotItemForHead`)なら、何もしない。
 * 4. 待っているheadは、次に確かめる時刻まで評価しない。
 *    その後、リポジトリにマージの保留があるか、保留を読めなければ、作業項目を作らずに待つ(`held`)。待ちの記録は変えない。
 * 5. PRを作ってから保持期間に近いほど時間がたっていれば、処理済みの記録が消えたかもしれないので、人に回す。
 * 6. 同じheadでフローが待ちで止まった回数が上限に達していれば人に回し、直後なら起動を見送る。
 * 7. フローの準備と同じ収集(`collectGateInput`)とゲート(`evaluateGateGroup`)で評価する。
 *    通ればフローを起動し、止まれば人に回し、待ちなら作業項目を作らない。
 *    マージできない(競合)は、dependabotがrebaseで直しうるので待ちとして扱う。
 *    待ちの起点(PRを作った時刻と、そのheadで初めて待ちを見た時刻の遅い方)から上限を超えたら、人に回す。
 * 作業項目を作る前に、リポジトリのオーナーと`factory_repo_id`を照合する。落ちたら、その理由で人に回す。
 * 人に回すときと起動するときは、作業項目を`picked`で作る。部分一意インデックスが同じPRの2件目を拒むので、
 * 作れなかったときは、ほかの取得が先に始めたものとして何もしない。
 * 人に回すときは、すぐに`needs_human`へ移し、移せたときだけ通知する。
 * 起動に失敗したときは、行を`failed`にし、失敗を記録して、移せたときだけ通知する。
 * PRの読み取りなど、ここで分類しない失敗は例外のまま投げる。
 */
export async function processDependabotPr(
  deps: PollDependabotDeps,
  ctx: PollDependabotContext,
  found: DependabotPrCandidate,
): Promise<DependabotPollOutcome> {
  const { number } = found;
  const skipped = (reason: string): DependabotPollOutcome => ({
    kind: "skipped",
    reason,
  });

  if (
    ctx.activeForPr.some(
      (item) => item.kind === "pr_review" || item.kind === "pr_fix",
    )
  ) {
    return skipped(DEPENDABOT_SKIP_REASON.prWorkflowActive);
  }
  if (ctx.activeForPr.some((item) => item.kind === "dependabot")) {
    return skipped(DEPENDABOT_SKIP_REASON.dependabotActive);
  }

  const pr = await deps.getPr(found.owner, found.repo, number);
  // 候補の名前は表の小文字か設定の値なので、以後の処理にはGitHubが返した大小文字を使う。
  // 作業項目の照合は大小文字を区別するので、小文字のままだと処理済みの判定が外れる。
  const baseRepo = splitRepoFullName(pr.baseRepoFullName);
  if (
    baseRepo === null ||
    baseRepo.owner.toLowerCase() !== found.owner.toLowerCase() ||
    baseRepo.repo.toLowerCase() !== found.repo.toLowerCase()
  ) {
    return skipped(DEPENDABOT_SKIP_REASON.repoMismatch);
  }
  const { owner, repo } = baseRepo;
  if (pr.state !== "open" || pr.merged) {
    return skipped(DEPENDABOT_SKIP_REASON.notOpen);
  }
  if (
    pr.draft ||
    pr.baseRef !== DEPENDABOT_BASE_REF ||
    pr.authorLogin !== DEPENDABOT_AUTHOR_LOGIN
  ) {
    return skipped(DEPENDABOT_SKIP_REASON.notTarget);
  }
  if (!isCommitSha(pr.headSha)) {
    return skipped(DEPENDABOT_SKIP_REASON.headNotSha);
  }
  const createdAtMs = pr.createdAtMs;
  if (createdAtMs === null) {
    throw new Error("the pull request has no readable creation time");
  }
  const headSha = pr.headSha;
  if (await deps.hasItemForHead(owner, repo, number, headSha)) {
    return skipped(DEPENDABOT_SKIP_REASON.headHandled);
  }

  const key = headWaitKey(owner, repo, number, headSha);
  const previousWait = ctx.waits.get(key);
  if (previousWait !== undefined && previousWait.nextCheckAtMs > ctx.nowMs) {
    return {
      kind: "waiting",
      reason: DEPENDABOT_SKIP_REASON.throttled,
      key,
      wait: previousWait,
    };
  }

  // マージの保留は、間引きの判定の後、収集と影響調査より前に確かめる。保留があるPRに、Claudeの実行を使わない。
  // 間引き中のPRは待ちの記録をそのまま返すので、保留を読んでも記録は変わらない。読む回数を減らすため、間引きの後ろに置く。
  // 保留を読めないときも待つ。保留なしとは扱わない。
  const holdCheck = await classifyMergeHolds(() =>
    deps.listMergeHolds(owner, repo),
  );
  if (holdCheck.kind !== "clear") return { kind: "held", check: holdCheck };

  const newItem: NewDependabotWorkItem = {
    owner,
    repo,
    pr_number: number,
    title: pr.title,
    status: "picked",
    claimed_by: ctx.viewerLogin,
    head_sha: headSha,
  };

  const notifyHuman = async (note: string): Promise<void> => {
    await deps.notify({
      kind: "needs_human",
      instance_name: ctx.instanceName,
      owner,
      repo,
      url: prUrl(owner, repo, number),
      reason: sanitizeUntrustedProse(
        describeReason(note),
        NOTIFY_REASON_MAX_CHARS,
      ),
      target: { kind: "pr", number },
      next_action: nextActionFor(note, "dependabot"),
    });
  };

  /** オーナーの照合に落ちたときの理由を返す。通れば`null`。 */
  const ownerStop = async (): Promise<string | null> => {
    const gate = await deps.checkRepoOwner(owner, repo);
    return gate.ok ? null : dependabotReason("poll", gate.reason);
  };

  /** 照合を済ませた後に、作業項目を作ってすぐ人の対応待ちにする。 */
  const escalateChecked = async (
    note: string,
  ): Promise<DependabotPollOutcome> => {
    const id = await deps.insertItem(newItem);
    if (id === null) return skipped(DEPENDABOT_SKIP_REASON.insertLost);
    if (await deps.updateStatus(id, "picked", "needs_human", note)) {
      await notifyHuman(note);
    }
    return { kind: "escalated", workItemId: id, note };
  };

  const escalate = async (note: string): Promise<DependabotPollOutcome> =>
    escalateChecked((await ownerStop()) ?? note);

  const waitOrEscalate = (
    reason: string,
    publishCheckAtMs: number | null,
  ): Promise<DependabotPollOutcome> | DependabotPollOutcome => {
    const firstWaitAtMs = previousWait?.firstWaitAtMs ?? ctx.nowMs;
    const startMs = Math.max(createdAtMs, firstWaitAtMs);
    const limitDays = ctx.minPublishedDays + WAIT_LIMIT_EXTRA_DAYS;
    if (ctx.nowMs - startMs > limitDays * DAY_MS) {
      return escalate(
        dependabotReason(
          "poll",
          `still waiting more than ${String(limitDays)} days (${reason})`,
        ),
      );
    }
    const waitCount = (previousWait?.waitCount ?? 0) + 1;
    // 公開の時刻が未来に偽られても、待ちの上限の時刻より後には延ばさない。
    // 間引きは上限の判定より前にあるので、延ばすと上限を超えても黙って待ち続けるためである。
    const nextCheckAtMs = Math.min(
      publishCheckAtMs ?? ctx.nowMs + backoffFor(waitCount),
      startMs + limitDays * DAY_MS,
    );
    return {
      kind: "waiting",
      reason,
      key,
      wait: { firstWaitAtMs, waitCount, nextCheckAtMs },
    };
  };

  if (olderThanRetention(createdAtMs, ctx.nowMs, ctx.retentionDays)) {
    return escalate(
      dependabotReason(
        "poll",
        "the pull request is about as old as the work item retention, so an earlier result for this head may have been deleted",
      ),
    );
  }

  const flowWaits = await deps.gateWaitingCancels(owner, repo, number, headSha);
  if (flowWaits.count >= MAX_FLOW_GATE_WAITS) {
    return escalate(
      dependabotReason(
        "poll",
        `the flow stopped to wait ${String(flowWaits.count)} times for this head`,
      ),
    );
  }
  if (
    flowWaits.lastAt !== null &&
    ctx.nowMs - flowWaits.lastAt.getTime() < FLOW_WAIT_COOLDOWN_MS
  ) {
    return skipped(DEPENDABOT_SKIP_REASON.flowWaitCooldown);
  }

  const result = await deps.collect(owner, repo, number);
  if (result.kind === "closed") {
    return skipped(DEPENDABOT_SKIP_REASON.notOpen);
  }
  if (result.kind === "needs_human") {
    return escalate(dependabotReason("collect", result.reason));
  }
  if (result.kind === "wait") {
    return waitOrEscalate(result.reason, null);
  }
  if (result.headSha !== headSha) {
    return waitOrEscalate(
      "the head moved while the facts were collected",
      null,
    );
  }

  const gate = evaluateGateGroup(
    result.common,
    result.targets,
    ctx.allowGroups,
  );
  if (!gate.ok) {
    if (gate.kind === "needs_human") {
      return gate.notMergeable
        ? waitOrEscalate(gate.reason, null)
        : escalate(dependabotReason("gate", gate.reason));
    }
    return waitOrEscalate(
      gate.reason,
      nextPublishCheckAtMs(result.targets, result.common),
    );
  }

  const stop = await ownerStop();
  if (stop !== null) return escalateChecked(stop);
  const id = await deps.insertItem(newItem);
  if (id === null) return skipped(DEPENDABOT_SKIP_REASON.insertLost);
  let jobId: string;
  try {
    jobId = await deps.startFlow(id);
  } catch (err) {
    const note = dependabotReason(
      "poll",
      `the flow could not be started: ${errorMessage(err)}`,
    );
    await deps.recordFailure(
      stepName("start_flow", owner, repo, `#${String(number)}`),
      err,
      id,
    );
    if (await deps.updateStatus(id, "picked", "failed", note)) {
      await notifyHuman(note);
    }
    return { kind: "failed", workItemId: id, note };
  }
  await deps.setFlowJobId(id, jobId);
  return { kind: "started", workItemId: id };
}

// ---- 候補の選別 ----

export type DependabotCandidateSelection =
  | { readonly kind: "fresh"; readonly items: DependabotPrCandidate[] }
  /** archive済みで、記録が鮮度の閾値の内にある。マージできないので、候補は無い。 */
  | { readonly kind: "archived" }
  | { readonly kind: "stale"; readonly reason: GhRepoStaleReason };

/** 候補を選ぶ入力の1件。収集の表の行と、RESTの一覧の1件を、同じ形にそろえたもの。 */
type DependabotRow = Pick<
  GhPullRequest,
  "owner" | "repo" | "number" | "is_draft" | "base_ref"
> & {
  /** 不明なら`null`。 */
  readonly author_login: string | null;
  readonly author_type: string | null;
  readonly createdAtMs: number;
};

/**
 * 表の行の作者を、`poll_dependabot`が比べる形にそろえる。
 * 収集はGraphQLの値をそのまま保存するので、アプリ(`Bot`)の`login`には`[bot]`が付かない。
 */
function normalizedAuthorLogin(row: DependabotRow): string | null {
  if (row.author_login === null) return null;
  return row.author_type === "Bot"
    ? `${row.author_login}[bot]`
    : row.author_login;
}

/**
 * 行のうち、draftでなく、baseが`main`で、作者が`dependabot[bot]`のものを、候補にする。
 * 不明(`NULL`)のbaseと作者は、候補を広げる側に扱う。起動の前にRESTで確かめるので、広げても誤った操作には進まない。
 * forkの行は絞らない。ゲートがforkを人に回すためである。
 * 表と一覧が同じ規則で選ぶよう、両方がこの関数を通る。
 */
function pickDependabotRows(
  rows: readonly DependabotRow[],
): DependabotPrCandidate[] {
  return rows
    .filter((row) => {
      if (row.is_draft) return false;
      if (row.base_ref !== null && row.base_ref !== DEPENDABOT_BASE_REF) {
        return false;
      }
      const author = normalizedAuthorLogin(row);
      return author === null || author === DEPENDABOT_AUTHOR_LOGIN;
    })
    .map((row) => ({
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      createdAtMs: row.createdAtMs,
    }));
}

/**
 * 1つのリポジトリの読み取りの結果から、候補のPRを選ぶ。
 * 鮮度が足りなければ、行を選ばずに理由を返す。呼び出し側がそのリポジトリをRESTの一覧で読む。
 * archive済みの記録は、鮮度が閾値の内にあるときだけ`archived`を返す。
 * 古い記録のarchiveの印は、解除された後も残りうるので信用せず、鮮度の理由で一覧に戻す。
 * 候補の名前は表の小文字のまま返し、`createdAtMs`は並びにだけ使う。
 */
export function selectDependabotCandidates(
  snapshot: GhRepoOpenPrSnapshot,
  target: { readonly owner: string; readonly repo: string },
  staleAfterMs: number,
): DependabotCandidateSelection {
  const archived = snapshot.repo?.archived === true;
  // archiveの印は鮮度とは別に扱うので、鮮度の判定では外して渡す。
  const freshness = judgeGhRepoFreshness(
    snapshot.repo === null ? null : { ...snapshot.repo, archived: false },
    snapshot.prs,
    snapshot.db_now,
    staleAfterMs,
  );
  if (freshness.kind === "stale") {
    return { kind: "stale", reason: freshness.reason };
  }
  const repoId = snapshot.repo?.repo_id ?? null;
  if (repoId === null) {
    return { kind: "stale", reason: "unusable" };
  }
  if (archived) return { kind: "archived" };
  const rows = usableGhPullRequests(
    target.owner,
    target.repo,
    repoId,
    snapshot.prs,
  ).map((row) => ({ ...row, createdAtMs: row.created_at.getTime() }));
  return { kind: "fresh", items: pickDependabotRows(rows) };
}

/** 作成の時刻が無いPRの並び。最も新しい側に置き、時刻の分かるPRを先に処理する。 */
const UNKNOWN_CREATED_AT_MS = Number.MAX_SAFE_INTEGER;

/**
 * RESTの一覧の1件を、表の行と同じ形にそろえる。
 * 作者の`login`は、アプリなら末尾に`[bot]`が付く形で返るので、表の形(`[bot]`なし、種別`Bot`)に直す。
 * 作者が無いときと、baseが無いときは、不明(`null`)として候補に残す。
 * 候補の名前は、一覧の値ではなく、要求した名前から作る。
 */
function listedRow(
  pr: OpenPullRequest,
  target: { readonly owner: string; readonly repo: string },
): DependabotRow {
  let authorLogin: string | null = null;
  let authorType: string | null = null;
  if (pr.authorLogin !== null) {
    if (pr.authorLogin.endsWith(BOT_LOGIN_SUFFIX)) {
      authorLogin = pr.authorLogin.slice(0, -BOT_LOGIN_SUFFIX.length);
      authorType = "Bot";
    } else {
      authorLogin = pr.authorLogin;
      authorType = "User";
    }
  }
  return {
    owner: target.owner,
    repo: target.repo,
    number: pr.number,
    is_draft: pr.draft,
    base_ref: pr.baseRef ?? null,
    author_login: authorLogin,
    author_type: authorType,
    createdAtMs: pr.createdAtMs ?? UNKNOWN_CREATED_AT_MS,
  };
}

/** 開いているPRの一覧から、候補のPRを選ぶ。 */
function selectListedDependabotCandidates(
  prs: readonly OpenPullRequest[],
  target: { readonly owner: string; readonly repo: string },
): DependabotPrCandidate[] {
  return pickDependabotRows(prs.map((pr) => listedRow(pr, target)));
}

// ---- 周回の状態 ----

/** Windmillのstateに保存する形。 */
export type PollState = {
  /** レート制限の解除まで、周回を飛ばす時刻。無ければ`null`。 */
  readonly resumeAtMs: number | null;
  /** 待っているheadの記録(`headWaitKey`がキー)。 */
  readonly heads: Record<string, HeadWaitState>;
};

export type ParsedPollState = {
  readonly resumeAtMs: number | null;
  readonly heads: Map<string, HeadWaitState>;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseHeadWait(value: unknown): HeadWaitState | null {
  if (typeof value !== "object" || value === null) return null;
  const firstWaitAtMs: unknown = Reflect.get(value, "firstWaitAtMs");
  const waitCount: unknown = Reflect.get(value, "waitCount");
  const nextCheckAtMs: unknown = Reflect.get(value, "nextCheckAtMs");
  if (
    !isFiniteNumber(firstWaitAtMs) ||
    !isFiniteNumber(waitCount) ||
    !isFiniteNumber(nextCheckAtMs)
  ) {
    return null;
  }
  return { firstWaitAtMs, waitCount, nextCheckAtMs };
}

/** 保存したstateを読む。形が違えば、記録の無い状態として扱う。 */
export function parsePollState(raw: unknown): ParsedPollState {
  const empty: ParsedPollState = { resumeAtMs: null, heads: new Map() };
  if (typeof raw !== "object" || raw === null) return empty;
  const resume: unknown = Reflect.get(raw, "resumeAtMs");
  const heads: unknown = Reflect.get(raw, "heads");
  if (resume !== null && resume !== undefined && !isFiniteNumber(resume)) {
    return empty;
  }
  if (typeof heads !== "object" || heads === null || Array.isArray(heads)) {
    return empty;
  }
  const parsed = new Map<string, HeadWaitState>();
  for (const [key, value] of Object.entries(heads)) {
    const wait = parseHeadWait(value);
    if (wait === null) return empty;
    parsed.set(key, wait);
  }
  return { resumeAtMs: isFiniteNumber(resume) ? resume : null, heads: parsed };
}

/**
 * 次の周回に渡すstateを作る。
 * 今回待ちになったheadの記録と、今回調べ終えなかったPR(失敗したPRと、レート制限で打ち切った後のPR)の前の記録を残す。
 * 一覧の読み取りが失敗したか、一覧を読まなかったリポジトリのPRの前の記録も残す。待ちの起点を失わないためである。
 * 処理を終えたPRと、候補から外れたPR(閉じたPR)の記録は捨てるので、stateは開いたPRの数を超えて増えない。
 */
export function nextPollState(input: {
  readonly previous: ReadonlyMap<string, HeadWaitState>;
  readonly fresh: ReadonlyMap<string, HeadWaitState>;
  /** 今回調べ終えなかった候補のPRのキー(`headWaitKey`の`@`より前)。 */
  readonly unprocessedPrKeys: ReadonlySet<string>;
  /** 一覧の読み取りが失敗したか、レート制限で一覧を読まなかったリポジトリのキー(`owner/repo`の小文字)。 */
  readonly unlistedRepoKeys: ReadonlySet<string>;
  readonly resumeAtMs: number | null;
}): PollState {
  const heads: Record<string, HeadWaitState> = {};
  for (const [key, wait] of input.previous) {
    const prPart = prPartOf(key);
    if (
      input.unprocessedPrKeys.has(prPart) ||
      input.unlistedRepoKeys.has(repoPartOf(prPart))
    ) {
      heads[key] = wait;
    }
  }
  for (const [key, wait] of input.fresh) heads[key] = wait;
  return { resumeAtMs: input.resumeAtMs, heads };
}

// ---- 周回 ----

/** `pollDependabot`が設定を読んだ後に使うI/O。 */
export type PollSession = {
  readonly viewerLogin: string;
  /** 数値IDの照合を通ったオーナー。 */
  readonly verifiedOwners: readonly FactoryOwner[];
  /** 照合で飛ばしたオーナーの数。 */
  readonly ownersFailed: number;
  /** 1つのリポジトリの開いているPRを、RESTの一覧ですべて読む。 */
  readonly listOpenPrs: (
    owner: string,
    repo: string,
  ) => Promise<OpenPullRequest[]>;
  /** 収集の表から、1つのリポジトリの開いたPRの行とDBの時刻を、1つの文で読む。 */
  readonly readRepoPrs: (
    owner: string,
    repo: string,
  ) => Promise<GhRepoOpenPrSnapshot>;
  readonly listActive: () => Promise<
    readonly Pick<WorkItem, "kind" | "owner" | "repo" | "pr_number">[]
  >;
  /** 保留で待ったPRの通知を、通知の表に残す。1周で、種類ごとに1回だけ呼ぶ。 */
  readonly recordHoldNotice: (notice: HoldNotice) => Promise<void>;
  /** 保留を読めない通知のうち、本文が`messagePrefixes`のどれかで始まるものを解決済みにする。 */
  readonly resolveHoldUnreadableNotices: (
    messagePrefixes: readonly string[],
  ) => Promise<number>;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
  readonly deps: PollDependabotDeps;
};

export type PollDependabotIo = {
  readonly loadConfig: () => Promise<FactoryConfig>;
  readonly getState: () => Promise<unknown>;
  readonly setState: (state: PollState) => Promise<void>;
  readonly now: () => number;
  /** GitHubとDBに触れる準備をする。`dependabot_enabled`が偽のときと、周回を飛ばすときは呼ばない。 */
  readonly open: (config: FactoryConfig) => Promise<PollSession>;
};

export type PollDependabotResult = {
  readonly enabled: boolean;
  /** レート制限の解除を待つため、周回を飛ばしたか。 */
  readonly paused: boolean;
  readonly started: number;
  readonly escalated: number;
  readonly waiting: number;
  readonly skipped: number;
  readonly failed: number;
  /** マージの保留のために待ったPRの数。保留を読めずに待ったPRを含む。 */
  readonly held: number;
  /** 表の代わりにRESTの一覧で候補を列挙したリポジトリの数。 */
  readonly fallback_lists: number;
  /** 一覧に戻した理由ごとの、リポジトリの数。 */
  readonly fallback_reasons: Readonly<Record<string, number>>;
};

/** レート制限の例外から、周回を再開してよい時刻を求める。 */
function resumeAfter(err: GitHubRateLimitError, nowMs: number): number {
  return nowMs + (err.requiredWaitMs ?? RATE_LIMIT_DEFAULT_PAUSE_MS);
}

/**
 * dependabotのPRを1周する。
 * `dependabot_enabled`が偽なら、GitHubにもDBにも触れずに終える。
 * レート制限の解除の時刻の前なら、GitHubに触れずに周回を飛ばす。
 * 対象のリポジトリは`watch_main_ci`と同じ規則で決める(`listMainCiTargets`)。
 * `factory_repo`と、`repo_allowlist`のうち照合を通ったオーナーのリポジトリだけを、リポジトリごとに探す。
 * `repo_allowlist`が空なら`factory_repo`だけを見る。オーナーの全リポジトリは見ない。
 * 候補の列挙は、`gh_collect_enabled`と`gh_collect_detail_enabled`が真のときだけ、収集の表から読む。
 * 表を使えないリポジトリは、その周回だけRESTの一覧に戻す。戻したことは結果とログに出す。
 * 戻す理由は、表の鮮度の判定の理由(`no_record`、`unusable`、`not_collected`、`in_future`、`too_old`)と、
 * 表の読み取りの失敗(`read_failed`)と、収集の無効(`collection_disabled`)である。
 * 表でarchive済みと分かり、記録が鮮度の閾値の内にあるリポジトリは、マージできないので、一覧を読まない。
 * 収集の無効、表の読み取りの失敗、古い記録のときは、archiveの印を信用せず一覧で読む。
 * 一覧はページの上限を超えると失敗し、そのリポジトリは失敗として数える。
 * 1つのリポジトリの列挙の失敗と、1件のPRの失敗は記録して続ける。
 * GitHubのレート制限に当たったら、残りを次の周回に回し、解除の時刻をstateに残す。
 * 最後に、待っているheadの記録を保存する。
 */
export async function pollDependabot(
  io: PollDependabotIo,
): Promise<PollDependabotResult> {
  const config = await io.loadConfig();
  const counts = {
    started: 0,
    escalated: 0,
    waiting: 0,
    skipped: 0,
    failed: 0,
    held: 0,
  };
  const noFallback = { fallback_lists: 0, fallback_reasons: {} } as const;
  if (!config.dependabot_enabled) {
    return { enabled: false, paused: false, ...counts, ...noFallback };
  }

  const nowMs = io.now();
  const previous = parsePollState(await io.getState());
  if (previous.resumeAtMs !== null && previous.resumeAtMs > nowMs) {
    return { enabled: true, paused: true, ...counts, ...noFallback };
  }

  const session = await io.open(config);
  counts.failed += session.ownersFailed;
  // 保留を読めたかを、周回で数える。読めない通知を、読めた周回で解決するためである。
  // リポジトリごとに読めたかも残す。壊れた行などの通知は、そのリポジトリを読めたときだけ解決する。
  const holdReads = {
    ok: 0,
    failed: 0,
    okRepos: new Set<string>(),
    failedRepos: new Set<string>(),
  };
  const deps: PollDependabotDeps = {
    ...session.deps,
    listMergeHolds: async (owner, repo) => {
      const repository = `${owner}/${repo}`;
      try {
        const outcome = await session.deps.listMergeHolds(owner, repo);
        if (outcome.ok) {
          holdReads.ok += 1;
          holdReads.okRepos.add(repository);
        } else {
          holdReads.failed += 1;
          holdReads.failedRepos.add(repository);
        }
        return outcome;
      } catch (err) {
        holdReads.failed += 1;
        holdReads.failedRepos.add(repository);
        throw err;
      }
    },
  };

  const listed = listMainCiTargets({
    owners: [...session.verifiedOwners],
    repo_allowlist: config.repo_allowlist,
    factory_repo: config.factory_repo,
  });
  const { invalid } = listed;
  // Factory自身のほかは、dependabot_other_repos に名前を挙げたものだけを見る。
  const targets = listed.targets.filter(
    (target) => resolveRepoPolicy(config, target.owner, target.repo) !== "off",
  );
  if (invalid.length > 0) {
    // URLに認証情報が埋め込まれていることがあるので、値は載せない。
    session.warn(
      "repo_allowlist has entries that are not GitHub repository URLs",
      {
        count: invalid.length,
      },
    );
  }

  // 収集のどちらかを止めると`last_collected_at`が進まず、表を使えない。
  // 設定を戻し忘れても処理が止まらないよう、その周回はすべてRESTの一覧で読む。
  const useTable =
    config.gh_collect_enabled && config.gh_collect_detail_enabled;
  const staleAfterMs = ghDetailStaleAfterMs(config.owners.length);

  let resumeAtMs: number | null = null;
  const found: DependabotPrCandidate[] = [];
  // 候補を列挙できなかったリポジトリ。失敗したものと、レート制限で列挙しなかったものを入れる。
  const unlisted = new Set(
    targets.map((target) => `${target.owner}/${target.repo}`.toLowerCase()),
  );
  const fallbackReasons: Record<string, number> = {};
  let fallbackLists = 0;

  /**
   * 表から候補を足す。表を使えなければ、一覧に戻す理由を返す。
   * 記録が鮮度の内にあるarchive済みのリポジトリは、何も足さずに`null`を返す。
   */
  const readTable = async (target: {
    readonly owner: string;
    readonly repo: string;
  }): Promise<string | null> => {
    const repoKey = `${target.owner}/${target.repo}`.toLowerCase();
    let snapshot: GhRepoOpenPrSnapshot;
    try {
      snapshot = await session.readRepoPrs(target.owner, target.repo);
    } catch (err) {
      counts.failed += 1;
      await deps.recordFailure(
        stepName("read_gh_pull_requests", target.owner, target.repo),
        err,
        null,
      );
      return "read_failed";
    }
    const selection = selectDependabotCandidates(
      snapshot,
      target,
      staleAfterMs,
    );
    if (selection.kind === "stale") return selection.reason;
    if (selection.kind === "fresh") found.push(...selection.items);
    unlisted.delete(repoKey);
    return null;
  };

  /** 一覧で候補を足す。レート制限に当たって周回を止めるべきときは`false`を返す。 */
  const listTarget = async (target: {
    readonly owner: string;
    readonly repo: string;
  }): Promise<boolean> => {
    try {
      found.push(
        ...selectListedDependabotCandidates(
          await session.listOpenPrs(target.owner, target.repo),
          target,
        ),
      );
      unlisted.delete(`${target.owner}/${target.repo}`.toLowerCase());
    } catch (err) {
      counts.failed += 1;
      await deps.recordFailure(
        stepName("list_open_pull_requests", target.owner, target.repo),
        err,
        null,
      );
      if (err instanceof GitHubRateLimitError) {
        resumeAtMs = resumeAfter(err, nowMs);
        return false;
      }
    }
    return true;
  };

  for (const target of targets) {
    let reason = "collection_disabled";
    if (useTable) {
      const tableReason = await readTable(target);
      if (tableReason === null) continue;
      reason = tableReason;
    }
    fallbackLists += 1;
    fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
    session.warn("dependabot candidates fall back to list", {
      owner: target.owner,
      repo: target.repo,
      reason,
    });
    if (!(await listTarget(target))) break;
  }
  const scope = { ...config, owners: [...session.verifiedOwners] };
  const seen = new Set<string>();
  const candidates = filterByRepoAllowlist(found, scope)
    .filter((item) => {
      const key = prKey(item.owner, item.repo, item.number);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.number - b.number);

  const activeByPr = new Map<string, Pick<WorkItem, "kind">[]>();
  if (resumeAtMs === null && candidates.length > 0) {
    for (const item of await session.listActive()) {
      if (item.pr_number === null) continue;
      const key = prKey(item.owner, item.repo, item.pr_number);
      activeByPr.set(key, [...(activeByPr.get(key) ?? []), item]);
    }
  }

  const fresh = new Map<string, HeadWaitState>();
  // 保留で待ったPRの数。保留があるPRと、保留を読めなかった理由ごとのPRを数える。
  let heldPrs = 0;
  const unreadablePrs = new Map<
    string,
    { failure: MergeHoldFailure; repository: string | null; prCount: number }
  >();
  const unprocessed = new Set(
    candidates.map((item) => prKey(item.owner, item.repo, item.number)),
  );
  for (const candidate of candidates) {
    if (resumeAtMs !== null) break;
    const key = prKey(candidate.owner, candidate.repo, candidate.number);
    let outcome: DependabotPollOutcome;
    try {
      outcome = await processDependabotPr(
        deps,
        {
          nowMs,
          instanceName: config.instance_name,
          viewerLogin: session.viewerLogin,
          minPublishedDays: config.dependabot_min_published_days,
          allowGroups: config.dependabot_group_enabled,
          retentionDays: config.retention_work_items_days,
          activeForPr: activeByPr.get(key) ?? [],
          waits: previous.heads,
        },
        candidate,
      );
    } catch (err) {
      counts.failed += 1;
      await deps.recordFailure(
        stepName(
          "dependabot_pr",
          candidate.owner,
          candidate.repo,
          `#${String(candidate.number)}`,
        ),
        err,
        null,
      );
      // 失敗したPRの待ちの記録は消さずに残し、次の周回で続ける。
      if (err instanceof GitHubRateLimitError) {
        resumeAtMs = resumeAfter(err, nowMs);
        break;
      }
      continue;
    }
    counts[outcome.kind] += 1;
    if (outcome.kind === "held") {
      // 待ちの記録は変えない。保留が解けた後の待ちの上限の起点を、前の記録から続ける。
      if (outcome.check.kind === "held") {
        heldPrs += 1;
      } else {
        const failure = outcome.check.failure;
        // 壊れた行と想定外の失敗は、リポジトリごとの通知にする。
        const repository = holdFailureIsPerRepository(failure)
          ? `${candidate.owner}/${candidate.repo}`
          : null;
        const noticeKey = `${failure}\t${repository ?? ""}`;
        const known = unreadablePrs.get(noticeKey);
        unreadablePrs.set(noticeKey, {
          failure,
          repository,
          prCount: (known?.prCount ?? 0) + 1,
        });
      }
      continue;
    }
    unprocessed.delete(key);
    if (outcome.kind === "waiting") fresh.set(outcome.key, outcome.wait);
  }

  // 保留で待ったPRは、PRごとではなく周回ごとに、種類を分けて1件ずつ通知する。通知の失敗で周回を止めない。
  const holdNotices: HoldNotice[] = [];
  if (heldPrs > 0) holdNotices.push({ kind: "held", prCount: heldPrs });
  const unreadableCounts: Record<string, number> = {};
  for (const { failure, repository, prCount } of unreadablePrs.values()) {
    holdNotices.push({ kind: "unreadable", failure, prCount, repository });
    unreadableCounts[failure] = (unreadableCounts[failure] ?? 0) + prCount;
  }
  if (heldPrs > 0 || unreadablePrs.size > 0) {
    // 通知の本文は件数を含まない。件数はここに残す。
    session.warn("pull requests wait for merge holds", {
      held: heldPrs,
      unreadable: unreadableCounts,
    });
  }
  for (const notice of holdNotices) {
    try {
      await session.recordHoldNotice(notice);
    } catch (err) {
      session.warn("failed to record the hold notice", {
        kind: notice.kind,
        error: errorMessage(err),
      });
    }
  }
  // 保留を読めない通知を解決する。
  // 表そのものの通知は、読めて、読めない読み取りが1件も無い周回で解決する。
  // リポジトリごとの通知は、その周回でそのリポジトリを読めたときだけ解決する。
  const resolvablePrefixes = [
    ...(holdReads.ok > 0 && holdReads.failed === 0
      ? [HOLD_UNREADABLE_TABLE_PREFIX]
      : []),
    ...[...holdReads.okRepos]
      .filter((repository) => !holdReads.failedRepos.has(repository))
      .map(holdUnreadableRepositoryPrefix),
  ];
  if (resolvablePrefixes.length > 0) {
    try {
      await session.resolveHoldUnreadableNotices(resolvablePrefixes);
    } catch (err) {
      session.warn("failed to resolve the hold notice", {
        error: errorMessage(err),
      });
    }
  }

  await io.setState(
    nextPollState({
      previous: previous.heads,
      fresh,
      unprocessedPrKeys: unprocessed,
      unlistedRepoKeys: unlisted,
      resumeAtMs,
    }),
  );
  return {
    enabled: true,
    paused: false,
    ...counts,
    fallback_lists: fallbackLists,
    fallback_reasons: fallbackReasons,
  };
}

/** 保留で待ったPRについて、周回ごとに1件にまとめて残す通知の内容。 */
export type HoldNotice =
  | { readonly kind: "held"; readonly prCount: number }
  | {
      readonly kind: "unreadable";
      readonly failure: MergeHoldFailure;
      readonly prCount: number;
      /** 壊れた行と想定外の失敗では、読めなかったリポジトリ(`owner/repo`)。表そのものの失敗ではnull。 */
      readonly repository: string | null;
    };

const HOLD_UNREADABLE_NOTICE_KIND = "dependabot_merge_hold_unreadable";

/** 表そのものを読めない通知の本文の接頭辞。 */
const HOLD_UNREADABLE_TABLE_PREFIX = "保留の表を読めないため";

/** 壊れた行と想定外の失敗は、リポジトリごとに読めたかが決まる。 */
function holdFailureIsPerRepository(failure: MergeHoldFailure): boolean {
  return failure === "corrupt" || failure === "error";
}

/** リポジトリごとの通知の本文の接頭辞。`acme/app: `は`acme/app2: `に当たらない。 */
function holdUnreadableRepositoryPrefix(repository: string): string {
  return `${repository}: `;
}

/** 保留を読めない通知の、最初に確かめることの説明。 */
const HOLD_UNREADABLE_FIRST_STEP: Readonly<Record<MergeHoldFailure, string>> = {
  missing_table:
    "保留の表を作るmigrationが反映済みか、デプロイの記録で確認してください",
  read_failed: "DBが動いているか確認してください",
  corrupt:
    "`mise run hold:list`で壊れた行を確認し、psqlでその行を解除か削除してください",
  error: "workerのログで原因を確認してください",
};

/**
 * 保留の通知を、通知の表に残す形にする。
 * 保留で待った通知は、人の行動が要らない情報(`info`)である。
 * どちらの通知も、PRの数を本文に載せない。数が変わるたびに別の本文になり、別の行が並ぶためである。
 * 件数は周回のログに残す。
 * 保留を読めない通知は、人の対応が要る(`action`)。読めた周回で自動で解決する。
 * 壊れた行と想定外の失敗は、本文の先頭にリポジトリを置き、そのリポジトリを読めた周回で解決する。
 * 保留の`reason`と`holder`は、信頼できない文字列なので載せない。
 */
export function holdNoticeRecord(notice: HoldNotice): {
  readonly kind: string;
  readonly message: string;
} {
  if (notice.kind === "held") {
    return {
      kind: "dependabot_merge_held",
      message:
        "リポジトリにマージの保留があるため、dependabotの更新PRが待っています。保留が解けると、次の取得で自動で再開します。`mise run hold:list`で理由と期限を確認し、解除してよければ`mise run hold:release -- <id>`を実行してください",
    };
  }
  const where =
    notice.repository === null
      ? ""
      : holdUnreadableRepositoryPrefix(notice.repository);
  return {
    kind: HOLD_UNREADABLE_NOTICE_KIND,
    message: `${where}${HOLD_UNREADABLE_TABLE_PREFIX}、dependabotの更新PRのマージを待たせています(${notice.failure})。${HOLD_UNREADABLE_FIRST_STEP[notice.failure]}。読めるようになると、次の取得で自動で再開します`,
  };
}

export async function main(): Promise<PollDependabotResult> {
  const log = logger("poll_dependabot");
  return pollDependabot({
    loadConfig: () =>
      loadConfig(() => wmill.getResource("f/factory/factory_config")),
    getState: () => wmill.getState(),
    setState: (state) => wmill.setState(state),
    now: () => Date.now(),
    open: async (config) => {
      const ghToken = await wmill.getVariable("f/factory/github_token");
      const discordWebhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      const client: GhClient = { run: runCommand, ghToken };
      const viewer = await getViewer(client);
      const record = async (
        step: string,
        err: unknown,
        workItemId: number | null,
      ): Promise<void> => {
        const message = errorMessage(err);
        log.error(step, { error: message });
        try {
          await recordFailure({
            work_item_id: workItemId,
            flow_path: "f/factory/poll_dependabot",
            job_id: process.env.WM_JOB_ID ?? "unknown",
            step,
            error: message,
          });
        } catch (recordErr) {
          log.error("failed to record failure", {
            error: errorMessage(recordErr),
          });
        }
      };
      // 名前の付け替えで別のアカウントを読まないよう、`repo_allowlist`は照合を通ったオーナーのものだけを通す。
      const verified = await filterVerifiedOwners(config.owners, {
        getAccountId: (name) => getAccountId(client, name),
        recordFailure: (step, err) => record(step, err, null),
        addNotice: (notice) => addNoticeUnlessUnresolved(notice),
      });
      const collectDeps = buildCollectDeps({
        client,
        config,
        // 取得の側が`redirect: "manual"`と締め切りの`signal`を付けるので、素の`fetch`を包まずに渡す。
        fetchImpl: fetch,
        now: () => Date.now(),
      });
      return {
        viewerLogin: viewer.login,
        verifiedOwners: verified.owners,
        ownersFailed: verified.failed,
        listOpenPrs: (owner, repo) => listOpenPullRequests(client, owner, repo),
        readRepoPrs: (owner, repo) => readGhRepoOpenPullRequests(owner, repo),
        listActive: () => listActive(),
        recordHoldNotice: async (notice) => {
          await addNoticeUnlessUnresolved(holdNoticeRecord(notice));
        },
        resolveHoldUnreadableNotices: async (messagePrefixes) => {
          let resolved = 0;
          for (const messagePrefix of messagePrefixes) {
            resolved += await resolveUnresolvedNoticesByPrefix(
              HOLD_UNREADABLE_NOTICE_KIND,
              messagePrefix,
              "poll_dependabot",
            );
          }
          return resolved;
        },
        warn: (message, fields) => log.warn(message, fields),
        deps: {
          getPr: (owner, repo, number) =>
            getPrWithCreatedAt(client, owner, repo, number),
          hasItemForHead: (owner, repo, prNumber, headSha) =>
            hasDependabotItemForHead(owner, repo, prNumber, headSha),
          gateWaitingCancels: (owner, repo, prNumber, headSha) =>
            dependabotGateWaitingCancels(owner, repo, prNumber, headSha),
          listMergeHolds: (owner, repo) =>
            listActiveHolds(
              { scope: "merge", target: `${owner}/${repo}` },
              defaultSqlClient,
            ),
          collect: (owner, repo, number) =>
            collectGateInput(collectDeps, { owner, repo, number }),
          checkRepoOwner: (owner, repo) =>
            verifyRepoOwnerId(
              config,
              owner,
              repo,
              repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
            ),
          insertItem: (item) => insertDependabotWorkItemUnlessActive(item),
          updateStatus: (id, from, to, note) =>
            updateStatusIfCurrent(id, from, to, note),
          startFlow: async (workItemId) =>
            parseFlowJobId(
              await wmill.runFlowAsync(DEPENDABOT_FLOW_PATH, {
                work_item_id: workItemId,
              }),
              "runFlowAsync",
            ),
          setFlowJobId: (id, jobId) => setFlowJobId(id, jobId),
          notify: async (event) => {
            await notifyBestEffort(discordWebhookUrl, event, log);
          },
          recordFailure: record,
        },
      };
    },
  });
}
