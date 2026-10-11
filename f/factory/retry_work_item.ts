// 止まった作業項目を手動で再開するscript。`failed`・`needs_human`・
// `expired`・`blocked`・`approved`から再開できる。閉じた対象を理由に
// 要対応の照合が取り消した`cancelled`も、取り消す前の状態の作業項目として再開できる。
// その再開だけは、対象のIssueかPRが開いていることをGitHubで確かめる(`closedTargetRefusal`)。
// ほかの再開はGitHubに依存しない。
// 再開するフローと遷移先の状態は種別で決まる(`computeRestartPlan`)。状態の変更はここで読んだ状態を
// 前提にした比較交換なので、並行して状態が変わったら上書きせず再開をやめる。
// 記録済みのflowジョブがまだ動いている(キュー待ちを含む)か、状態を読めないときは
// 再開を拒否する。実装フローとpipelineへの再開は比較交換でflow_job_id(リース)を空にし、
// 起動したジョブIDは空のときだけ記録する。起動の戻り値がジョブIDでなければ、
// 状態をneeds_humanに戻して例外を投げる(`launchFailureError`)。
//
// どの種別もラベルを付け直さない。トリガーラベル(Issueは`factory`、
// PRは`factory:review`・`factory:fix`)は取得時に一度だけ消費し、
// 自動では付け直さない。状態は`work_items.status`にだけあり、再開した
// PRの作業項目は、ラベルではなく`poll_prs.ts`の`listTrackedPrs`(DBを参照)が
// 見つけ直す。したがって再開はフローを直接起動するだけで、GitHubには
// 何の副作用も無い。新しいサイクルを始めるのは、人がラベルを付け直したときだけ。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNotice,
  getWorkItem,
  isActiveIssueUniqueViolation,
  latestRequirementsApproval,
  latestStatusEvent,
  listActiveIssueWorkItems,
  newestNewerIssueCycle,
  newestNewerPrWorkItem,
  type StatusEventSummary,
  setFlowJobId,
  setFlowJobIdIfUnset,
  updateIntakeIfRegenerating,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
} from "./lib/db.ts";
import {
  fetchIssueContent,
  fetchIssueState,
  GitHubHttpError,
} from "./lib/github.ts";
import { parseFlowJobId } from "./lib/implement_launch_support.ts";
import { IMPLEMENT_FLOW_PATH } from "./lib/implement_loop.ts";
import { isRequirementsApprovedForAttempt } from "./lib/implement_support.ts";
import {
  buildIntakeRefreshedNoticeMessage,
  INTAKE_REFRESHED_NOTICE_KIND,
  refreshIntakeFromIssue,
} from "./lib/intake_refresh.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import { PIPELINE_FLOW_PATH } from "./lib/pipeline_lease.ts";
import {
  type JobState,
  readJobState,
  statusBeforeActionableCancel,
} from "./lib/poll_support.ts";
import {
  isOneOf,
  TERMINAL_WORK_ITEM_STATUSES,
  type WorkItem,
  type WorkItemStatus,
} from "./lib/types.ts";

const RESTARTABLE_STATUSES = [
  "failed",
  "needs_human",
  "expired",
  "blocked",
  "approved",
] as const;

export type RestartPlan = {
  readonly toStatus: WorkItemStatus;
  readonly flowPath: string;
  readonly args: Readonly<Record<string, unknown>>;
};

/**
 * 再開先を決めるための文脈。どちらも`main`が計算する。
 * `implementReady`は、最新の要件承認が現在の`attempt`に対して承認済みか。
 * `implementEnabled`は`factory_config.implement_enabled`の値。
 */
export type RestartContext = {
  readonly implementReady: boolean;
  readonly implementEnabled: boolean;
};

/**
 * Issueの作業項目に、より新しいサイクルがあるとき、再開を断る理由を返す。無ければ`null`。
 * 古いサイクルの作業項目を再開すると、新しいサイクルに置き換えられた要件定義を
 * 実装しかねない。
 * 理由の文は英語の1文で、そのままConsoleとWindmillに表示される。翻訳する処理は無い。
 * 次の操作は、最新のサイクルの状態で決まる。
 * - 稼働中(終端でない)なら、そのサイクルが進むので、操作は要らない。
 * - 再開できる状態(`RESTARTABLE_STATUSES`)なら、最新のサイクルを再実行する。
 * - PRを作成した(`pr_open`)なら、そのPRを確かめる。
 * - それ以外の終端なら、Issueにトリガーラベルを付け直して新しいサイクルを始める。
 * `issue`の作業項目が取る終端の状態のうち、PRの段階にあるのは`pr_open`だけである。
 * `reviewed`や`rereview_requested`は`pr_review` / `pr_fix`、`audited`は`audit`の作業項目の状態である。
 * IssueでないPRの作業項目には適用しない。
 */
