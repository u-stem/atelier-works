// 承認待ちの作業項目を、最新の承認依頼と照合して片付ける走査。`poll_issues.ts`が定期的に呼ぶ。
// 期限切れの依頼を作業項目の側から扱い、決定済みなのに作業項目へ反映されなかった依頼の処理先を起動し直す。
//
// 種類ごとの行き先の表はここに置く。`approval_support.ts`は、Console用workerの`approval_decide`が読み込むので、
// `design_template.ts`などへの依存を足すと、Console用workerが読むコードの範囲が広がる。
// このファイルは`approval_support.ts`を読み込んでよいが、逆はしない。

import { designGateReason } from "./approval_gate.ts";
import { APPROVAL_REDISPATCH_NOTE_PREFIX } from "./console_support.ts";
import type { LatestApprovalGuard, LatestApprovalRequest } from "./db.ts";
import { DESIGN_APPROVAL_TIMED_OUT_REASON } from "./design_template.ts";
import type {
  ApprovalRequest,
  ApprovalRequestKind,
  WorkItem,
  WorkItemStatus,
} from "./types.ts";
import { APPROVAL_REQUEST_KINDS } from "./types.ts";

/** 期限切れにするときに、作業項目をどの状態から`expired`へ動かすか、その遷移の注記は何か。 */
export type ApprovalExpiryPlan = {
  readonly from: WorkItemStatus;
  readonly note: string;
};

/**
 * 種類ごとの期限切れの行き先。`Record`にして、種類を足したときに行き先を決めないとコンパイルできないようにする。
 * `null`は期限を持たない種類(`issue_proposal`)。
 */
const APPROVAL_EXPIRY_PLANS: Readonly<
  Record<ApprovalRequestKind, ApprovalExpiryPlan | null>
> = {
  requirements: { from: "awaiting_approval", note: "approval timed out" },
  design: {
    from: "awaiting_design_approval",
    note: DESIGN_APPROVAL_TIMED_OUT_REASON,
  },
  issue_proposal: null,
};

/** 種類の期限切れの行き先を返す。期限を持たない種類は`null`を返す。 */
export function expiryPlanFor(
  kind: ApprovalRequestKind,
): ApprovalExpiryPlan | null {
  return APPROVAL_EXPIRY_PLANS[kind];
}

/**
 * 決定から、処理先を起動し直すまでの猶予。
 * 判断の記録の直後に起動される通常の処理先と、二重に走らせないためである。
 */
export const SWEEP_REDISPATCH_GRACE_MS = 5 * 60 * 1000;

/** 1回の走査で処理先を起動し直す依頼の数の上限。走査の実行時間を一定に保つ。 */
export const SWEEP_REDISPATCH_LIMIT = 5;

/**
 * 1つの依頼について、処理先を起動し直してよい回数の上限。
 * 恒久的に失敗する依頼を、走査のたびに起動し続けないためである。超えたら作業項目を人の対応待ちにする。
 */
export const SWEEP_REDISPATCH_MAX_PER_REQUEST = 3;

/**
 * 直前の起動し直しから、次に起動し直す(または回数の上限で人の対応待ちにする)までの猶予。
 * 起動し直したジョブが、既定のworkerの長いジョブに塞がれて動き出す前に、回数だけが上限に達して
 * 作業項目を誤って人の対応待ちにしないためである。
 */
export const SWEEP_REDISPATCH_RETRY_GRACE_MS = 15 * 60 * 1000;

/**
 * 処理先を起動し直した記録(作業項目の遷移の記録で、状態は変えない)の注記。
 * 記録を数えて上限を判定するので、依頼ごとに固定の文にする。
 */
export function approvalRedispatchNote(requestId: number): string {
  return `${APPROVAL_REDISPATCH_NOTE_PREFIX}${String(requestId)}`;
}

/** 処理先を起動し直しても判断が作業項目に反映されなかったときの、`needs_human`の理由。 */
export function approvalApplyStalledReason(attempts: number): string {
  return `approval decision could not be applied after ${String(attempts)} restarts of the handler`;
}

