// 10分ごとに、dependabotが開いたPRを探し、自動でマージできるかをフローと同じ収集とゲートで評価する。
// 通ったPRだけ作業項目を`picked`で作り、フロー`f/factory/dependabot`を起動する。
// 待つ間は作業項目を作らない。人に回すと決めたPRは、作業項目を作ってすぐ`needs_human`で終え、1回だけ通知する。
// `dependabot_enabled`が偽なら、GitHubにもDBにも触れずに終える。
// 対象のリポジトリは`factory_repo`と`repo_allowlist`に明示したものだけで、オーナーの全リポジトリは見ない。
//
// 判断は`processDependabotPr`と`pollDependabot`にあり、`main`は入出力をつなぐだけである。
// 1件のPRの失敗では例外を投げず、失敗を記録して次のPRへ進む。
// GitHubのレート制限に当たったら、その周回の残りを調べず、解除の時刻まで周回を飛ばす。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  dependabotGateWaitingCancels,
  hasDependabotItemForHead,
  insertDependabotWorkItemUnlessActive,
  listActive,
  type NewDependabotWorkItem,
  recordFailure,
  setFlowJobId,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import {
  buildCollectDeps,
  type CollectResult,
  collectGateInput,
} from "./lib/dependabot_collect.ts";
import {
  DEPENDABOT_FLOW_PATH,
  dependabotReason,
  sanitizeUntrustedProse,
} from "./lib/dependabot_flow_support.ts";
import {
  evaluateGate,
  isPublishedLongEnough,
} from "./lib/dependabot_support.ts";
import { type NotifyEvent, notifyBestEffort } from "./lib/discord.ts";
import {
  type DependabotPrSearchItem,
  type DependabotPrSearchScope,
  type GhClient,
  GitHubRateLimitError,
  getAccountId,
  getPr,
  getViewer,
  type PullRequest,
  searchDependabotPrs,
} from "./lib/github.ts";
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
import type { FactoryConfig, FactoryOwner, WorkItem } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";
import { describeReason, nextActionFor } from "./steps/pr_workflow_support.ts";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** 対象にするPRの作者。ゲートも同じ作者を求める。 */
const DEPENDABOT_AUTHOR_LOGIN = "dependabot[bot]";

/** 対象にするPRのbase。収集も同じブランチを求める。 */
const DEPENDABOT_BASE_REF = "main";

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

/** 待ちの記録のキーから、PRの部分を取り出す。 */
function prPartOf(key: string): string {
  const at = key.lastIndexOf("@");
  return at < 0 ? key : key.slice(0, at);
}

// ---- 1件のPR ----

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
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
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