export function newerCycleRefusal(
  workItem: Pick<WorkItem, "id" | "kind">,
  newest: { readonly id: number; readonly status: WorkItemStatus } | null,
  triggerLabel: string,
): string | null {
  if (workItem.kind !== "issue" || newest === null) return null;
  const head = `retry_work_item: work item ${String(workItem.id)} is superseded by work item ${String(newest.id)} (status ${newest.status})`;
  if (!isOneOf(newest.status, TERMINAL_WORK_ITEM_STATUSES)) {
    return `${head}, which is in progress, no action needed`;
  }
  if (newest.status === "pr_open") {
    return `${head}, the newer cycle opened a pull request, check that pull request instead`;
  }
  if (isOneOf(newest.status, RESTARTABLE_STATUSES)) {
    return `${head}, retry work item ${String(newest.id)} instead`;
  }
  return `${head}, add the "${triggerLabel}" label to the Issue again to start a new cycle`;
}

/**
 * 取り消された`pr_review` / `pr_fix`の作業項目に、同じ種類・同じPRで`id`の大きい行があるとき、
 * 再開を断る理由を返す。無ければ`null`。
 * 取り消した後にラベルを付け直すと、同じPRに新しい行ができる。
 * 古い行を再開すると、同じPRの作業項目が並んで動くので、新しい行に従わせる。
 * 基準は`listActionableWorkItems`が引き継ぎ済みとみなす行(同じ種類・同じPRで`id`が大きい)と同じである。
 * 理由の文は英語の1文で、そのままConsoleとWindmillに表示される。
 */
export function newerPrRowRefusal(
  workItem: Pick<WorkItem, "id" | "kind">,
  newer: { readonly id: number; readonly status: WorkItemStatus } | null,
): string | null {
  if (workItem.kind === "issue" || newer === null) return null;
  const id = String(workItem.id);
  const newerId = String(newer.id);
  return `retry_work_item: work item ${id} was cancelled when its target was closed, and work item ${newerId} (status ${newer.status}) now tracks the same pull request, so work item ${id} will not be restarted, follow work item ${newerId}`;
}

/**
 * 取り消された作業項目(`restartItem`の状態が`workItem`と違うとき)の再開を断る理由を返す。無ければ`null`。
 * 取り消されていない作業項目には何も確かめない。
 * 取り消されたものは、先に`newerPrRowRefusal`(`pr_review` / `pr_fix`で`pr_number`があるときだけ問い合わせる)、
 * 次に`closedTargetRefusal`の順に確かめる。GitHubへの問い合わせを後にして、DBで済む確認を先に返す。
 */
export async function cancelledRestartRefusal(
  workItem: Pick<
    WorkItem,
    "id" | "kind" | "status" | "owner" | "repo" | "issue_number" | "pr_number"
  >,
  restartItem: Pick<WorkItem, "status">,
  deps: {
    readonly newerPrRow: (
      item: {
        readonly id: number;
        readonly kind: "pr_review" | "pr_fix";
        readonly owner: string;
        readonly repo: string;
      },
      prNumber: number,
    ) => Promise<{
      readonly id: number;
      readonly status: WorkItemStatus;
    } | null>;
    readonly getState: (
      owner: string,
      repo: string,
      number: number,
    ) => Promise<string>;
  },
): Promise<string | null> {
  if (restartItem.status === workItem.status) return null;
  const newerRow =
    (workItem.kind === "pr_review" || workItem.kind === "pr_fix") &&
    workItem.pr_number !== null
      ? await deps.newerPrRow(
          {
            id: workItem.id,
            kind: workItem.kind,
            owner: workItem.owner,
            repo: workItem.repo,
          },
          workItem.pr_number,
        )
      : null;
  const taken = newerPrRowRefusal(workItem, newerRow);
  if (taken !== null) return taken;
  return closedTargetRefusal(workItem, deps.getState);
}

