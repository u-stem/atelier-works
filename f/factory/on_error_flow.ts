// Factoryのフローの`failure_module`から呼ぶ失敗ハンドラ。
// 失敗を`job_failures`に記録し、作業項目を`failed`にして、
// Discordに`job_failed`を通知する。
//
// `failure_module`は`error`(`message`・`step_id`・`name`・`stack`)と、
// `input_transforms`で`flow_input`から渡した値を受け取る。
// `work_item_id`は`flow_input.work_item_id`から渡す前提で、
// 引数名と1対1に対応させる。`path`と`job_id`は`job_failures`の文脈として
// 受け取るが、渡さないフローもあるので省略できる。
// `path`がpipelineか設計のときは、`flow_job_id`がこの実行のルートジョブIDと一致するときだけ`failed`にする(`shouldMarkFailed`)。
//
// `pipeline_generate`の失敗も、自分で終了処理をせずここに集める。
// `retry_work_item`が行う状態やラベルの管理と干渉しないため。
//
// GitHubには成果物だけを載せ、運用上の通知(`failed`への遷移を含む)は
// DiscordとConsoleにだけ出す。そのため、作業項目を`failed`にしても
// IssueやPRには何も投稿しない。ラベルにも触れない。どの種別のトリガー
// ラベル(Issueは`factory`、PRは`factory:review`・`factory:fix`)も
// 取得時に消費済みで、外すものも付けるものも無いため。
// 運用者に届くのは、DBの`failed`への遷移と、`main()`が必ず送る
// Discordの`job_failed`通知である。設定を読めないときも、インスタンス名を伏せて通知する。
// dependabotのフローの通知には、対象のPRと、再実行を案内しない次の操作を載せる。
// dependabotの作業項目は`retry_work_item`が再開しないためである。
// GitHubの一時的な失敗で止まったpr_reviewは、`auto_retry_pr_review`が再開し、使い切った後の通知も送る。
// 作業項目を`failed`にでき、巡回の対象になるときだけ、ここで`job_failed`を送らない。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  getWorkItem,
  hasSupersedingPrReview,
  recordFailure,
  updateStatusIfLeaseHolder,
} from "./lib/db.ts";
import { DEPENDABOT_FLOW_PATH } from "./lib/dependabot_flow_support.ts";
import { type NotifyEvent, notify } from "./lib/discord.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { DESIGN_FLOW_PATH, PIPELINE_FLOW_PATH } from "./lib/pipeline_lease.ts";
import {
  decideTransientFailureAction,
  isTransientPrReviewFailure,
} from "./lib/pr_review_retry.ts";
import {
  assertGitHubName,
  type FailureRecord,
  isRecord,
  isString,
  TERMINAL_WORK_ITEM_STATUSES,
  type WorkItem,
  type WorkItemStatus,
} from "./lib/types.ts";
import { nextActionFor } from "./steps/pr_workflow_support.ts";

