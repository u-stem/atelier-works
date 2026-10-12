// 10分ごとに、dependabotが開いたPRを探し、自動でマージできるかをフローと同じ収集とゲートで評価する。
// 通ったPRだけ作業項目を`picked`で作り、フロー`f/factory/dependabot`を起動する。
// 待つ間は作業項目を作らない。人に回すと決めたPRは、作業項目を作ってすぐ`needs_human`で終え、1回だけ通知する。
// `dependabot_enabled`が偽なら、GitHubにもDBにも触れずに終える。
//
// 判断は`processDependabotPr`と`pollDependabot`にあり、`main`は入出力をつなぐだけである。
// 1件のPRの失敗では例外を投げず、失敗を記録して次のPRへ進む。
// GitHubのレート制限に当たったら、その周回の残りのPRは調べない。

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
import {
  filterByRepoAllowlist,
  filterVerifiedOwners,
} from "./lib/poll_support.ts";
import type { FactoryConfig, FactoryOwner, WorkItem } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";
import { describeReason, nextActionFor } from "./steps/pr_workflow_support.ts";

const DAY_MS = 86_400_000;

/** 対象にするPRの作者。ゲートも同じ作者を求める。 */
const DEPENDABOT_AUTHOR_LOGIN = "dependabot[bot]";

/** 対象にするPRのbase。収集も同じブランチを求める。 */
const DEPENDABOT_BASE_REF = "main";

/**
 * 待ちの上限を、公開の日数(`dependabot_min_published_days`)に足す日数。
 * PRを作ってから、公開の日数にこの日数を足した時間を超えて待ちが続けば、人に回す。
 * 必須のチェックの失敗の放置やレート制限の連続で、いつまでも黙って待たないためである。
 */
export const WAIT_LIMIT_EXTRA_DAYS = 7;

/**
 * フローが待ちで止まった後に、同じheadのフローを起動し直すまでの間(ミリ秒)。
 * 取得の評価が通っても、フローの側の収集が待ちを返すことがある(レート制限、チェックの再実行など)。
 * そのたびに周回ごとにフローを起動しないよう、間を置く。
 */
export const FLOW_WAIT_COOLDOWN_MS = 60 * 60_000;

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
  /** 公開の日数を待っている。 */
  publishWait: "the update is waiting for the publish days",
  /** ほかの取得が先に作業項目を作った。 */
  insertLost: "another poll created the work item first",
} as const;

/** 公開の日数の待ちを間引くキー。headごとに分け、新しいheadは間引かない。 */
export function publishWaitKey(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
): string {
  return `${owner}/${repo}#${String(number)}@${headSha}`;
}

// ---- 1件のPR ----

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
  /** 公開の日数を待つheadの、次に確かめる時刻(`publishWaitKey`がキー)。 */
  readonly nextCheckAt: ReadonlyMap<string, number>;
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
      /** 待っているhead。 */
      readonly headSha: string;
      /** 公開の日数の待ちで、次に確かめる時刻。ほかの待ちは`null`。 */
      readonly nextCheckAtMs: number | null;
    }
  | { readonly kind: "skipped"; readonly reason: string };

/** PRを作ってから、待ちの上限を超えたか。上限ちょうどは超えていない。 */
function waitLimitExceeded(
  createdAtMs: number,
  nowMs: number,
  minPublishedDays: number,
): boolean {
  return (
    nowMs - createdAtMs > (minPublishedDays + WAIT_LIMIT_EXTRA_DAYS) * DAY_MS
  );
}