/**
 * 終端の作業項目を稼働中の状態へ戻す更新が、同じIssueの別の稼働中の作業項目に阻まれたときの
 * 例外を作る。その稼働中の作業項目がこのIssueの現在のサイクルなので、
 * この作業項目は再開できず、現在のサイクルに従う。稼働中の作業項目が見つかれば、そのIDを文に含める。
 * `newerCycleRefusal`が先に新しいサイクルのある作業項目を断るので、この衝突が起きるのは、
 * 最新のサイクルの再実行で、確認と状態の更新の間に、同じIssueで新しいサイクルが始まった競合のときだけである。
 */
export function activeIssueConflictError(
  workItem: Pick<WorkItem, "id" | "owner" | "repo" | "issue_number">,
  active: readonly Pick<
    WorkItem,
    "id" | "owner" | "repo" | "issue_number" | "kind"
  >[],
): Error {
  const other = active.find(
    (item) =>
      item.kind === "issue" &&
      item.id !== workItem.id &&
      item.owner === workItem.owner &&
      item.repo === workItem.repo &&
      item.issue_number === workItem.issue_number,
  );
  const id = String(workItem.id);
  if (other === undefined) {
    return new Error(
      `retry_work_item: another work item is the current cycle for this Issue, work item ${id} will not be resumed`,
    );
  }
  const otherId = String(other.id);
  return new Error(
    `retry_work_item: work item ${otherId} (active) is the current cycle for this Issue, work item ${id} will not be resumed, follow work item ${otherId}`,
  );
}

/**
 * `activeIssueConflictError`を、稼働中の作業項目の検索(`lookup`)の結果から作る。
 * 検索が失敗しても、再実行の失敗の理由を隠さないよう、IDなしの文にして返す。
 */
export async function activeIssueConflictErrorFrom(
  workItem: Pick<WorkItem, "id" | "owner" | "repo" | "issue_number">,
  lookup: () => Promise<
    readonly Pick<WorkItem, "id" | "owner" | "repo" | "issue_number" | "kind">[]
  >,
): Promise<Error> {
  try {
    return activeIssueConflictError(workItem, await lookup());
  } catch {
    return activeIssueConflictError(workItem, []);
  }
}

/**
 * 取り消された作業項目を、取り消す前の状態の作業項目として扱うために、状態を置き換えて返す。
 * 対象は、`poll_issues`の要対応の照合が、要対応の状態(失敗、人の対応待ち、期限切れ)から
 * 取り消した作業項目だけである。照合は対象のIssueやPRが閉じられたときに取り消すので、
 * 閉じた対象を開き直した後に、再開できるようにするためである。
 * ほかの理由の取り消し(新しいサイクルによる置き換えなど)や、取り消されていない作業項目は、そのまま返す。
 * 状態の更新は取り消された状態を期待して行うので、置き換えるのは再開先を決めるときだけに使う。
 */
export function asBeforeActionableCancel<T extends Pick<WorkItem, "status">>(
  workItem: T,
  cancelEvent: StatusEventSummary | null,
): T {
  if (workItem.status !== "cancelled") return workItem;
  const before = statusBeforeActionableCancel(cancelEvent);
  return before === null ? workItem : { ...workItem, status: before };
}

/**
 * 要対応の照合が取り消した作業項目を再開する前に、対象のIssueかPRが開いているかを確かめ、
 * 再開を断る理由を返す。開いていれば`null`を返す。
 * 閉じたまま再開すると、作業項目は終端でない状態に戻り、reconcileが再開できない注記で取り消す。
 * 取り消す前の状態からの再開は二度とできなくなるので、先に対象を開き直させる。
 * 開いているか確かめられない(番号が無い、取得に失敗した)ときも断る。
 * 理由の文は英語の1文で、そのままConsoleとWindmillに表示される。
 */
export async function closedTargetRefusal(
  workItem: Pick<
    WorkItem,
    "id" | "kind" | "owner" | "repo" | "issue_number" | "pr_number"
  >,
  getState: (owner: string, repo: string, number: number) => Promise<string>,
): Promise<string | null> {
  const number =
    workItem.kind === "issue" ? workItem.issue_number : workItem.pr_number;
  const head = `retry_work_item: work item ${String(workItem.id)} was cancelled when its target was closed`;
  if (number === null) {
    return `${head}, and the target has no number to check, so it was not restarted`;
  }
  const target = `${workItem.owner}/${workItem.repo}#${String(number)}`;
  let state: string;
  try {
    state = await getState(workItem.owner, workItem.repo, number);
  } catch (err) {
    // 3xxは恒久的な移転(Issueの移動、リポジトリの改名や所有者の移管)で、待っても直らない。
    if (
      err instanceof GitHubHttpError &&
      err.status >= 300 &&
      err.status < 400
    ) {
      return `${head}, and ${target} was redirected (the issue or repository moved); it cannot be restarted`;
    }
    const reason = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    return `${head}, and whether ${target} is open could not be checked (${reason}); try again later`;
  }
  if (state === "open") return null;
  return `${head}, and ${target} is still closed; reopen it and run retry_work_item again`;
}

