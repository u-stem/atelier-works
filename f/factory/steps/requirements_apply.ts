// 判断済みの承認依頼(`factory.approval_requests`の`kind = "requirements"`)を処理する。
// `f/factory/approval_decide.ts`が人の判断を記録した直後に
// `wmill.runScriptByPathAsync`で起動する、フローから独立したジョブである。

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl } from "../lib/approval_support.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNotice,
  cancelSupersededApprovedWorkItem,
  getApprovalRequest,
  getWorkItem,
  isActiveIssueUniqueViolation,
  recordFailure,
  setFlowJobIdIfUnset,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { notify, notifyBestEffort } from "../lib/discord.ts";
import { commentIssue, type GhClient, getViewer } from "../lib/github.ts";
import { REQUIREMENTS_REGENERATION_FAILED_REASON } from "../lib/implement_finish_support.ts";
import {
  casToImplementingOrSupersede,
  parseFlowJobId,
  type StartImplementOutcome,
  startImplement,
} from "../lib/implement_launch_support.ts";
import { IMPLEMENT_FLOW_PATH } from "../lib/implement_loop.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { PIPELINE_FLOW_PATH } from "../lib/pipeline_lease.ts";
import { type FactoryConfig, isNumber, type WorkItem } from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

export type RequirementsApplyOutcome =
  | "approved"
  | "superseded"
  | "retrying"
  | "needs_human"
  | "no_op";

export type RequirementsApplyResult = {
  readonly outcome: RequirementsApplyOutcome;
  /** 承認したときだけ入る。implementフローを起動したかどうか。 */
  readonly implement_started?: boolean;
};

/**
 * 処理を進めてよいかを返す。作業項目がまだ`awaiting_approval`のときだけ真。
 * 副作用は無い。
 */
export function shouldProceed(status: WorkItem["status"]): boolean {
  return status === "awaiting_approval";
}

/**
 * 承認を伝える1行のIssueコメントを組み立てる。副作用は無い。
 * GitHubには成果物だけを載せる方針のため、下書きの本文は投稿せず、
 * Consoleへのリンクを1つだけ載せる。
 * リンクはMarkdownの形で書く。URLを裸で書くと、GitHubの自動リンクが
 * 直後の`(work_item_id`までURLに含めてしまい、リンクが壊れるため。
 * URLに加えて`work_item_id`も書くのは、Consoleがディープリンクの
 * フラグメントを読めないとき(opaque originのraw app。
 * `lib/approval_support.ts`の`buildConsoleUrl`を参照)の手動の代替手段にするため。
 * 人はこの値を要件定義タブの`work_item_id`フィルタに貼り付けられる。
 */
export function buildApprovedComment(
  consoleUrl: string,
  workItemId: number,
): string {
  return `要件定義が承認されました。[Consoleで要件定義を開く](${consoleUrl})(work_item_id: ${String(workItemId)})`;
}

/**
 * 承認の後に新しいサイクルが始まり、承認済みの作業項目を取り消したときに、Issueへ投稿するコメントを作る。
 * 副作用は無い。承認のコメントと同じく、投稿者の目印となる行頭のタグは付けない。
 */
export function buildSupersededComment(): string {
  return "先の承認は、ラベルを付け直して始まった新しいサイクルに置き換えられたため、取り消しました。新しい要件定義は、あらためて承認が必要です。";
}

/**
 * 承認コメントをIssueに投稿できなかったときに残すnoticeの本文を作る。副作用は無い。
 * コメントを自動で投稿し直す処理は無いので、必要なら人が投稿するよう伝え、載せるConsoleのリンクを添える。
 * URLは末尾に置く。直後に句読点が続くと、リンクに変換するときにURLに含まれてしまうため。
 */
export function buildApprovalCommentFailedMessage(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly issue_number: number;
    readonly work_item_id: number;
  },
  consoleUrl: string,
  reason: string,
): string {
  return `${target.owner}/${target.repo}#${String(target.issue_number)} (work item ${String(target.work_item_id)}): 承認のコメントをIssueに投稿できませんでした(${reason})。要件定義は承認済みで、implementフローの起動は続けます。必要なら、次のリンクを載せたコメントをIssueに人が投稿してください。要件定義のConsole: ${consoleUrl}`;
}

/**
 * implementフローを起動できなかったときに残すnoticeの本文を作る。副作用は無い。
 * 理由を訳し、次の操作を添える。
 */
