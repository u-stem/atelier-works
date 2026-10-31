// 判断済みの承認依頼(`factory.approval_requests`の`kind = "requirements"`)を処理する。
// `f/factory/approval_decide.ts`が人の判断を記録した直後に
// `wmill.runScriptByPathAsync`で起動する、フローから独立したジョブである。

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl } from "../lib/approval_support.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getApprovalRequest,
  getWorkItem,
  latestApprovalRequest,
  recordFailure,
  setFlowJobIdIfUnset,
  updateIntakeIfRegenerating,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import {
  type DesignLaunchDeps,
  designFlowInput,
  type StartDesignOutcome,
  startDesign,
} from "../lib/design_launch_support.ts";
import { type NotifyEvent, notify, notifyBestEffort } from "../lib/discord.ts";
import {
  commentIssue,
  type GhClient,
  getIssue,
  getViewer,
} from "../lib/github.ts";
import { REQUIREMENTS_REGENERATION_FAILED_REASON } from "../lib/implement_finish_support.ts";
import {
  parseFlowJobId,
  type StartImplementOutcome,
  startImplement,
} from "../lib/implement_launch_support.ts";
import { IMPLEMENT_FLOW_PATH } from "../lib/implement_loop.ts";
import {
  buildIntakeRefreshedNoticeMessage,
  INTAKE_REFRESHED_NOTICE_KIND,
  refreshIntakeFromIssue,
} from "../lib/intake_refresh.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { DESIGN_FLOW_PATH, PIPELINE_FLOW_PATH } from "../lib/pipeline_lease.ts";
import {
  type FactoryConfig,
  type FailureRecord,
  isNumber,
  type WorkItem,
} from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import {
  describeReason,
  type NextActionFlow,
  nextActionFor,
} from "./pr_workflow_support.ts";

export type RequirementsApplyOutcome =
  | "approved"
  | "retrying"
  | "needs_human"
  | "no_op";