/**
 * 再開できる作業項目について、戻す状態と起動するフローを決める。
 * issueは、要件が現在の`attempt`で承認済みで`implement_enabled`が有効なら
 * implementフロー、そうでなければpipelineフローで再開する。
 * pr_reviewとpr_fixは同名のフローで再開する。
 * 次の場合は例外を投げる。
 * - `workItem.status`が再開できる状態でない。
 * - issueの要件が承認済みだが、`implement_enabled`が無効(状態を問わない)。
 * - `approved`のissueの最新の要件承認が`attempt`と合わない。
 * - auditである(監査は再開しない)。
 */
export function computeRestartPlan(
  workItem: Pick<WorkItem, "id" | "status" | "kind" | "attempt">,
  context: RestartContext,
): RestartPlan {
  if (!isOneOf(workItem.status, RESTARTABLE_STATUSES)) {
    throw new Error(
      `retry_work_item: work item ${workItem.id} has status "${workItem.status}", not restartable (must be one of ${RESTARTABLE_STATUSES.join(", ")})`,
    );
  }

  switch (workItem.kind) {
    case "issue":
      if (context.implementReady && context.implementEnabled) {
        return {
          toStatus: "implementing",
          flowPath: IMPLEMENT_FLOW_PATH,
          args: { work_item_id: workItem.id },
        };
      }
      // 要件が承認済みでimplementフローが無効のとき、pipelineで再開すると
      // 人が承認した要件を作り直してしまう。状態を問わず拒否し、
      // 進め方をエラーで伝える。
      if (context.implementReady) {
        throw new Error(
          `retry_work_item: work item ${workItem.id} has approved requirements, but implement_enabled is false; enable it to restart the implement flow`,
        );
      }
      if (workItem.status === "approved") {
        throw new Error(
          `retry_work_item: work item ${workItem.id} is approved but its latest requirements approval does not match attempt ${workItem.attempt}; nothing to restart`,
        );
      }
      return {
        toStatus: "requirements_generating",
        flowPath: PIPELINE_FLOW_PATH,
        args: { work_item_id: workItem.id, attempt: workItem.attempt + 1 },
      };
    case "pr_review":
      return {
        toStatus: "reviewing",
        flowPath: "f/factory/pr_review",
        args: { work_item_id: workItem.id },
      };
    case "pr_fix":
      return {
        toStatus: "fixing",
        flowPath: "f/factory/pr_fix",
        args: { work_item_id: workItem.id },
      };
    case "audit":
      throw new Error(
        `retry_work_item: work item ${workItem.id} is an audit; audits are not restartable (the next weekly audit covers the failed period, or use 今すぐ監査 in the Console)`,
      );
  }
}

/**
 * flow_job_idをリースとして扱うフロー(実装フローとpipeline)への再開ならtrueを返す。
 * そのときは比較交換でリースを空け、ジョブIDは空のときだけ記録する。
 * 空けておくと、記録までの間にreconcileが終わった前のジョブを見て再開を孤児と判定せず、
 * 未記録として猶予を待つ。
 */
export function usesFlowJobIdLease(
  plan: Pick<RestartPlan, "flowPath">,
): boolean {
  return (
    plan.flowPath === IMPLEMENT_FLOW_PATH ||
    plan.flowPath === PIPELINE_FLOW_PATH
  );
}

/**
 * 記録済みのflowジョブがまだ動いているか、状態を読めなければ拒否の理由を、そうでなければnullを返す。
 * 動いている古いフローと新しいフローが同じ作業項目(実装フローなら同じworktree)を同時に書き換えないため。
 * absent(未記録・404)は拒否しない。Windmillは古い完了ジョブを消すので、拒否すると再開できなくなる。
 */
export function runningFlowRefusal(
  workItemId: number,
  flowJobId: string | null,
  job: JobState,
): string | null {
  if (flowJobId === null) return null;
  if (job.state === "running") {
    return `retry_work_item: work item ${String(workItemId)}'s flow job ${flowJobId} is still running; wait for it to finish or cancel it before restarting`;
  }
  if (job.state === "unknown") {
    return `retry_work_item: the state of work item ${String(workItemId)}'s flow job ${flowJobId} could not be read; try again later`;
  }
  return null;
}