export type SweepDeps = {
  readonly now: () => Date;
  /** 状態が`statuses`のどれかである`issue`の作業項目。 */
  readonly listWorkItemsByStatuses: (
    statuses: readonly WorkItemStatus[],
  ) => Promise<WorkItem[]>;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  /** 作業項目の最新の依頼。下書きと結合しない。 */
  readonly latestApprovalRequest: (
    workItemId: number,
    kind: ApprovalRequestKind,
  ) => Promise<LatestApprovalRequest | null>;
  /** 作業項目の状態と、最新の依頼のID・状態を条件にした比較交換。動かせたら`true`を返す。 */
  readonly updateStatusIfLatestApproval: (
    id: number,
    from: WorkItemStatus,
    to: WorkItemStatus,
    note: string,
    latest: LatestApprovalGuard,
  ) => Promise<boolean>;
  readonly listExpiredPendingApprovalRequests: (
    now: Date,
  ) => Promise<ApprovalRequest[]>;
  /** 依頼を`pending`のときだけ期限切れにする。期限切れにできたら`true`を返す。 */
  readonly expireApprovalRequestIfPending: (id: number) => Promise<boolean>;
  /** 作業項目の遷移の記録のうち、状態を変えず注記が`note`のものの数。 */
  readonly countApprovalRedispatches: (
    workItemId: number,
    note: string,
  ) => Promise<number>;
  /** 起動し直した記録(注記が`note`のもの)の最新の時刻。無ければ`null`。 */
  readonly lastApprovalRedispatchAt: (
    workItemId: number,
    note: string,
  ) => Promise<Date | null>;
  /** 処理先を起動し直した記録を書く。作業項目が`status`のままのときだけ書き、書けたら`true`を返す。 */
  readonly recordApprovalRedispatch: (
    workItemId: number,
    status: WorkItemStatus,
    note: string,
  ) => Promise<boolean>;
  /** 種類の処理先を起動する。 */
  readonly redispatch: (
    kind: ApprovalRequestKind,
    approvalRequestId: number,
  ) => Promise<void>;
  readonly notifyNeedsHuman: (item: WorkItem, reason: string) => Promise<void>;
  readonly recordFailure: (
    step: string,
    err: unknown,
    workItemId: number,
  ) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

/** 期限切れの行き先がある種類と、その行き先。 */
const EXPIRING_KINDS = APPROVAL_REQUEST_KINDS.flatMap((kind) => {
  const plan = expiryPlanFor(kind);
  return plan === null ? [] : [{ kind, plan }];
});

/**
 * 依頼の`payload.design_attempt`が、作業項目の`design_attempt`と一致する整数かを返す。
 * 一致しない依頼は、書き換えられたか壊れた記録で、承認としても却下としても扱えない。
 */
function designRecordConsistent(
  payload: Readonly<Record<string, unknown>>,
  item: Pick<WorkItem, "design_attempt">,
): boolean {
  const value = payload.design_attempt;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value === item.design_attempt
  );
}

type Counters = { moved: number; redispatched: number };

/**
 * 承認待ちの作業項目ごとに最新の依頼を照合する(段A)。
 * - 期限切れの`pending`: 先に作業項目を動かし、動かせたときだけ、依頼を期限切れにしてから通知する。
 *   依頼を期限切れにする前に落ちても依頼は`pending`のまま残り、次の回で段Bが依頼だけを片付ける。
 * - 期限切れで、作業項目が承認待ちのまま残ったもの: 作業項目を`expired`へ動かす。
 * - 決定済みで、猶予を過ぎても作業項目が承認待ちのままのもの: 処理先を起動し直す。
 *   猶予は決定の時刻と、直前の起動し直しの時刻のどちらからも測る。
 *   起動し直しは依頼ごとに回数の上限があり、超えたら作業項目を`needs_human`にする。
 */