/** 処理済みの記録が保持期間で消えたかもしれないほど、PRが古いか。 */
function olderThanRetention(
  createdAtMs: number,
  nowMs: number,
  retentionDays: number,
): boolean {
  const days = Math.max(0, retentionDays - RETENTION_MARGIN_DAYS);
  return nowMs - createdAtMs >= days * DAY_MS;
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
 * 4. 公開の日数を待っているheadは、次に確かめる時刻まで収集しない。
 * 5. PRを作ってから保持期間に近いほど時間がたっていれば、処理済みの記録が消えたかもしれないので、人に回す。
 * 6. 同じheadでフローが待ちで止まった回数が上限に達していれば人に回し、直後なら起動を見送る。
 * 7. フローの準備と同じ収集(`collectGateInput`)とゲート(`evaluateGate`)で評価する。
 *    通ればフローを起動し、止まれば人に回し、待ちなら作業項目を作らない。
 *    待ちが上限を超えて続いていれば、人に回す。
 * 人に回すときと起動するときは、作業項目を`picked`で作る。部分一意インデックスが同じPRの2件目を拒むので、
 * 作れなかったときは、ほかの取得が先に始めたものとして何もしない。
 * 人に回すときは、すぐに`needs_human`へ移し、移せたときだけ通知する。
 * 起動に失敗したときは、行を`failed`にし、失敗を記録して通知する。
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

  const throttledUntil = ctx.nextCheckAt.get(
    publishWaitKey(owner, repo, number, headSha),
  );
  if (throttledUntil !== undefined && throttledUntil > ctx.nowMs) {
    return {
      kind: "waiting",
      reason: DEPENDABOT_SKIP_REASON.publishWait,
      headSha,
      nextCheckAtMs: throttledUntil,
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

  const escalate = async (note: string): Promise<DependabotPollOutcome> => {
    const id = await deps.insertItem(newItem);
    if (id === null) return skipped(DEPENDABOT_SKIP_REASON.insertLost);
    if (await deps.updateStatus(id, "picked", "needs_human", note)) {
      await notifyHuman(note);
    }
    return { kind: "escalated", workItemId: id, note };
  };

  const waitOrEscalate = (
    reason: string,
    nextCheckAtMs: number | null,
  ): Promise<DependabotPollOutcome> | DependabotPollOutcome => {
    if (waitLimitExceeded(found.createdAtMs, ctx.nowMs, ctx.minPublishedDays)) {
      return escalate(
        dependabotReason(
          "poll",
          `still waiting more than ${String(ctx.minPublishedDays + WAIT_LIMIT_EXTRA_DAYS)} days after the pull request was opened (${reason})`,
        ),
      );
    }
    return { kind: "waiting", reason, headSha, nextCheckAtMs };
  };

  if (olderThanRetention(found.createdAtMs, ctx.nowMs, ctx.retentionDays)) {
    return escalate(
      dependabotReason(
        "poll",
        "the pull request is about as old as the work item retention, so an earlier result for this head may have been deleted",
      ),
    );
  }

  const waits = await deps.gateWaitingCancels(owner, repo, number, headSha);
  if (waits.count >= MAX_FLOW_GATE_WAITS) {
    return escalate(
      dependabotReason(
        "poll",
        `the flow stopped to wait ${String(waits.count)} times for this head`,
      ),
    );
  }
  if (
    waits.lastAt !== null &&
    ctx.nowMs - waits.lastAt.getTime() < FLOW_WAIT_COOLDOWN_MS
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
      return escalate(dependabotReason("gate", gate.reason));
    }
    const { publishedAtIso, nowMs, minPublishedDays } = result.input;
    const publishedMs = Date.parse(publishedAtIso);
    const nextCheckAtMs =
      !isPublishedLongEnough(publishedAtIso, nowMs, minPublishedDays) &&
      Number.isFinite(publishedMs)
        ? publishedMs + minPublishedDays * DAY_MS
        : null;
    return waitOrEscalate(gate.reason, nextCheckAtMs);
  }

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

// ---- 間引きの状態 ----

/** Windmillのstateに保存する形。 */
export type PollState = { readonly nextCheckAt: Record<string, number> };

/** 保存したstateを読む。形が違えば、間引きの無い状態として扱う。 */
export function parsePollState(raw: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (typeof raw !== "object" || raw === null) return result;
  const times: unknown = Reflect.get(raw, "nextCheckAt");
  if (typeof times !== "object" || times === null || Array.isArray(times)) {
    return result;
  }
  for (const [key, value] of Object.entries(times)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return new Map();
    }
    result.set(key, value);
  }
  return result;
}

/**
 * 次の周回に渡すstateを作る。前の時刻に今回の時刻を重ね、時刻が来たものを捨てる。
 * 閉じたPRの時刻も、時刻が来れば捨てるので、stateは公開の日数を超えて残らない。
 */
export function nextPollState(
  previous: ReadonlyMap<string, number>,
  fresh: ReadonlyMap<string, number>,
  nowMs: number,
): PollState {
  const nextCheckAt: Record<string, number> = {};
  for (const [key, value] of [...previous, ...fresh]) {
    if (value > nowMs) nextCheckAt[key] = value;
  }
  return { nextCheckAt };
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
  readonly getState: () => Promise<unknown>;
  readonly setState: (state: PollState) => Promise<void>;
  readonly now: () => number;
  readonly deps: PollDependabotDeps;
};

export type PollDependabotIo = {
  readonly loadConfig: () => Promise<FactoryConfig>;
  /** GitHubとDBに触れる準備をする。`dependabot_enabled`が偽なら呼ばない。 */
  readonly open: (config: FactoryConfig) => Promise<PollSession>;
};

export type PollDependabotResult = {
  readonly enabled: boolean;
  readonly started: number;
  readonly escalated: number;
  readonly waiting: number;
  readonly skipped: number;
  readonly failed: number;
};

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${String(number)}`.toLowerCase();
}

/**
 * dependabotのPRを1周する。
 * `dependabot_enabled`が偽なら、GitHubにもDBにも触れずに終える。
 * 照合を通ったオーナーごとにPRを探し、`poll_prs`と同じ許可リスト(`filterByRepoAllowlist`)で絞る。
 * 1つのオーナーの検索の失敗と、1件のPRの失敗は記録して続ける。
 * GitHubのレート制限に当たったら、残りのPRは次の周回に回す。
 * 最後に、公開の日数を待つheadの次に確かめる時刻を保存する。
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
  if (!config.dependabot_enabled) return { enabled: false, ...counts };

  const session = await io.open(config);
  const { deps } = session;
  counts.failed += session.ownersFailed;

  const found: DependabotPrSearchItem[] = [];
  for (const owner of session.verifiedOwners) {
    try {
      found.push(
        ...(await session.search({
          kind: "owner",
          owner: owner.name,
          ownerKind: owner.kind,
        })),
      );
    } catch (err) {
      counts.failed += 1;
      await deps.recordFailure(
        `search_dependabot_prs:${owner.name}`,
        err,
        null,
      );
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
  for (const item of await session.listActive()) {
    if (item.pr_number === null) continue;
    const key = prKey(item.owner, item.repo, item.pr_number);
    activeByPr.set(key, [...(activeByPr.get(key) ?? []), item]);
  }

  const previous = parsePollState(await session.getState());
  const fresh = new Map<string, number>();
  const nowMs = session.now();

  for (const candidate of candidates) {
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
          nextCheckAt: previous,
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
      if (err instanceof GitHubRateLimitError) break;
      continue;
    }
    counts[outcome.kind] += 1;
    if (outcome.kind === "waiting" && outcome.nextCheckAtMs !== null) {
      fresh.set(
        publishWaitKey(
          candidate.owner,
          candidate.repo,
          candidate.number,
          outcome.headSha,
        ),
        outcome.nextCheckAtMs,
      );
    }
  }

  await session.setState(nextPollState(previous, fresh, nowMs));
  return { enabled: true, ...counts };
}

export async function main(): Promise<PollDependabotResult> {
  const log = logger("poll_dependabot");
  return pollDependabot({
    loadConfig: () =>
      loadConfig(() => wmill.getResource("f/factory/factory_config")),
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
        getState: () => wmill.getState(),
        setState: (state) => wmill.setState(state),
        now: () => Date.now(),
        deps: {
          getPr: (owner, repo, number) => getPr(client, owner, repo, number),
          hasItemForHead: (owner, repo, prNumber, headSha) =>
            hasDependabotItemForHead(owner, repo, prNumber, headSha),
          gateWaitingCancels: (owner, repo, prNumber, headSha) =>
            dependabotGateWaitingCancels(owner, repo, prNumber, headSha),
          collect: (owner, repo, number) =>
            collectGateInput(collectDeps, { owner, repo, number }),
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