/**
 * 再開の結果。flow_job_idは作業項目に記録したジョブIDで、別の実行が先にリースを取っていて
 * 記録しなかったときはnull(okもfalse)。started_job_idは起動したジョブのID。
 */
export type RetryWorkItemResult = {
  readonly ok: boolean;
  readonly status: WorkItemStatus;
  readonly started_job_id: string;
  readonly flow_job_id: string | null;
};

/** recordedがfalse(別の実行が先にリースを取っていた)なら、okをfalse、flow_job_idをnullにする。 */
export function retryResult(
  status: WorkItemStatus,
  startedJobId: string,
  recorded: boolean,
): RetryWorkItemResult {
  return {
    ok: recorded,
    status,
    started_job_id: startedJobId,
    flow_job_id: recorded ? startedJobId : null,
  };
}

/**
 * フローを起動できなかったときに投げる例外を作る。
 * まず`rollBack`(起動失敗の理由を注記にして`needs_human`へ戻す比較交換)を呼ぶ。
 * - 戻せたときは、起動失敗の理由を返す。
 * - `rollBack`が例外を投げたときは、その例外をマスクしてログに残し、起動失敗の理由を返す。
 *   人が見るエラーを、元の原因である起動の失敗にしておくため。
 * - `rollBack`が`false`を返したとき(別の実行がリースを持つか、作業項目が先に動いた)は、
 *   起動の応答はエラーだったが別の実行が動いていることを伝える理由を返す。
 *   フローは実際には起動していることがあり、「起動できなかった」と伝えると誤解させるため。
 */