async function sweepWorkItem(
  deps: SweepDeps,
  item: WorkItem,
  kind: ApprovalRequestKind,
  plan: ApprovalExpiryPlan,
  counters: Counters,
): Promise<void> {
  const latest = await deps.latestApprovalRequest(item.id, kind);
  if (latest === null) {
    deps.log("approval sweep: the work item has no request", {
      work_item_id: item.id,
      kind,
    });
    return;
  }
  const now = deps.now();
  const guard = (requestStatus: LatestApprovalRequest["status"]) => ({
    kind,
    requestId: latest.id,
    requestStatus,
  });

  if (latest.status === "pending") {
    if (
      latest.expires_at === null ||
      latest.expires_at.getTime() > now.getTime()
    ) {
      return;
    }
    const inconsistent =
      kind === "design" && !designRecordConsistent(latest.payload, item);
    const to: WorkItemStatus = inconsistent ? "needs_human" : "expired";
    const note = inconsistent
      ? designGateReason({ kind: "inconsistent" }, item.design_attempt)
      : plan.note;
    const moved = await deps.updateStatusIfLatestApproval(
      item.id,
      plan.from,
      to,
      note,
      guard("pending"),
    );
    if (!moved) return;
    if (!inconsistent) counters.moved += 1;
    // 通知は遅れることがある。待つ間に依頼が`pending`のまま残り、承認を記録できる窓を開けないよう、
    // 通知の前に依頼を期限切れにする。期限切れにできなくても通知は送る。依頼は段Bが片付ける。
    try {
      await deps.expireApprovalRequestIfPending(latest.id);
    } finally {
      await deps.notifyNeedsHuman(item, note);
    }
    return;
  }

  if (latest.status === "expired") {
    const moved = await deps.updateStatusIfLatestApproval(
      item.id,
      plan.from,
      "expired",
      plan.note,
      guard("expired"),
    );
    if (!moved) return;
    counters.moved += 1;
    await deps.notifyNeedsHuman(item, plan.note);
    return;
  }

  if (latest.status !== "approved" && latest.status !== "rejected") return;
  const decidedAt = latest.decided_at;
  if (
    decidedAt !== null &&
    now.getTime() - decidedAt.getTime() < SWEEP_REDISPATCH_GRACE_MS
  ) {
    return;
  }
  if (counters.redispatched >= SWEEP_REDISPATCH_LIMIT) return;

  const note = approvalRedispatchNote(latest.id);
  const lastRestartAt = await deps.lastApprovalRedispatchAt(item.id, note);
  if (
    lastRestartAt !== null &&
    now.getTime() - lastRestartAt.getTime() < SWEEP_REDISPATCH_RETRY_GRACE_MS
  ) {
    return;
  }
  const restarts = await deps.countApprovalRedispatches(item.id, note);
  if (restarts >= SWEEP_REDISPATCH_MAX_PER_REQUEST) {
    const reason = approvalApplyStalledReason(restarts);
    const moved = await deps.updateStatusIfLatestApproval(
      item.id,
      plan.from,
      "needs_human",
      reason,
      guard(latest.status),
    );
    if (moved) await deps.notifyNeedsHuman(item, reason);
    return;
  }
  const recorded = await deps.recordApprovalRedispatch(
    item.id,
    plan.from,
    note,
  );
  if (!recorded) return;
  counters.redispatched += 1;
  await deps.redispatch(kind, latest.id);
  deps.log("approval sweep: started the handler again", {
    work_item_id: item.id,
    kind,
    approval_request_id: latest.id,
  });
}

/**
 * 期限切れの`pending`の依頼のうち、作業項目の側(段A)が扱わないものを、依頼だけ期限切れにする(段B)。
 * 段Aが扱うのは「作業項目が承認待ちの状態にあり、最新の依頼がこの依頼」のときだけである。
 * それ以外は、新しい依頼を作り直した後に残った古い依頼、作業項目が先へ進んだ依頼、
 * 段Aで作業項目だけが動いて落ちた後の依頼で、作業項目は動かさず、通知もしない。
 * 段Aの比較交換が負けたときに、依頼だけが期限切れになって作業項目が残る状態を作らないためである。
 */
async function sweepOrphanRequests(deps: SweepDeps): Promise<void> {
  const expired = await deps.listExpiredPendingApprovalRequests(deps.now());
  for (const request of expired) {
    const plan = expiryPlanFor(request.kind);
    if (plan === null) continue;
    try {
      const item = await deps.getWorkItem(request.work_item_id);
      if (item !== null && item.status === plan.from) {
        const latest = await deps.latestApprovalRequest(item.id, request.kind);
        if (latest !== null && latest.id === request.id) continue;
      }
      await deps.expireApprovalRequestIfPending(request.id);
    } catch (err) {
      await deps.recordFailure(
        `approval_sweep_request:${String(request.id)}`,
        err,
        request.work_item_id,
      );
    }
  }
}

/**
 * 承認待ちの作業項目を最新の依頼と照合して片付け、作業項目を`expired`へ動かした数を返す。
 * 1件の例外は`recordFailure`に渡して、次の作業項目へ進む。
 * 対象は期限切れの行き先がある種類(`expiryPlanFor`が`null`でない)だけで、`issue_proposal`は触らない。
 */
export async function sweepApprovals(deps: SweepDeps): Promise<number> {
  const counters: Counters = { moved: 0, redispatched: 0 };
  const items = await deps.listWorkItemsByStatuses(
    EXPIRING_KINDS.map(({ plan }) => plan.from),
  );
  for (const item of items) {
    const target = EXPIRING_KINDS.find(({ plan }) => plan.from === item.status);
    if (target === undefined || item.issue_number === null) continue;
    try {
      await sweepWorkItem(deps, item, target.kind, target.plan, counters);
    } catch (err) {
      await deps.recordFailure(
        `approval_sweep:${String(item.id)}`,
        err,
        item.id,
      );
    }
  }
  await sweepOrphanRequests(deps);
  return counters.moved;
}