export function buildImplementLaunchNoticeMessage(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly issue_number: number;
    readonly work_item_id: number;
  },
  reason: string,
): string {
  return `${target.owner}/${target.repo}#${String(target.issue_number)} (work item ${String(target.work_item_id)}): ${describeReason(reason)}。${nextActionFor(reason, "implement")}。`;
}

export type ApprovedSideEffectsDeps = {
  /** 承認を伝えるコメントをIssueに投稿する(`commentIssue`)。 */
  readonly commentIssue: () => Promise<void>;
  /** コメントを投稿できなかったときに、`approval_comment_failed`のnoticeを残す。引数は失敗の理由。 */
  readonly addCommentFailedNotice: (reason: string) => Promise<void>;
  /** Discordへ`requirements_approved`を通知する(`notifyBestEffort`)。 */
  readonly notifyApproved: () => Promise<void>;
  /**
   * 要件定義用のworktreeを消す(`removeReqWorktree`)。
   * 失敗してもwarnを残すだけで投げない約束だが、約束が破られても後続を止めないよう、呼び出し側でも捕まえる。
   */
  readonly removeWorktree: () => Promise<void>;
  /** implementフローを起動する(`startImplement`)。`implement_enabled`が偽なら`null`。 */
  readonly startImplement: (() => Promise<StartImplementOutcome>) | null;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * 作業項目を`approved`へ移した後の副作用を、コメント・通知・worktreeの片付け・implementフローの起動の順に行う。
 * 副作用ごとに失敗を捕まえ、1つが失敗しても後続を飛ばさない。
 * 作業項目はもう`awaiting_approval`ではなく、`requirements_apply`を起動し直しても何もしないため、
 * ここで例外を投げると、implementフローが起動されないまま残る。
 * コメントの失敗だけは、Issueに承認が伝わらないので、noticeに残して人に知らせる。
 * 他の失敗はwarnのログだけ残す。
 * `startImplement`は例外を投げず、結果を戻り値で返すので、ここでは捕まえない。
 */
export async function applyApprovedSideEffects(
  deps: ApprovedSideEffectsDeps,
): Promise<RequirementsApplyResult> {
  try {
    await deps.commentIssue();
  } catch (err) {
    const reason = messageOf(err);
    deps.log("failed to post the approval comment", { error: reason });
    try {
      await deps.addCommentFailedNotice(reason);
    } catch (noticeErr) {
      deps.log("failed to record the approval comment notice", {
        error: messageOf(noticeErr),
      });
    }
  }
  try {
    await deps.notifyApproved();
  } catch (err) {
    deps.log("failed to notify the approval", { error: messageOf(err) });
  }
  try {
    await deps.removeWorktree();
  } catch (err) {
    deps.log("failed to remove requirements worktree", {
      error: messageOf(err),
    });
  }
  if (deps.startImplement === null)
    return { outcome: "approved", implement_started: false };
  const launched = await deps.startImplement();
  if (launched === "superseded") {
    return { outcome: "superseded", implement_started: false };
  }
  return {
    outcome: "approved",
    implement_started:
      launched === "started" || launched === "started_without_job_id",
  };
}

export type RejectedOutcome = "retry" | "needs_human";

/**
 * 却下された下書きについて、要件定義を生成し直すか(retry)、
 * 諦めて`needs_human`にするかを返す。副作用は無い。
 * `attempt`は却下されたばかりの試行回数。
 */
export function decideRejectedOutcome(
  attempt: number,
  maxAttempts: number,
): RejectedOutcome {
  return attempt < maxAttempts ? "retry" : "needs_human";
}

export type RejectedRetryDeps = {
  /**
   * `updateStatusIfCurrentClearingFlowJobId`で`awaiting_approval`から`requirements_generating`へ移し、
   * `flow_job_id`を空にする。条件に合わなければ`false`を返す。
   */
  readonly casToGenerating: () => Promise<boolean>;
  /**
   * 要件定義用のworktreeを消す(`removeReqWorktree`)。
   * 失敗してもwarnを残すだけで投げない約束だが、約束が破られても起動を止めないよう、呼び出し側でも捕まえる。
   */
  readonly removeWorktree: () => Promise<void>;
  /** `runFlowAsync(PIPELINE_FLOW_PATH, ...)`の戻り値をそのまま返す。ジョブIDの解析は呼び出し先が行う。 */
  readonly launchPipeline: () => Promise<string>;
  /** `setFlowJobIdIfUnset`でジョブIDを記録する。別の実行が先にリースを取っていれば`false`を返す。 */
  readonly recordFlowJobId: (jobId: string) => Promise<boolean>;
  /**
   * `updateStatusIfLeaseHolder`で、リースが空のときだけ`requirements_generating`から`needs_human`へ移す。
   * 別の実行がリースを取っているか、作業項目が先に動いていれば`false`を返す。
   */
  readonly moveToNeedsHuman: (reason: string) => Promise<boolean>;
  /**
   * 比較交換が一致した直後に呼ぶ。以降の失敗は作業項目のIDを付けて記録させる。
   * 以降の失敗では作業項目が`needs_human`に戻るか、reconcileが`failed`にするので、
   * ConsoleのFailuresタブから`retry_work_item`で再開できるため。
   */
  readonly markRestartable: () => void;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * 却下された要件定義を作り直すため、作業項目を`requirements_generating`へ移してpipelineを起動する。
 * 比較交換が一致しなければ何もせずに`not_moved`を返す。
 *
 * 比較交換で`flow_job_id`(pipelineのリース)を空にし、起動したジョブIDは空のときだけ記録する。
 * pipelineは起動するとすぐ準備ステップで作業項目を読み直すので、worktreeの片付けは起動より先に行う。
 * 起動に失敗したか、ジョブIDを記録できなかった(記録が例外を投げた)ときは、
 * リースが空のときだけ`needs_human`へ戻してから例外を投げる。
 * 記録されないpipelineは準備ステップで何もせずに終わるので、戻さないと動くジョブの無いまま
 * reconcileの猶予まで残るため。例外は`main`が`job_failures`に記録して通知する。
 * 記録が`false`を返す(別の実行がリースを持つ)ときは、その実行が進めているので、ログだけ残して`retrying`を返す。
 */
export async function relaunchPipelineAfterRejection(
  deps: RejectedRetryDeps,
): Promise<"not_moved" | "retrying"> {
  if (!(await deps.casToGenerating())) return "not_moved";
  deps.markRestartable();
  try {
    await deps.removeWorktree();
  } catch (err) {
    deps.log("failed to remove requirements worktree", {
      error: messageOf(err),
    });
  }

  let jobId: string;
  try {
    jobId = parseFlowJobId(await deps.launchPipeline(), "runFlowAsync");
  } catch (err) {
    throw await rollBackToNeedsHuman(
      deps,
      `requirements_apply: ${PIPELINE_FLOW_PATH} could not be started: ${messageOf(err)}`,
    );
  }

  let recorded: boolean;
  try {
    recorded = await deps.recordFlowJobId(jobId);
  } catch (err) {
    throw await rollBackToNeedsHuman(
      deps,
      `requirements_apply: ${PIPELINE_FLOW_PATH} job ${jobId} could not be recorded: ${messageOf(err)}`,
    );
  }
  if (!recorded) {
    deps.log("pipeline flow job id not recorded; another run holds the lease", {
      started_job_id: jobId,
    });
  }
  return "retrying";
}

/**
 * `REQUIREMENTS_REGENERATION_FAILED_REASON`を理由にして`needs_human`へ戻し、投げる例外を返す。
 * 戻す比較交換が例外を投げたときはログに残し、元の失敗をそのまま返す。
 * 一致しなかったとき(別の実行がリースを持つか、作業項目が先に動いた)は、そのことを伝える例外を返す。
 * 起動は実際には成功していることがあり、「起動できなかった」と伝えると誤解させるため。
 */
async function rollBackToNeedsHuman(
  deps: RejectedRetryDeps,
  failure: string,
): Promise<Error> {
  let rolledBack: boolean;
  try {
    rolledBack = await deps.moveToNeedsHuman(
      REQUIREMENTS_REGENERATION_FAILED_REASON,
    );
  } catch (err) {
    deps.log("needs_human rollback after a failed relaunch failed", {
      error: messageOf(err),
    });
    return new Error(failure);
  }
  if (rolledBack) return new Error(failure);
  return new Error(
    `${failure}; another run holds the lease or the work item moved on, so it was not moved to needs_human`,
  );
}

/**
 * 承認依頼の`payload.attempt`を型ガードで読み、無いか数値でなければ
 * `fallback`を返す。副作用は無い。
 * "requirements"の依頼は`pipeline_request_approval.ts`が数値の`attempt`で書くが、
 * 外部のDBの値の形は確かめずに信用しない。
 */
export function readRequestAttempt(
  payload: Record<string, unknown>,
  fallback: number,
): number {
  return isNumber(payload.attempt) ? payload.attempt : fallback;
}

/** 要件定義用のworktreeを消す。失敗しても警告を記録するだけで投げない。 */
async function removeReqWorktree(workItem: WorkItem): Promise<void> {
  if (workItem.issue_number === null) return;
  const repoDir = `/workspaces/${workItem.owner}/${workItem.repo}/main`;
  const worktreeDir = `/workspaces/${workItem.owner}/${workItem.repo}/req-${workItem.issue_number}`;
  try {
    await removeWorktree({
      run: runCommand,
      repoDir,
      dir: worktreeDir,
      force: true,
    });
  } catch (err) {
    logger("requirements_apply").warn(
      "failed to remove requirements worktree",
      {
        worktreeDir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      },
    );
  }
}

/**
 * 承認依頼を読み、承認・却下に応じて作業項目を遷移させる。
 *
 * どの分岐でも先に作業項目の現在の状態を読み直し、`awaiting_approval`以外なら
 * 何もしない。並行する`poll_issues`の照合や、このスクリプトの再起動が
 * 既に作業項目を進めていることがあるため。
 * Issueのラベルはどの遷移でも付け外ししない。
 * トリガーの`factory`ラベルは着手時に消費済みで、状態は`work_items.status`だけが持つ。
 * 人がIssueにラベルを付け直すと、新しいサイクルが始まる。
 * 要件定義用のworktreeは、どの分岐でも最後に消す。
 * 承認したときは、`implement_enabled`が有効な場合に限りimplementフローを起動する。
 *
 * どの分岐でも、CAS(`updateStatusIfCurrent`)はGitHubへの副作用
 * (承認コメント)より先に行う。
 * この分岐を再び動かすものは他に無いため、GitHubの呼び出しが失敗して
 * 作業項目が`awaiting_approval`のまま残ると、判断が事実上失われる。
 * 一方でCASの後は作業項目が`awaiting_approval`ではなくなり、再起動
 * (`approval_decide.ts`の`redispatch`など)しても何もしないので、
 * CASの後で例外を投げると、後続の処理(implementフローの起動など)が行われないまま残る。
 * そのためDiscordへの通知は`notifyBestEffort`で送り、失敗してもwarnを残して続ける。
 * 承認したときのCASの後の副作用は`applyApprovedSideEffects`が受け持ち、
 * 承認コメントの投稿に失敗しても、noticeを残してimplementフローの起動まで進む。
 *
 * 承認依頼・作業項目・Issue番号が無いとき、依頼のkindが違うときは例外を投げる。
 * 却下の作り直しで作業項目を`requirements_generating`へ移せたときだけ、そのIDを`failure.work_item_id`に書く。
 * `main`が失敗を記録するときに使う。
 */
async function run(
  approval_request_id: number,
  log: Logger,
  failure: { work_item_id: number | null },
): Promise<RequirementsApplyResult> {
  const config: FactoryConfig = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const request = await getApprovalRequest(approval_request_id);
  if (request === null) {
    throw new Error(
      `requirements_apply: no approval request with id ${approval_request_id}`,
    );
  }
  if (request.kind !== "requirements") {
    throw new Error(
      `requirements_apply: approval request ${approval_request_id} has kind "${request.kind}", expected "requirements"`,
    );
  }

  const workItem = await getWorkItem(request.work_item_id);
  if (workItem === null) {
    throw new Error(
      `requirements_apply: no work item with id ${request.work_item_id}`,
    );
  }
  if (!shouldProceed(workItem.status)) {
    log.info("work item is not awaiting_approval, no-op", {
      work_item_id: workItem.id,
      status: workItem.status,
    });
    return { outcome: "no_op" };
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `requirements_apply: work item ${workItem.id} has no issue_number`,
    );
  }
  if (request.status !== "approved" && request.status !== "rejected") {
    // 防御的な検査。`approval_decide.ts`は"approved"か"rejected"を
    // 記録した直後にしかここを起動しない。
    // "expired"(またはまだ"pending")の依頼が来たなら、
    // `poll_issues.ts`の期限切れ処理と競合している。
    // 期限切れへの遷移はその処理が受け持つため、ここでは重ねて遷移させずに何もしない。
    log.info("approval request is not decided, no-op", {
      approval_request_id,
      status: request.status,
    });
    return { outcome: "no_op" };
  }

  const viewer = await getViewer(client);
  const attempt = readRequestAttempt(request.payload, workItem.attempt);

  if (request.status === "approved") {
    const updated = await updateStatusIfCurrent(
      workItem.id,
      "awaiting_approval",
      "approved",
      null,
    );
    if (!updated) {
      log.info("work item moved on before approval could be finalized", {
        work_item_id: workItem.id,
      });
      return { outcome: "no_op" };
    }
    const consoleUrl = buildConsoleUrl(config.windmill_public_url, {
      work_item_id: workItem.id,
    });
    const issueNumber = workItem.issue_number;
    const launchImplement = (): Promise<StartImplementOutcome> =>
      startImplement({
        casToImplementing: () =>
          casToImplementingOrSupersede({
            casToImplementing: () =>
              updateStatusIfCurrentClearingFlowJobId(
                workItem.id,
                "approved",
                "implementing",
                null,
              ),
            isActiveIssueConflict: isActiveIssueUniqueViolation,
            cancelSuperseded: () =>
              cancelSupersededApprovedWorkItem(
                workItem.id,
                "superseded by a newer cycle",
              ),
            postSupersededComment: async () => {
              await commentIssue(
                client,
                workItem.owner,
                workItem.repo,
                issueNumber,
                `issue-superseded-${String(attempt)}`,
                workItem.id,
                buildSupersededComment(),
                viewer.login,
              );
            },
            log: (message, fields) =>
              log.warn(message, { work_item_id: workItem.id, ...fields }),
          }),
        launchFlow: () =>
          wmill.runFlowAsync(IMPLEMENT_FLOW_PATH, {
            work_item_id: workItem.id,
          }),
        recordFlowJobId: (jobId) => setFlowJobIdIfUnset(workItem.id, jobId),
        moveToNeedsHuman: (reason) =>
          updateStatusIfLeaseHolder(
            workItem.id,
            "implementing",
            "needs_human",
            null,
            reason,
          ),
        recordFailure: async (reason, step) => {
          await recordFailure({
            work_item_id: workItem.id,
            flow_path: IMPLEMENT_FLOW_PATH,
            job_id: process.env.WM_JOB_ID ?? "unknown",
            step,
            error: reason,
          });
        },
        addNotice: async (reason) => {
          await addNotice({
            kind: "implement_launch_failed",
            message: buildImplementLaunchNoticeMessage(
              {
                owner: workItem.owner,
                repo: workItem.repo,
                issue_number: issueNumber,
                work_item_id: workItem.id,
              },
              reason,
            ),
          });
        },
        notifyNeedsHuman: async (reason) => {
          await notifyBestEffort(
            webhookUrl,
            {
              kind: "needs_human",
              instance_name: config.instance_name,
              owner: workItem.owner,
              repo: workItem.repo,
              url: workItem.issue_url ?? "",
              reason: describeReason(reason),
              target: { kind: "issue", number: issueNumber },
              next_action: nextActionFor(reason, "implement"),
            },
            log,
          );
        },
        log: (message, fields) =>
          log.warn(message, { work_item_id: workItem.id, ...fields }),
      });
    return await applyApprovedSideEffects({
      commentIssue: async () => {
        await commentIssue(
          client,
          workItem.owner,
          workItem.repo,
          issueNumber,
          `issue-approved-${String(attempt)}`,
          workItem.id,
          buildApprovedComment(consoleUrl, workItem.id),
          viewer.login,
        );
      },
      addCommentFailedNotice: async (reason) => {
        await addNotice({
          kind: "approval_comment_failed",
          message: buildApprovalCommentFailedMessage(
            {
              owner: workItem.owner,
              repo: workItem.repo,
              issue_number: issueNumber,
              work_item_id: workItem.id,
            },
            consoleUrl,
            reason,
          ),
        });
      },
      notifyApproved: async () => {
        await notifyBestEffort(
          webhookUrl,
          {
            kind: "requirements_approved",
            instance_name: config.instance_name,
            owner: workItem.owner,
            repo: workItem.repo,
            issue_number: issueNumber,
            issue_url: workItem.issue_url ?? "",
            title: workItem.title ?? "",
            console_url: consoleUrl,
          },
          log,
        );
      },
      removeWorktree: () => removeReqWorktree(workItem),
      startImplement: config.implement_enabled ? launchImplement : null,
      log: (message, fields) =>
        log.warn(message, { work_item_id: workItem.id, ...fields }),
    });
  }

  // ここからは却下のとき。
  const rejectedOutcome = decideRejectedOutcome(attempt, config.max_attempts);
  if (rejectedOutcome === "retry") {
    const relaunched = await relaunchPipelineAfterRejection({
      casToGenerating: () =>
        updateStatusIfCurrentClearingFlowJobId(
          workItem.id,
          "awaiting_approval",
          "requirements_generating",
          request.reason,
        ),
      removeWorktree: () => removeReqWorktree(workItem),
      launchPipeline: () =>
        wmill.runFlowAsync(PIPELINE_FLOW_PATH, {
          work_item_id: workItem.id,
          attempt: attempt + 1,
          feedback: request.reason ?? "",
        }),
      recordFlowJobId: (jobId) => setFlowJobIdIfUnset(workItem.id, jobId),
      moveToNeedsHuman: (reason) =>
        updateStatusIfLeaseHolder(
          workItem.id,
          "requirements_generating",
          "needs_human",
          null,
          reason,
        ),
      markRestartable: () => {
        failure.work_item_id = workItem.id;
      },
      log: (message, fields) =>
        log.warn(message, { work_item_id: workItem.id, ...fields }),
    });
    if (relaunched === "not_moved") {
      log.info("work item moved on before retry could be started", {
        work_item_id: workItem.id,
      });
      return { outcome: "no_op" };
    }
    return { outcome: "retrying" };
  }

  const updated = await updateStatusIfCurrent(
    workItem.id,
    "awaiting_approval",
    "needs_human",
    request.reason,
  );
  if (!updated) {
    log.info("work item moved on before needs_human could be recorded", {
      work_item_id: workItem.id,
    });
    return { outcome: "no_op" };
  }
  await notifyBestEffort(
    webhookUrl,
    {
      kind: "needs_human",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      url: workItem.issue_url ?? "",
      reason: describeReason(`rejected ${String(config.max_attempts)} times`),
      target: { kind: "issue", number: workItem.issue_number },
      next_action: nextActionFor(
        `rejected ${String(config.max_attempts)} times`,
      ),
    },
    log,
  );
  await removeReqWorktree(workItem);
  return { outcome: "needs_human" };
}

/**
 * `approval_request_id`の承認依頼を処理し、その結果を返す。
 * このスクリプトはフローのステップではなく単独で動くため、
 * フローの`on_error_flow`に頼れない。
 * そのため例外はここで捕まえ、`factory.job_failures`に記録して
 * Discordへ通知してから投げ直す(`on_error_schedule.ts`と同じ自己完結の処理)。
 * 作業項目のIDを付けて記録するのは、却下の作り直しで`requirements_generating`へ移した後の失敗だけである。
 * その作業項目は`retry_work_item`で再開できる状態で終わるので、ConsoleのFailuresタブから再実行できる。
 * 比較交換より前の失敗では作業項目が`awaiting_approval`のままで、`retry_work_item`では再開できないため、IDを付けない。
 * その場合は同じ判断で`approval_decide`を実行し直す。
 * 承認後のimplementフローの起動の失敗は、`startImplement`が作業項目のIDを付けて記録する。
 */
export async function main(
  approval_request_id: number,
): Promise<RequirementsApplyResult> {
  const log = logger("requirements_apply");
  const failure: { work_item_id: number | null } = { work_item_id: null };
  try {
    return await run(approval_request_id, log, failure);
  } catch (err) {
    const message = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    log.error("requirements_apply failed", { error: message });
    try {
      await recordFailure({
        work_item_id: failure.work_item_id,
        flow_path: "f/factory/steps/requirements_apply",
        job_id: process.env.WM_JOB_ID ?? "unknown",
        step: null,
        error: message,
      });
    } catch (recordErr) {
      log.error("failed to record failure", {
        error: maskSecrets(
          recordErr instanceof Error ? recordErr.message : String(recordErr),
        ),
      });
    }
    try {
      const config = await loadConfig(() =>
        wmill.getResource("f/factory/factory_config"),
      );
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        await notify(webhookUrl, {
          kind: "job_failed",
          instance_name: config.instance_name,
          flow_path: "f/factory/steps/requirements_apply",
          job_id: process.env.WM_JOB_ID ?? "unknown",
          error: message,
        });
      }
    } catch (notifyErr) {
      log.error("failed to send discord notification", {
        error: maskSecrets(
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        ),
      });
    }
    throw err;
  }
}