export type RequirementsApplyResult = {
  readonly outcome: RequirementsApplyOutcome;
  /** 承認したときだけ入る。implementフローを起動したかどうか。 */
  readonly implement_started?: boolean;
  /** 設計フローへ進めたときだけ入る。設計フローを起動できたかどうか。 */
  readonly design_started?: boolean;
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
 * URLに加えて`work_item_id`も書くのは、リンクが開けないときでも、
 * 人がどの作業項目の承認かを特定できるようにするため。
 */
export function buildApprovedComment(
  consoleUrl: string,
  workItemId: number,
): string {
  return `要件定義が承認されました。[Consoleで要件定義を開く](${consoleUrl})(work_item_id: ${String(workItemId)})`;
}

/**
 * 承認コメントをIssueに投稿できなかったときに残すnoticeの本文を作る。副作用は無い。
 * `next`は承認の後に起動するフローで、noticeに「そのフローの起動は続ける」ことを書く。
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
  next: "implement" | "design" = "implement",
): string {
  const nextFlow = next === "design" ? "設計フロー" : "implementフロー";
  return `${target.owner}/${target.repo}#${String(target.issue_number)} (work item ${String(target.work_item_id)}): 承認のコメントをIssueに投稿できませんでした(${reason})。要件定義は承認済みで、${nextFlow}の起動は続けます。必要なら、次のリンクを載せたコメントをIssueに人が投稿してください。要件定義のConsole: ${consoleUrl}`;
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
  readonly addCommentFailedNotice: (
    reason: string,
    next?: "implement" | "design",
  ) => Promise<void>;
  /** Discordへ`requirements_approved`を通知する(`notifyBestEffort`)。 */
  readonly notifyApproved: () => Promise<void>;
  /**
   * 要件定義用のworktreeを消す(`removeReqWorktree`)。
   * 失敗してもwarnを残すだけで投げない約束だが、約束が破られても後続を止めないよう、呼び出し側でも捕まえる。
   */
  readonly removeWorktree: () => Promise<void>;
  /** implementフローを起動する(`startImplement`)。`implement_enabled`が偽なら`null`。 */
  readonly startImplement: (() => Promise<StartImplementOutcome>) | null;
  /** 設計フローを起動する(`startDesign`)。無いか`null`なら起動しない。 */
  readonly startDesign?: (() => Promise<StartDesignOutcome>) | null;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * 作業項目を`approved`か`designing`へ移した後の副作用を、コメント・通知・worktreeの片付け・次のフローの起動の順に行う。
 * 次のフローは、`startDesign`があれば設計フロー、無ければimplementフローである。両方は起動しない。
 * 副作用ごとに失敗を捕まえ、1つが失敗しても後続を飛ばさない。
 * 作業項目はもう`awaiting_approval`ではなく、`requirements_apply`を起動し直しても何もしないため、
 * ここで例外を投げると、次のフローが起動されないまま残る。
 * コメントの失敗だけは、Issueに承認が伝わらないので、noticeに残して人に知らせる。
 * 他の失敗はwarnのログだけ残す。
 * `startImplement`と`startDesign`は例外を投げず、結果を戻り値で返すので、ここでは捕まえない。
 */
export async function applyApprovedSideEffects(
  deps: ApprovedSideEffectsDeps,
): Promise<RequirementsApplyResult> {
  const startDesignFlow = deps.startDesign ?? null;
  try {
    await deps.commentIssue();
  } catch (err) {
    const reason = messageOf(err);
    deps.log("failed to post the approval comment", { error: reason });
    try {
      await deps.addCommentFailedNotice(
        reason,
        startDesignFlow === null ? "implement" : "design",
      );
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
  if (startDesignFlow !== null) {
    const designed = await startDesignFlow();
    return {
      outcome: "approved",
      implement_started: false,
      design_started: designed === "started",
    };
  }
  if (deps.startImplement === null)
    return { outcome: "approved", implement_started: false };
  const launched = await deps.startImplement();
  return {
    outcome: "approved",
    implement_started:
      launched === "started" || launched === "started_without_job_id",
  };
}

export type ApprovedBranchDeps = ApprovedSideEffectsDeps & {
  /** `updateStatusIfCurrent`で`awaiting_approval`から`approved`へ移す。移せなければ`false`。 */
  readonly casToApproved: () => Promise<boolean>;
  /**
   * `updateStatusIfCurrentClearingFlowJobId`で`awaiting_approval`から`designing`へ移し、`flow_job_id`を空にする。
   * 移せなければ`false`。
   */
  readonly casToDesigning: () => Promise<boolean>;
  /** 設計フローを起動する(`startDesign`)。設計工程を開けていないなら`null`。 */
  readonly startDesign: (() => Promise<StartDesignOutcome>) | null;
};

/**
 * 承認の分岐。`startDesign`があれば作業項目を`designing`へ、無ければ今のとおり`approved`へ、
 * どちらも副作用より前に比較交換で移す。移せなければ何もせず`no_op`を返す。
 * 移せたら`applyApprovedSideEffects`を行う。設計へ進むときは、implementフローを起動しない。
 * 行き先を比較交換の前に選ぶのは、副作用の後に作業項目を動かすと、副作用が失敗した後の再起動が何もしないためである。
 * `approved`を経由しないので、設計へ進むときは承認の行(`approval_requests`の`approved`)が、
 * 要件定義が承認されたことの唯一の根拠になる。
 */
export async function applyApprovedBranch(
  deps: ApprovedBranchDeps,
): Promise<RequirementsApplyResult> {
  const toDesign = deps.startDesign !== null;
  const moved = toDesign
    ? await deps.casToDesigning()
    : await deps.casToApproved();
  if (!moved) return { outcome: "no_op" };
  return applyApprovedSideEffects(
    toDesign ? { ...deps, startImplement: null } : deps,
  );
}

export type ApprovedBranchContext = {
  readonly workItem: WorkItem;
  readonly issueNumber: number;
  /** 承認された要件定義の試行。 */
  readonly attempt: number;
  readonly client: GhClient;
  readonly viewerLogin: string;
  readonly webhookUrl: string;
  readonly log: Logger;
};

/** `needs_human`の通知と、フローの起動の手順が使う、作業項目とログの文脈。 */
export type NotifyContext = {
  readonly workItem: Pick<
    WorkItem,
    "id" | "owner" | "repo" | "issue_url" | "design_attempt"
  >;
  readonly issueNumber: number;
  readonly webhookUrl: string;
  readonly log: Logger;
};

/**
 * implementフローを起動する手順の本番の依存を組み立てる(`startImplement`に渡す)。
 * 呼ぶだけでは、DB・GitHub・Windmillに触れない。返した関数を呼ぶと、作業項目を`approved`から`implementing`へ移して起動する。
 * 起動か記録に失敗したら`needs_human`へ戻し、noticeとDiscordで知らせる(`startImplement`)。
 * 要件定義の承認の反映(`buildApprovedBranchDeps`)と設計の承認の反映(`steps/design_apply.ts`)が共有する。
 */
export function buildStartImplement(
  config: Pick<FactoryConfig, "instance_name">,
  ctx: NotifyContext,
): () => Promise<StartImplementOutcome> {
  const { workItem, issueNumber, log } = ctx;
  const noticeTarget = {
    owner: workItem.owner,
    repo: workItem.repo,
    issue_number: issueNumber,
    work_item_id: workItem.id,
  };
  return () =>
    startImplement({
      casToImplementing: () =>
        updateStatusIfCurrentClearingFlowJobId(
          workItem.id,
          "approved",
          "implementing",
          null,
        ),
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
        await addNoticeUnlessUnresolved({
          kind: "implement_launch_failed",
          message: buildImplementLaunchNoticeMessage(noticeTarget, reason),
        });
      },
      notifyNeedsHuman: (reason) =>
        notifyNeedsHumanBestEffort(ctx, config, reason, "implement"),
      log: (message, fields) =>
        log.warn(message, { work_item_id: workItem.id, ...fields }),
    });
}

/**
 * 承認の分岐の本番の依存を組み立てる。呼ぶだけでは、DB・GitHub・Windmillに触れない。
 * 設計フローは、設定の`design_enabled`が真のときだけ結ぶ。偽のときは`null`で、承認は今までどおり実装へ進む。
 * 本番の設定の読み込み(`parseFactoryConfig`)は、`design_enabled_since`が日時として読めるまで、`design_enabled: true`を偽として読む。
 */
export function buildApprovedBranchDeps(
  config: Pick<
    FactoryConfig,
    | "implement_enabled"
    | "design_enabled"
    | "windmill_public_url"
    | "instance_name"
  >,
  ctx: ApprovedBranchContext,
): ApprovedBranchDeps {
  const { workItem, issueNumber, attempt, client, viewerLogin, log } = ctx;
  const consoleUrl = buildConsoleUrl(config.windmill_public_url, {
    work_item_id: workItem.id,
    attempt,
  });
  const noticeTarget = {
    owner: workItem.owner,
    repo: workItem.repo,
    issue_number: issueNumber,
    work_item_id: workItem.id,
  };
  return {
    casToApproved: () =>
      updateStatusIfCurrent(workItem.id, "awaiting_approval", "approved", null),
    casToDesigning: () =>
      updateStatusIfCurrentClearingFlowJobId(
        workItem.id,
        "awaiting_approval",
        "designing",
        null,
      ),
    commentIssue: async () => {
      await commentIssue(
        client,
        workItem.owner,
        workItem.repo,
        issueNumber,
        `issue-approved-${String(attempt)}`,
        workItem.id,
        buildApprovedComment(consoleUrl, workItem.id),
        viewerLogin,
      );
    },
    addCommentFailedNotice: async (reason, next) => {
      await addNoticeUnlessUnresolved({
        kind: "approval_comment_failed",
        message: buildApprovalCommentFailedMessage(
          noticeTarget,
          consoleUrl,
          reason,
          next,
        ),
      });
    },
    notifyApproved: async () => {
      await notifyBestEffort(
        ctx.webhookUrl,
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
    startImplement: config.implement_enabled
      ? buildStartImplement(config, ctx)
      : null,
    startDesign: config.design_enabled ? buildStartDesign(config, ctx) : null,
    log: (message, fields) =>
      log.warn(message, { work_item_id: workItem.id, ...fields }),
  };
}

/** `needs_human`のDiscord通知を、失敗しても例外を投げずに送る。 */
export async function notifyNeedsHumanBestEffort(
  ctx: NotifyContext,
  config: Pick<FactoryConfig, "instance_name">,
  reason: string,
  flow: NextActionFlow | undefined,
  send: StartDesignPorts["notifyBestEffort"] = notifyBestEffort,
): Promise<void> {
  await send(
    ctx.webhookUrl,
    {
      kind: "needs_human",
      instance_name: config.instance_name,
      owner: ctx.workItem.owner,
      repo: ctx.workItem.repo,
      url: ctx.workItem.issue_url ?? "",
      reason: describeReason(reason),
      target: { kind: "issue", number: ctx.issueNumber },
      next_action: nextActionFor(reason, flow),
    },
    ctx.log,
  );
}

/** `buildStartDesign`が使うDB・Windmill・Discordの呼び出し。テストでは差し替える。 */
export type StartDesignPorts = {
  readonly runFlowAsync: (
    path: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  readonly setFlowJobIdIfUnset: (id: number, jobId: string) => Promise<boolean>;
  readonly updateStatusIfLeaseHolder: (
    id: number,
    expectedFrom: WorkItem["status"],
    to: WorkItem["status"],
    expectedFlowJobId: string | null,
    note: string | null,
  ) => Promise<boolean>;
  readonly recordFailure: (record: FailureRecord) => Promise<unknown>;
  readonly notifyBestEffort: (
    webhookUrl: string,
    event: NotifyEvent,
    log: Logger,
  ) => Promise<unknown>;
};

const REAL_START_DESIGN_PORTS: StartDesignPorts = {
  runFlowAsync: (path, args) => wmill.runFlowAsync(path, args),
  setFlowJobIdIfUnset: (id, jobId) => setFlowJobIdIfUnset(id, jobId),
  updateStatusIfLeaseHolder: (id, expectedFrom, to, expectedFlowJobId, note) =>
    updateStatusIfLeaseHolder(id, expectedFrom, to, expectedFlowJobId, note),
  recordFailure: (record) => recordFailure(record),
  notifyBestEffort: (webhookUrl, event, log) =>
    notifyBestEffort(webhookUrl, event, log),
};

/**
 * 設計フローを起動する手順の本番の依存を組み立てる(`startDesign`に渡す)。
 * 返した関数を呼ぶまでは、DB・GitHub・Windmillに触れない。
 * 起動先は設計フロー、入力は作業項目の次の設計の試行と`feedback`で、起動か記録に失敗したら`needs_human`へ戻す(`startDesign`)。
 * `feedback`は設計の再生成のときだけ渡し、最初の起動は空である。人の却下の理由か、実装が返した設計の不足の報告
 * (`automatedFeedback`の印つき。呼び出し側が整える)で、ここでは整形も切り詰めもせずに渡す。
 * 設計の生成は、印の有無で人の理由と信頼できない報告を区別する。
 * `ports`は呼び出しの入出力で、テストが差し替える。
 */
export function buildStartDesign(
  config: Pick<FactoryConfig, "instance_name">,
  ctx: NotifyContext,
  ports: StartDesignPorts = REAL_START_DESIGN_PORTS,
  feedback = "",
): () => Promise<StartDesignOutcome> {
  const { workItem, issueNumber, log } = ctx;
  const deps: DesignLaunchDeps = {
    launchFlow: () =>
      ports.runFlowAsync(DESIGN_FLOW_PATH, designFlowInput(workItem, feedback)),
    recordFlowJobId: (jobId) => ports.setFlowJobIdIfUnset(workItem.id, jobId),
    moveToNeedsHuman: (reason) =>
      ports.updateStatusIfLeaseHolder(
        workItem.id,
        "designing",
        "needs_human",
        null,
        reason,
      ),
    recordFailure: async (reason, step) => {
      await ports.recordFailure({
        work_item_id: workItem.id,
        flow_path: DESIGN_FLOW_PATH,
        job_id: process.env.WM_JOB_ID ?? "unknown",
        step,
        error: reason,
      });
    },
    // 作業項目は`needs_human`になってConsoleの要対応に出るので、noticeは足さずにログへ残す。
    addNotice: async (reason) => {
      log.warn("design flow could not be started", {
        work_item_id: workItem.id,
        issue_number: issueNumber,
        error: reason,
      });
    },
    notifyNeedsHuman: (reason) =>
      notifyNeedsHumanBestEffort(
        ctx,
        config,
        reason,
        "design",
        ports.notifyBestEffort,
      ),
    log: (message, fields) =>
      log.warn(message, { work_item_id: workItem.id, ...fields }),
  };
  return () => startDesign(deps);
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
  /**
   * 作業項目に取り込んだ題名と本文を、現在のIssueの内容に更新する(`refreshIntakeFromIssue`)。
   * 比較交換の後、pipelineを起動する前に呼ぶ。pipelineは起動後に作業項目を読むので、新しい内容で作り直される。
   * 更新できなくても作り直しは止めないので、投げない約束だが、約束が破られても起動を止めないよう、呼び出し側でも捕まえる。
   */
  readonly refreshIntake: () => Promise<unknown>;
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
   * Consoleの要対応から`retry_work_item`で再開できるため。
   */
  readonly markRestartable: () => void;
  /** 作業項目を`needs_human`に戻せたときに、直後に呼ぶ。失敗しても作り直しの失敗の報告は変えない。 */
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * 却下された要件定義を作り直すため、作業項目を`requirements_generating`へ移してpipelineを起動する。
 * 比較交換が一致しなければ何もせずに`not_moved`を返す。
 * 移した後、起動の前に、取り込んだ題名と本文を現在のIssueの内容に更新する(`refreshIntake`)。
 *
 * 比較交換で`flow_job_id`(pipelineのリース)を空にし、起動したジョブIDは空のときだけ記録する。
 * pipelineは起動するとすぐ準備ステップで作業項目を読み直すので、worktreeの片付けは起動より先に行う。
 * 起動に失敗したか、ジョブIDを記録できなかった(記録が例外を投げた)ときは、
 * リースが空のときだけ`needs_human`へ戻してから例外を投げる。
 * 記録されないpipelineは準備ステップで何もせずに終わるので、戻さないと動くジョブの無いまま
 * reconcileの猶予まで残るため。例外は`main`が`job_failures`に記録して通知する。
 * 記録が`false`を返す(別の実行がリースを持つ)ときは、その実行が進めているので、ログだけ残して`retrying`を返す。
 * `needs_human`へ戻せたときは、直後に`needs_human`を通知する(`notifyNeedsHuman`)。戻せなかったときは通知しない。
 * `label`は例外の文の接頭辞で、呼び出し元のscriptの名前を渡す。
 */
export async function relaunchPipelineAfterRejection(
  deps: RejectedRetryDeps,
  label = "requirements_apply",
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

  try {
    await deps.refreshIntake();
  } catch (err) {
    deps.log("failed to refresh the intake content", {
      error: messageOf(err),
    });
  }

  let jobId: string;
  try {
    jobId = parseFlowJobId(await deps.launchPipeline(), "runFlowAsync");
  } catch (err) {
    throw await rollBackToNeedsHuman(
      deps,
      `${label}: ${PIPELINE_FLOW_PATH} could not be started: ${messageOf(err)}`,
    );
  }

  let recorded: boolean;
  try {
    recorded = await deps.recordFlowJobId(jobId);
  } catch (err) {
    throw await rollBackToNeedsHuman(
      deps,
      `${label}: ${PIPELINE_FLOW_PATH} job ${jobId} could not be recorded: ${messageOf(err)}`,
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
 * 戻せたときは、`needs_human`を通知する(通知の失敗は握りつぶしてログに残す)。
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
  if (rolledBack) {
    try {
      await deps.notifyNeedsHuman(REQUIREMENTS_REGENERATION_FAILED_REASON);
    } catch (err) {
      deps.log("failed to notify the needs_human after a failed relaunch", {
        error: messageOf(err),
      });
    }
    return new Error(failure);
  }
  return new Error(
    `${failure}; another run holds the lease or the work item moved on, so it was not moved to needs_human`,
  );
}

/**
 * 作業項目の最新の承認依頼(`latestApprovalRequest`の結果)が、この依頼かを返す。副作用は無い。
 * 古い(承認済みの)依頼を再実行しても、新しい依頼の判断を待つ作業項目を動かさないための確認である。
 * 最新の依頼が無いときは、最新ではないものとして扱う。
 */
export function isLatestApprovalRequest(
  latest: { readonly id: number } | null,
  requestId: number,
): boolean {
  return latest !== null && latest.id === requestId;
}

/** `reportApplyFailure`が使うDBとDiscordの呼び出し。テストでは差し替える。 */
export type ApplyFailurePorts = {
  readonly recordFailure: (record: FailureRecord) => Promise<unknown>;
  readonly notifyJobFailed: (
    flowPath: string,
    jobId: string,
    error: string,
  ) => Promise<void>;
};

const REAL_APPLY_FAILURE_PORTS: ApplyFailurePorts = {
  recordFailure: (record) => recordFailure(record),
  notifyJobFailed: async (flowPath, jobId, error) => {
    const config = await loadConfig(() =>
      wmill.getResource("f/factory/factory_config"),
    );
    const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
    if (webhookUrl.length === 0) return;
    await notify(webhookUrl, {
      kind: "job_failed",
      instance_name: config.instance_name,
      flow_path: flowPath,
      job_id: jobId,
      error,
    });
  },
};

/**
 * 承認の反映のscriptの失敗を、`factory.job_failures`に記録し、Discordへ`job_failed`を通知する。
 * 例外を投げない。呼び出し側が元の例外を投げ直す。
 * このscriptはフローのステップではなく単独で動くため、フローの`on_error_flow`に頼れない。
 * `failure.work_item_id`があるときだけ作業項目のIDを付けて記録する。その作業項目は
 * `retry_work_item`で再開できる状態で終わるので、Consoleの要対応から再実行できる。
 * 比較交換より前の失敗では作業項目が承認待ちのままで、`retry_work_item`では再開できないため、IDを付けない。
 * その場合は同じ判断で`approval_decide`を実行し直す。
 * 記録と通知はそれぞれ失敗しても、もう一方を止めない。
 */
export async function reportApplyFailure(
  flowPath: string,
  err: unknown,
  failure: { work_item_id: number | null },
  log: Logger,
  ports: ApplyFailurePorts = REAL_APPLY_FAILURE_PORTS,
): Promise<void> {
  const message = messageOf(err);
  const jobId = process.env.WM_JOB_ID ?? "unknown";
  const name = flowPath.split("/").at(-1) ?? flowPath;
  log.error(`${name} failed`, { error: message });
  try {
    await ports.recordFailure({
      work_item_id: failure.work_item_id,
      flow_path: flowPath,
      job_id: jobId,
      step: null,
      error: message,
    });
  } catch (recordErr) {
    log.error("failed to record failure", { error: messageOf(recordErr) });
  }
  try {
    await ports.notifyJobFailed(flowPath, jobId, message);
  } catch (notifyErr) {
    log.error("failed to send discord notification", {
      error: messageOf(notifyErr),
    });
  }
}

/**
 * 却下の作り直しの前に、作業項目に取り込んだ題名と本文を現在のIssueの内容に更新する手順の本番の依存を組み立てる。
 * 更新したことは、noticeとDiscordの`intake_refreshed`で承認者に知らせる。noticeの失敗でDiscordへの通知を止めない。
 * 要件定義の却下の作り直しと、設計の却下でIssueが変わっていたときの要件定義への戻しが共有する。
 */
export function buildRefreshIntake(args: {
  readonly workItem: WorkItem;
  readonly issueNumber: number;
  readonly client: GhClient;
  readonly webhookUrl: string;
  readonly instanceName: string;
  readonly log: Logger;
}): () => Promise<unknown> {
  const { workItem, issueNumber, client, webhookUrl, instanceName, log } = args;
  return () =>
    refreshIntakeFromIssue({
      snapshot: workItem,
      getIssue: () =>
        getIssue(client, workItem.owner, workItem.repo, issueNumber),
      writeIntake: (intake, note) =>
        updateIntakeIfRegenerating(workItem.id, intake, note),
      announce: async (updated) => {
        try {
          await addNoticeUnlessUnresolved({
            kind: INTAKE_REFRESHED_NOTICE_KIND,
            message: buildIntakeRefreshedNoticeMessage({
              owner: workItem.owner,
              repo: workItem.repo,
              issue_number: issueNumber,
              work_item_id: workItem.id,
            }),
          });
        } catch (err) {
          log.warn("failed to record the intake refresh notice", {
            work_item_id: workItem.id,
            error: messageOf(err),
          });
        }
        await notifyBestEffort(
          webhookUrl,
          {
            kind: "intake_refreshed",
            instance_name: instanceName,
            owner: workItem.owner,
            repo: workItem.repo,
            issue_number: issueNumber,
            issue_url: workItem.issue_url ?? "",
            title: updated.title,
          },
          log,
        );
      },
      log: (message, fields) =>
        log.warn(message, { work_item_id: workItem.id, ...fields }),
    });
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
  // 最新の依頼かは、下書きと結合しない問い合わせで確かめる。下書きに結合できない最新の依頼を読み飛ばすと、
  // 古い承認を最新として返し、古い依頼で新しい依頼の判断を待つ作業項目を動かしてしまう。
  const latest = await latestApprovalRequest(workItem.id, "requirements");
  if (!isLatestApprovalRequest(latest, request.id)) {
    log.info("approval request is not the latest, no-op", {
      approval_request_id,
      work_item_id: workItem.id,
      latest_approval_request_id: latest?.id ?? null,
    });
    return { outcome: "no_op" };
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
    const result = await applyApprovedBranch(
      buildApprovedBranchDeps(config, {
        workItem,
        issueNumber: workItem.issue_number,
        attempt,
        client,
        viewerLogin: viewer.login,
        webhookUrl,
        log,
      }),
    );
    if (result.outcome === "no_op") {
      log.info("work item moved on before approval could be finalized", {
        work_item_id: workItem.id,
      });
    }
    return result;
  }

  // ここからは却下のとき。
  const rejectedOutcome = decideRejectedOutcome(attempt, config.max_attempts);
  if (rejectedOutcome === "retry") {
    const intakeIssueNumber = workItem.issue_number;
    const relaunched = await relaunchPipelineAfterRejection({
      casToGenerating: () =>
        updateStatusIfCurrentClearingFlowJobId(
          workItem.id,
          "awaiting_approval",
          "requirements_generating",
          request.reason,
        ),
      removeWorktree: () => removeReqWorktree(workItem),
      refreshIntake: buildRefreshIntake({
        workItem,
        issueNumber: intakeIssueNumber,
        client,
        webhookUrl,
        instanceName: config.instance_name,
        log,
      }),
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
      notifyNeedsHuman: (reason) =>
        notifyNeedsHumanBestEffort(
          { workItem, issueNumber: intakeIssueNumber, webhookUrl, log },
          config,
          reason,
          undefined,
        ),
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
 * Discordへ通知してから投げ直す(`on_error_flow.ts`と同じ自己完結の処理)。
 * 作業項目のIDを付けて記録するのは、却下の作り直しで`requirements_generating`へ移した後の失敗だけである。
 * その作業項目は`retry_work_item`で再開できる状態で終わるので、Consoleの要対応から再実行できる。
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
    await reportApplyFailure(
      "f/factory/steps/requirements_apply",
      err,
      failure,
      log,
    );
    throw err;
  }
}