export async function launchFailureError(
  flowPath: string,
  detail: string,
  rollBack: (reason: string) => Promise<boolean>,
  log: (message: string, fields: Record<string, unknown>) => void,
): Promise<Error> {
  const reason = `retry_work_item: ${flowPath} could not be started: ${detail}`;
  let rolledBack: boolean;
  try {
    rolledBack = await rollBack(reason);
  } catch (err) {
    log("needs_human rollback after a failed launch failed", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return new Error(reason);
  }
  if (rolledBack) return new Error(reason);
  return new Error(
    `retry_work_item: ${flowPath} returned an error, but another run holds the lease or the work item moved on, so it was not moved to needs_human: ${detail}`,
  );
}

/**
 * 再実行の前に、取り込んだ題名と本文を現在のIssueの内容へ更新するか。
 * 要件定義を作り直す再実行(Issueの作業項目を`requirements_generating`へ戻す)だけが対象である。
 * 却下が`max_attempts`に達して人の対応待ちになった作業項目は、この再実行が唯一の出口になる。
 * 実装フローの再開は、承認済みの要件定義を使うので更新しない。
 */
export function shouldRefreshIntakeOnRestart(
  workItem: Pick<WorkItem, "kind" | "issue_number">,
  plan: Pick<RestartPlan, "toStatus">,
): boolean {
  return (
    workItem.kind === "issue" &&
    workItem.issue_number !== null &&
    plan.toStatus === "requirements_generating"
  );
}

export async function main(work_item_id: number): Promise<RetryWorkItemResult> {
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`retry_work_item: no work item with id ${work_item_id}`);
  }

  const newest =
    workItem.kind === "issue" && workItem.issue_number !== null
      ? await newestNewerIssueCycle(
          workItem.owner,
          workItem.repo,
          workItem.issue_number,
          workItem.cycle,
        )
      : null;
  const superseded = newerCycleRefusal(workItem, newest, config.trigger_label);
  if (superseded !== null) throw new Error(superseded);

  const implementReady =
    workItem.kind === "issue" &&
    isRequirementsApprovedForAttempt(
      await latestRequirementsApproval(work_item_id),
      workItem.attempt,
    );
  const restartItem = asBeforeActionableCancel(
    workItem,
    workItem.status === "cancelled"
      ? await latestStatusEvent(work_item_id, "cancelled")
      : null,
  );
  const plan = computeRestartPlan(restartItem, {
    implementReady,
    implementEnabled: config.implement_enabled,
  });
  const refusal = runningFlowRefusal(
    work_item_id,
    workItem.flow_job_id,
    await readJobState(
      (id) =>
        wmill.JobService.getJob({
          workspace: process.env.WM_WORKSPACE ?? "",
          id,
          noLogs: true,
          noCode: true,
        }),
      workItem.flow_job_id,
      (failure) =>
        logger("retry_work_item").warn("flow job state could not be read", {
          work_item_id,
          flow_job_id: workItem.flow_job_id,
          ...failure,
        }),
    ),
  );
  if (refusal !== null) throw new Error(refusal);

  const cancelledRefusal = await cancelledRestartRefusal(
    workItem,
    restartItem,
    {
      newerPrRow: (item, prNumber) =>
        newestNewerPrWorkItem(
          item.kind,
          item.owner,
          item.repo,
          prNumber,
          item.id,
        ),
      // Console用のworkerには`gh`が無いので、`gh`を起動せず`fetch`で読む。
      getState: async (owner, repo, number) =>
        fetchIssueState(
          fetch,
          await wmill.getVariable("f/factory/github_token"),
          owner,
          repo,
          number,
        ),
    },
  );
  if (cancelledRefusal !== null) throw new Error(cancelledRefusal);

  const leased = usesFlowJobIdLease(plan);
  const note =
    restartItem.status === workItem.status
      ? `retry_work_item: restarted from ${workItem.status}`
      : `retry_work_item: restarted from ${workItem.status} (was ${restartItem.status} before the closed target was cancelled)`;
  let moved: boolean;
  try {
    moved = leased
      ? await updateStatusIfCurrentClearingFlowJobId(
          work_item_id,
          workItem.status,
          plan.toStatus,
          note,
        )
      : await updateStatusIfCurrent(
          work_item_id,
          workItem.status,
          plan.toStatus,
          note,
        );
  } catch (err) {
    if (!isActiveIssueUniqueViolation(err)) throw err;
    const issueNumber = workItem.issue_number;
    throw await activeIssueConflictErrorFrom(workItem, async () =>
      issueNumber === null
        ? []
        : listActiveIssueWorkItems(workItem.owner, workItem.repo, issueNumber),
    );
  }
  if (!moved) {
    throw new Error(
      `retry_work_item: work item ${work_item_id} is no longer "${workItem.status}"; not restarted`,
    );
  }

  const issueNumber = workItem.issue_number;
  if (shouldRefreshIntakeOnRestart(workItem, plan) && issueNumber !== null) {
    // Console用のworkerには`gh`が無いので、`fetch`で読む。
    // 通知はnoticeだけにする。Discordのwebhookは、このworkerに読ませない。
    await refreshIntakeFromIssue({
      snapshot: workItem,
      getIssue: async () =>
        fetchIssueContent(
          fetch,
          await wmill.getVariable("f/factory/github_token"),
          workItem.owner,
          workItem.repo,
          issueNumber,
        ),
      writeIntake: (intake, note) =>
        updateIntakeIfRegenerating(work_item_id, intake, note),
      announce: async () => {
        await addNotice({
          kind: INTAKE_REFRESHED_NOTICE_KIND,
          message: buildIntakeRefreshedNoticeMessage({
            owner: workItem.owner,
            repo: workItem.repo,
            issue_number: issueNumber,
            work_item_id,
          }),
        });
      },
      log: (message, fields) =>
        logger("retry_work_item").warn(message, { work_item_id, ...fields }),
    });
  }

  let flowJobId: string;
  try {
    flowJobId = parseFlowJobId(
      await wmill.runFlowAsync(plan.flowPath, plan.args),
      "runFlowAsync",
    );
  } catch (err) {
    // 起動できなかった作業項目を、動くジョブの無いままreconcileの猶予まで残さない。
    // flow_job_idはリースを使うフローなら比較交換で空にした値、それ以外は読み取った値のまま。
    throw await launchFailureError(
      plan.flowPath,
      maskSecrets(err instanceof Error ? err.message : String(err)),
      (reason) =>
        updateStatusIfLeaseHolder(
          work_item_id,
          plan.toStatus,
          "needs_human",
          leased ? null : workItem.flow_job_id,
          reason,
        ),
      (message, fields) =>
        logger("retry_work_item").warn(message, { work_item_id, ...fields }),
    );
  }

  let recorded = true;
  if (leased) {
    recorded = await setFlowJobIdIfUnset(work_item_id, flowJobId);
    if (!recorded) {
      logger("retry_work_item").warn(
        "flow job id not recorded; another run holds the lease",
        { work_item_id, started_job_id: flowJobId },
      );
    }
  } else {
    await setFlowJobId(work_item_id, flowJobId);
  }
  return retryResult(plan.toStatus, flowJobId, recorded);
}