function errorMessage(error: unknown): string {
  if (isRecord(error) && isString(error.message)) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorStepId(error: unknown): string | null {
  if (isRecord(error) && isString(error.step_id)) return error.step_id;
  return null;
}

/**
 * `recordFailure`に渡してよい`work_item_id`を返す。存在を確かめた行のidか、
 * `null`を返す。`item`は`requestedId`で引いた結果(存在しないか、
 * 指定が無ければ`null`)。
 * `job_failures.work_item_id`は外部キーなので、存在しないidをそのまま渡すと
 * `job_failures_work_item_id_fkey`に違反し、挿入が例外になって失敗の記録
 * そのものが失われる(例外は捕まえて警告ログに残すだけ)。
 * `null`を返したとき、呼び出し側は`requestedId`をエラー文に含めて残す。
 */
export function failureWorkItemRef(
  item: Pick<WorkItem, "id"> | null,
  requestedId: number | undefined,
): number | null {
  if (item === null || requestedId === undefined) return null;
  return item.id;
}

/**
 * この呼び出しが作業項目を`failed`にしてよいかを返す。
 * `rootJobId`はこの呼び出しのフローのルートジョブid(`WM_ROOT_FLOW_JOB_ID`)、
 * `workItemFlowJobId`は`setFlowJobId`で作業項目の行に最後に記録したジョブid。
 * 古いフローの`failure_module`が動く前に、却下・再生成、`retry_work_item`、
 * 経路の切り替えで新しいフローが起動していると、2つのidは一致しない。
 * ここで`failed`にすると、新しいフローのprepareのstepが終端状態を見て
 * 黙って処理を飛ばし、再生成が失われる。
 * どちらかのidが無い(まだ記録していない、フローの外で動いている)ときは、
 * 食い違う根拠が無いとみなして許可する。
 * ただし`flowPath`がpipeline(`f/factory/pipeline`)か設計(`f/factory/design`)のときは、2つのidが一致するときだけ許可する。
 * どちらの差し戻しも`flow_job_id`を空にしてから起動するので、空の間に、
 * 記録されていない古い実行の失敗が新しい実行の作業項目を`failed`にしうるため。
 * 起動側が記録する前に落ちた作業項目は、reconcileが猶予の後に孤児として扱う。
 * `rootJobId`は小文字にしてから比べる。起動側は`parseFlowJobId`で小文字にした値を記録するため。
 */
export function shouldMarkFailed(
  workItemFlowJobId: string | null,
  rootJobId: string | null,
  flowPath: string | null,
): boolean {
  const root = rootJobId?.toLowerCase() ?? null;
  if (flowPath === PIPELINE_FLOW_PATH || flowPath === DESIGN_FLOW_PATH)
    return workItemFlowJobId !== null && workItemFlowJobId === root;
  if (workItemFlowJobId === null || root === null) return true;
  return workItemFlowJobId === root;
}

/** 設定を読めず、インスタンス名が分からないときに通知に載せる名前。 */
export const UNKNOWN_INSTANCE_NAME = "unknown";

/**
 * 失敗したフローの通知に載せる次の操作を返す。専用の案内が無いフローは`undefined`を返す。
 * dependabotの作業項目は`retry_work_item`が再開しないので、再実行を案内しない規則(`nextActionFor`の`"dependabot"`)を使う。
 */
export function failureNextAction(
  path: string | null,
  message: string,
): string | undefined {
  return path === DEPENDABOT_FLOW_PATH
    ? nextActionFor(message, "dependabot")
    : undefined;
}

/**
 * 失敗したフローの通知に載せるPRを返す。dependabotのフローで、作業項目にPR番号があるときだけ返す。
 * dependabotの失敗は再実行できず、人がPRを見て対応するので、どのPRかを通知に載せる。
 * ownerとrepoがGitHubの名前の形でなければ返さない。通知のリンクに使うためである。
 */
export function failureTargetPr(
  path: string | null,
  item: Pick<WorkItem, "owner" | "repo" | "pr_number"> | null,
): { owner: string; repo: string; number: number } | undefined {
  if (path !== DEPENDABOT_FLOW_PATH || item === null) return undefined;
  return workItemPrTarget(item);
}

/**
 * 作業項目が指すPRを、通知のリンクに使える形で返す。
 * PR番号が無いか、ownerとrepoがGitHubの名前の形でなければ返さない。
 */
function workItemPrTarget(
  item: Pick<WorkItem, "owner" | "repo" | "pr_number">,
): { owner: string; repo: string; number: number } | undefined {
  if (item.pr_number === null) return undefined;
  try {
    assertGitHubName(item.owner);
    assertGitHubName(item.repo);
  } catch {
    return undefined;
  }
  return { owner: item.owner, repo: item.repo, number: item.pr_number };
}

/** `handleFlowFailure`が使う外部の操作。テストで差し替える。 */
export type FlowFailureDeps = {
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly recordFailure: (record: FailureRecord) => Promise<unknown>;
  /** 同じPRに、置き換えた行か並走する行がPRレビューの他にあるか。 */
  readonly hasSupersedingPrReview: (id: number) => Promise<boolean>;
  readonly updateStatusIfLeaseHolder: (
    id: number,
    from: WorkItemStatus,
    to: "failed",
    flowJobId: string | null,
    note: string,
  ) => Promise<boolean>;
  /** `factory_config`の`instance_name`を読む。 */
  readonly readInstanceName: () => Promise<string>;
  readonly readWebhookUrl: () => Promise<string>;
  readonly notify: (webhookUrl: string, event: NotifyEvent) => Promise<void>;
  readonly log: Logger;
};

export type FlowFailureInput = {
  readonly error: unknown;
  readonly workItemId: number | undefined;
  readonly path: string | undefined;
  readonly jobId: string | undefined;
  /** この呼び出しのフローのルートジョブid(`WM_ROOT_FLOW_JOB_ID`)。 */
  readonly rootJobId: string | null;
  /** この呼び出し自身のジョブid(`WM_JOB_ID`)。 */
  readonly currentJobId: string | null;
};

/**
 * 失敗を記録し、作業項目を`failed`にして、通知する。
 * 3つの処理は互いに独立に試み、1つが失敗しても残りを続ける。
 * 作業項目の遷移は設定を読む前に行うので、設定を読めないときも作業項目は終端になる。
 * 通知は、設定を読めなければインスタンス名を`UNKNOWN_INSTANCE_NAME`にして送る。
 * 設定の不備でフローが止まったときこそ、運用者に知らせる必要があるためである。
 * マージやGitHubへの書き込みは行わない。終了のステップの途中で落ちたdependabotの作業項目でも、ここからマージし直すことは無い。
 */
export async function handleFlowFailure(
  deps: FlowFailureDeps,
  input: FlowFailureInput,
): Promise<void> {
  const { log } = deps;
  const { workItemId: work_item_id, path } = input;
  const message = maskSecrets(errorMessage(input.error));
  const resolvedPath = path ?? "unknown";
  const resolvedJobId =
    input.jobId ?? input.rootJobId ?? input.currentJobId ?? "unknown";

  log.error("flow failed", {
    work_item_id,
    path,
    job_id: resolvedJobId,
    error: message,
  });

  let item: WorkItem | null = null;
  if (work_item_id !== undefined) {
    try {
      item = await deps.getWorkItem(work_item_id);
    } catch (fetchErr) {
      log.error("failed to fetch work item", {
        work_item_id,
        error: maskSecrets(
          fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        ),
      });
    }
  }

  const workItemRef = failureWorkItemRef(item, work_item_id);
  const recordedError =
    work_item_id !== undefined && workItemRef === null
      ? `${message} (work_item_id ${work_item_id}: no matching row)`
      : message;

  try {
    await deps.recordFailure({
      work_item_id: workItemRef,
      flow_path: resolvedPath,
      job_id: resolvedJobId,
      step: errorStepId(input.error),
      error: recordedError,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(
        recordErr instanceof Error ? recordErr.message : String(recordErr),
      ),
    });
  }

  let markedFailed = false;
  if (item !== null && !TERMINAL_WORK_ITEM_STATUSES.includes(item.status)) {
    try {
      if (path === DEPENDABOT_FLOW_PATH && item.kind !== "dependabot") {
        // dependabotのフローに渡された作業項目の種別が違う。ほかのフローの作業項目を終端にしない。
        log.warn(
          "on_error_flow: skipping status transition — the dependabot flow ran for a work item of another kind",
          { work_item_id, kind: item.kind },
        );
      } else if (
        !shouldMarkFailed(item.flow_job_id, input.rootJobId, path ?? null)
      ) {
        log.warn(
          "on_error_flow: skipping status transition — work item's flow_job_id does not match this run (a newer run replaced it, or a pipeline run was never recorded)",
          {
            work_item_id,
            work_item_flow_job_id: item.flow_job_id,
            root_job_id: input.rootJobId,
          },
        );
      } else {
        // トリガーラベルは取得時に消費済みなので、外すラベルも付ける
        // 状態ラベルも無い。運用者にはDBの状態更新と、下のDiscordの
        // `job_failed`通知だけが届く。
        // `shouldMarkFailed`で照合した後にflow_job_idが変わっていれば(新しい実行が起動された、
        // 実装フローがリースを取ったなど)、その実行の状態を上書きしない。
        markedFailed = await deps.updateStatusIfLeaseHolder(
          item.id,
          item.status,
          "failed",
          item.flow_job_id,
          message,
        );
      }
    } catch (statusErr) {
      log.error("failed to mark work item failed", {
        work_item_id,
        error: maskSecrets(
          statusErr instanceof Error ? statusErr.message : String(statusErr),
        ),
      });
    }
  }

  let instanceName = UNKNOWN_INSTANCE_NAME;
  try {
    instanceName = await deps.readInstanceName();
  } catch (configErr) {
    log.error("failed to read factory_config for the notification", {
      error: maskSecrets(
        configErr instanceof Error ? configErr.message : String(configErr),
      ),
    });
  }

  // GitHubの一時的な失敗で止まったPRレビューは、`auto_retry_pr_review`が再開する。
  // 再開できるうちも、使い切った後も、ここでは知らせない。
  // 使い切った通知は、巡回が届いたときだけ記録する形で送るので、配信に失敗しても送り直される。
  // 巡回の対象にならない作業項目(PR番号が無い、置き換えた行か並走する行がある)は、誰にも届かないので、
  // 従来どおり知らせる。
  let sweepable = false;
  if (
    item !== null &&
    markedFailed &&
    isTransientPrReviewFailure(path ?? null, message)
  ) {
    try {
      sweepable =
        item.kind === "pr_review" &&
        item.pr_number !== null &&
        !(await deps.hasSupersedingPrReview(item.id));
    } catch (lookupErr) {
      log.error("failed to check whether the pr_review can be restarted", {
        work_item_id,
        error: maskSecrets(
          lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
        ),
      });
    }
  }
  if (
    decideTransientFailureAction(
      path ?? null,
      message,
      markedFailed,
      sweepable,
    ) === "defer"
  ) {
    log.info("transient failure; the pr_review is left to the retry sweep", {
      work_item_id,
    });
    return;
  }

  try {
    const webhookUrl = await deps.readWebhookUrl();
    if (webhookUrl.length > 0) {
      const nextAction = failureNextAction(path ?? null, message);
      const pr = failureTargetPr(path ?? null, item);
      await deps.notify(webhookUrl, {
        kind: "job_failed",
        instance_name: instanceName,
        flow_path: resolvedPath,
        job_id: resolvedJobId,
        error: message,
        ...(nextAction === undefined ? {} : { next_action: nextAction }),
        ...(pr === undefined ? {} : { pr }),
      });
    }
  } catch (notifyErr) {
    log.error("failed to send discord notification", {
      error: maskSecrets(
        notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      ),
    });
  }
}

export async function main(
  error: unknown,
  work_item_id?: number,
  path?: string,
  job_id?: string,
): Promise<void> {
  await handleFlowFailure(
    {
      getWorkItem: (id) => getWorkItem(id),
      hasSupersedingPrReview: (id) => hasSupersedingPrReview(id),
      recordFailure: (record) => recordFailure(record),
      updateStatusIfLeaseHolder: (id, from, to, flowJobId, note) =>
        updateStatusIfLeaseHolder(id, from, to, flowJobId, note),
      readInstanceName: async () =>
        (await loadConfig(() => wmill.getResource("f/factory/factory_config")))
          .instance_name,
      readWebhookUrl: () => wmill.getVariable("f/factory/discord_webhook_url"),
      notify: async (webhookUrl, event) => {
        await notify(webhookUrl, event);
      },
      log: logger("on_error_flow"),
    },
    {
      error,
      workItemId: work_item_id,
      path,
      jobId: job_id,
      rootJobId: process.env.WM_ROOT_FLOW_JOB_ID ?? null,
      currentJobId: process.env.WM_JOB_ID ?? null,
    },
  );
}