function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * dependabotのPR1件を評価し、フローを起動するか、人に回すか、待つかを決めて実行する。
 * 手順は次のとおり。
 * 1. 同じPRに終端でないpr_reviewかpr_fixがあれば、何もしない。人が頼んだ作業を先にする。
 *    終端でないdependabotの作業項目があれば、フローが動いているので何もしない。
 * 2. PRを読み、開いた、draftでない、baseが`main`、作者が`dependabot[bot]`、headが完全なshaのものだけを続ける。
 * 3. そのheadを処理済み(`hasDependabotItemForHead`)なら、何もしない。
 * 4. 待っているheadは、次に確かめる時刻まで評価しない。
 * 5. PRを作ってから保持期間に近いほど時間がたっていれば、処理済みの記録が消えたかもしれないので、人に回す。
 * 6. 同じheadでフローが待ちで止まった回数が上限に達していれば人に回し、直後なら起動を見送る。
 * 7. フローの準備と同じ収集(`collectGateInput`)とゲート(`evaluateGate`)で評価する。
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
  found: DependabotPrSearchItem,
): Promise<DependabotPollOutcome> {
  const { owner, repo, number } = found;
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

  const pr = await deps.getPr(owner, repo, number);
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
    const startMs = Math.max(found.createdAtMs, firstWaitAtMs);
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
    return {
      kind: "waiting",
      reason,
      key,
      wait: {
        firstWaitAtMs,
        waitCount,
        nextCheckAtMs: publishCheckAtMs ?? ctx.nowMs + backoffFor(waitCount),
      },
    };
  };

  if (olderThanRetention(found.createdAtMs, ctx.nowMs, ctx.retentionDays)) {
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

  const gate = evaluateGate(result.input);
  if (!gate.ok) {
    if (gate.kind === "needs_human") {
      return gate.notMergeable
        ? waitOrEscalate(gate.reason, null)
        : escalate(dependabotReason("gate", gate.reason));
    }
    const { publishedAtIso, nowMs, minPublishedDays } = result.input;
    const publishedMs = Date.parse(publishedAtIso);
    const publishCheckAtMs =
      !isPublishedLongEnough(publishedAtIso, nowMs, minPublishedDays) &&
      Number.isFinite(publishedMs)
        ? publishedMs + minPublishedDays * DAY_MS
        : null;
    return waitOrEscalate(gate.reason, publishCheckAtMs);
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
      `start_flow:${owner}/${repo}#${String(number)}`,
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
 * 今回待ちになったheadの記録と、今回調べ終えなかったPR(失敗したPRと、レート制限で打ち切った後のPR)の前の記録だけを残す。
 * 処理を終えたPRと、候補から外れたPR(閉じたPR)の記録は捨てるので、stateは開いたPRの数を超えて増えない。
 */
export function nextPollState(input: {
  readonly previous: ReadonlyMap<string, HeadWaitState>;
  readonly fresh: ReadonlyMap<string, HeadWaitState>;
  /** 今回調べ終えなかった候補のPRのキー(`headWaitKey`の`@`より前)。 */
  readonly unprocessedPrKeys: ReadonlySet<string>;
  readonly resumeAtMs: number | null;
}): PollState {
  const heads: Record<string, HeadWaitState> = {};
  for (const [key, wait] of input.previous) {
    if (input.unprocessedPrKeys.has(prPartOf(key))) heads[key] = wait;
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
  readonly search: (
    scope: DependabotPrSearchScope,
  ) => Promise<DependabotPrSearchItem[]>;
  readonly listActive: () => Promise<
    readonly Pick<WorkItem, "kind" | "owner" | "repo" | "pr_number">[]
  >;
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
 * 1つのリポジトリの検索の失敗と、1件のPRの失敗は記録して続ける。
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
  };
  if (!config.dependabot_enabled) {
    return { enabled: false, paused: false, ...counts };
  }

  const nowMs = io.now();
  const previous = parsePollState(await io.getState());
  if (previous.resumeAtMs !== null && previous.resumeAtMs > nowMs) {
    return { enabled: true, paused: true, ...counts };
  }

  const session = await io.open(config);
  const { deps } = session;
  counts.failed += session.ownersFailed;

  const { targets, invalid } = listMainCiTargets({
    owners: [...session.verifiedOwners],
    repo_allowlist: config.repo_allowlist,
    factory_repo: config.factory_repo,
  });
  if (invalid.length > 0) {
    // URLに認証情報が埋め込まれていることがあるので、値は載せない。
    session.warn(
      "repo_allowlist has entries that are not GitHub repository URLs",
      {
        count: invalid.length,
      },
    );
  }

  let resumeAtMs: number | null = null;
  const found: DependabotPrSearchItem[] = [];
  for (const target of targets) {
    try {
      found.push(
        ...(await session.search({
          kind: "repo",
          owner: target.owner,
          repo: target.repo,
        })),
      );
    } catch (err) {
      counts.failed += 1;
      await deps.recordFailure(
        `search_dependabot_prs:${target.owner}/${target.repo}`,
        err,
        null,
      );
      if (err instanceof GitHubRateLimitError) {
        resumeAtMs = resumeAfter(err, nowMs);
        break;
      }
    }
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
          retentionDays: config.retention_work_items_days,
          activeForPr: activeByPr.get(key) ?? [],
          waits: previous.heads,
        },
        candidate,
      );
    } catch (err) {
      counts.failed += 1;
      await deps.recordFailure(
        `dependabot_pr:${candidate.owner}/${candidate.repo}#${String(candidate.number)}`,
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
    unprocessed.delete(key);
    counts[outcome.kind] += 1;
    if (outcome.kind === "waiting") fresh.set(outcome.key, outcome.wait);
  }

  await io.setState(
    nextPollState({
      previous: previous.heads,
      fresh,
      unprocessedPrKeys: unprocessed,
      resumeAtMs,
    }),
  );
  return { enabled: true, paused: false, ...counts };
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
        search: (scope) => searchDependabotPrs(client, scope),
        listActive: () => listActive(),
        warn: (message, fields) => log.warn(message, fields),
        deps: {
          getPr: (owner, repo, number) => getPr(client, owner, repo, number),
          hasItemForHead: (owner, repo, prNumber, headSha) =>
            hasDependabotItemForHead(owner, repo, prNumber, headSha),
          gateWaitingCancels: (owner, repo, prNumber, headSha) =>
            dependabotGateWaitingCancels(owner, repo, prNumber, headSha),
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
