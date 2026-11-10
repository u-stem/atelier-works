// 書き込みが成功したときに画面へ出す知らせ(トースト)の文。
// 失敗の文は`describeWriteFailure`が作るので、ここでは作らない。

import type { WriteOutcome } from "../api/executeWrite.ts";
import type {
  ActionAudit,
  ApprovalDecideResult,
  AuditKickoffResult,
  AuditSkipReason,
  ConfigUpdateRefusalReason,
  ConfigUpdateResult,
  DeployDecideResult,
  FreezeReleaseResult,
  HoldPlaceRefusalReason,
  HoldPlaceResult,
  HoldReleaseResult,
  JobCancelRefusalReason,
  JobCancelResult,
  JobCancelWorkItem,
  JobRerunRefusalReason,
  JobRerunResult,
  NoticeResolveResult,
  RetryWorkItemResult,
  ScheduleStopRefusalReason,
  ScheduleStopResult,
  StopAllRefusalReason,
  StopAllReleaseRefusalReason,
  StopAllReleaseResult,
  StopAllResult,
} from "../api/guards/writeResults.ts";
import { LAST_ELEMENT_NOTE } from "./configChange.ts";
import {
  STOP_MIN_REMAINING_MINUTES,
  STOP_READY_AFTER_MINUTES,
  stopImpactNote,
  stopWindowStart,
} from "./holdPlace.ts";
import { workItemStatusLabel } from "./labels.ts";
import { formatShortAbsoluteIso } from "./relativeTime.ts";
import { safeText } from "./safeText.ts";

/**
 * 画面に出す知らせ。
 * `success`は操作が済んだこと、`info`は何も変えなかった正常な結果、
 * `warning`は済んだが確かめてほしいことを表す。
 */
export type WriteNotice = {
  readonly tone: "success" | "info" | "warning";
  readonly message: string;
  /** 断りの後にすること。閉じるまで残す知らせが、文の後に分けて出す。無いときは持たない。 */
  readonly nextStep?: string;
};

/**
 * 書き込みの後に一覧を読み直せなかったときの知らせ。
 * 一覧は古いままで、済んだ操作を押し直せてしまうので、更新されるまでその対象は止めておく。
 */
export const STALE_LIST_NOTICE: WriteNotice = {
  tone: "warning",
  message:
    "一覧を読み直せませんでした。一覧が更新されるまで、この対象は操作できません。",
};

/** 操作の記録を書けなかったときに、成功の文へ添える注意。結果を別の部品で出す画面も、同じ文を使う。 */
export const ACTION_AUDIT_FAILED_NOTE =
  "ただし、操作の記録を残せませんでした。誰が操作したかは、ジョブのログで確かめてください。";

/**
 * 操作の記録(`factory.console_actions`)を書けなかったときに、注意を添えて警告にする。
 * 操作は済んでいるので、成功の文は消さない。解除の通知の記録(`audit`)とは別である。
 */
function noteActionAudit(
  notice: WriteNotice,
  audit: ActionAudit | undefined,
): WriteNotice {
  if (audit !== "failed") {
    return notice;
  }
  return {
    tone: "warning",
    message: `${notice.message}${ACTION_AUDIT_FAILED_NOTE}`,
  };
}

/**
 * 承認と却下の結果の知らせ。
 * 設計は、承認の後の実装の開始も、却下の行き先(設計の再生成、要件定義へ戻る、人の対応待ち)も、
 * 反映が済むまで分からないので、記録したことだけを伝え、確かめる場所を示す。
 */
export function describeApprovalResult(
  result: ApprovalDecideResult,
  kind?: string,
): WriteNotice {
  if (kind === "design") {
    return {
      tone: "success",
      message:
        result.status === "approved"
          ? "承認を記録しました。実装の開始は作業項目で確かめてください。"
          : "却下を記録しました。行き先は作業項目で確かめてください。",
    };
  }
  return {
    tone: "success",
    message: result.status === "approved" ? "承認しました。" : "却下しました。",
  };
}

/**
 * 再実行の結果。`ok: false`でもフローは起動している。
 * 別の実行が先に作業項目のリースを取っていて、起動したジョブを記録しなかっただけである。
 */
export function describeRetryResult(result: RetryWorkItemResult): WriteNotice {
  if (!result.ok) {
    return noteActionAudit(
      {
        tone: "warning",
        message:
          "別の実行が先に作業項目を押さえていたため、起動したジョブは記録されていません。一覧を読み直して状態を確かめてください。",
      },
      result.action_audit,
    );
  }
  return noteActionAudit(
    {
      tone: "success",
      message: `再実行を始めました(状態: ${workItemStatusLabel(result.status)})。`,
    },
    result.action_audit,
  );
}

const AUDIT_SKIP_MESSAGES: Readonly<Record<AuditSkipReason, string>> = {
  audit_in_progress: "別の監査が進行中のため、起動しませんでした。",
  empty_period: "前回の監査以降の対象期間がまだないため、起動しませんでした。",
  no_new_records: "監査の対象になる新しい記録が無いため、起動しませんでした。",
  daily_budget_exceeded:
    "今日の予算の上限に達しているため、起動しませんでした。",
  concurrent_kickoff: "同時に起動した監査があったため、起動しませんでした。",
};

/** 監査の起動の結果。見送りは失敗ではなく、何も変えなかった正常な結果として伝える。 */
export function describeAuditResult(result: AuditKickoffResult): WriteNotice {
  if (result.skipped) {
    return { tone: "info", message: AUDIT_SKIP_MESSAGES[result.reason] };
  }
  return {
    tone: "success",
    message: `監査を始めました(対象期間: ${result.period_label})。`,
  };
}

/** 通知の解決の結果。解決済みだった通知も、成功として扱う。 */
export function describeNoticeResult(result: NoticeResolveResult): WriteNotice {
  return {
    tone: "success",
    message:
      result.status === "resolved"
        ? "解決済みにしました。"
        : "すでに解決済みです。",
  };
}

/** 解除の結果を知らせるトーストの文。書き込みの失敗は`error`にする。 */
export type ReleaseNotice = {
  readonly tone: "success" | "info" | "warning" | "error";
  readonly message: string;
  readonly nextStep?: string;
};

const AUDIT_FAILED_NOTE =
  "ただし、解除の記録(通知)を残せませんでした。誰が解除したかは、ジョブの記録で確かめてください。";

/**
 * 保留の解除の結果。解除済みの保留は、何も変えなかった正常な結果として伝える。
 * 期限切れの行を片付けただけのときは、通知を残さないので、記録の失敗の注意も付けない。
 */
export function describeHoldReleaseResult(
  result: HoldReleaseResult,
): WriteNotice {
  if (result.status === "already_released") {
    return { tone: "info", message: "すでに解除されています。" };
  }
  if (result.active_unknown === true) {
    return noteActionAudit(
      {
        tone: "warning",
        message: `保留を解除しました。ただし、解除の前に有効だったかは確認できませんでした。${result.audit === "failed" ? AUDIT_FAILED_NOTE : ""}`,
      },
      result.action_audit,
    );
  }
  if (!result.was_active) {
    return noteActionAudit(
      { tone: "success", message: "期限切れの保留を片付けました。" },
      result.action_audit,
    );
  }
  if (result.audit === "failed") {
    return noteActionAudit(
      {
        tone: "warning",
        message: `保留を解除しました。${AUDIT_FAILED_NOTE}`,
      },
      result.action_audit,
    );
  }
  return noteActionAudit(
    { tone: "success", message: "保留を解除しました。" },
    result.action_audit,
  );
}

/**
 * 凍結かdeployの保留の解除の結果。
 * `unconfirmed`は、解除が効いたか分からないので警告にし、一覧で確かめさせる。
 */
export function describeFreezeReleaseResult(
  result: FreezeReleaseResult,
): WriteNotice {
  switch (result.status) {
    case "already_ended":
      return {
        tone: "info",
        message: "すでに終わっています(解除済みか期限切れです)。",
      };
    case "unconfirmed":
      return noteActionAudit(
        {
          tone: "warning",
          message:
            "解除を確認できませんでした。一覧を取り直して確かめてください。",
        },
        result.action_audit,
      );
    case "released": {
      const subject = result.scope === "deploy" ? "deployの保留" : "凍結";
      if (result.audit === "failed") {
        return noteActionAudit(
          {
            tone: "warning",
            message: `${subject}を解除しました。${AUDIT_FAILED_NOTE}`,
          },
          result.action_audit,
        );
      }
      return noteActionAudit(
        { tone: "success", message: `${subject}を解除しました。` },
        result.action_audit,
      );
    }
  }
}

const DEPLOY_DECIDE_REFUSAL_NOTICES: Readonly<
  Record<Extract<DeployDecideResult, { refused: true }>["reason"], WriteNotice>
> = {
  invalid_sha: {
    tone: "warning",
    message: "送った版が正しくありません。一覧を読み直してください。",
  },
  invalid_decision: {
    tone: "warning",
    message: "送った判断が正しくありません。一覧を読み直してください。",
  },
  not_pending: {
    tone: "info",
    message:
      "この版はもう承認待ちではありません(判断済みか、新しい版の承認待ちに替わりました)。一覧を読み直してください。",
  },
  actor_unknown: {
    tone: "warning",
    message:
      "操作者を確かめられないため、判断を記録しませんでした。ログインし直してください。",
  },
  audit_unavailable: {
    tone: "warning",
    message:
      "操作の記録を残せないため、判断を記録しませんでした。時間をおいてやり直してください。",
  },
};

/** 反映の判断の結果の知らせ。承認では反映の時期を、却下では戻し方を伝える。 */
export function describeDeployDecideResult(
  result: DeployDecideResult,
): WriteNotice {
  if (result.refused) {
    return DEPLOY_DECIDE_REFUSAL_NOTICES[result.reason];
  }
  const message =
    result.decision === "approved"
      ? "反映を承認しました。次の自己更新(2分以内)が反映します。"
      : "反映を却下しました。mainへ戻すPRをマージするまで、反映は止まったままです。";
  const notice: WriteNotice =
    result.notice === "failed"
      ? {
          tone: "warning",
          message: `${message}ただし、判断の記録(通知)を残せませんでした。誰が判断したかは、ジョブの記録で確かめてください。`,
        }
      : { tone: "success", message };
  return noteActionAudit(notice, result.action_audit);
}

const JOB_CANCEL_REFUSALS: Readonly<Record<JobCancelRefusalReason, string>> = {
  flow_not_allowed: "このフローのジョブは、中止できない対象です。",
  not_a_root_flow:
    "フローの子のステップや、scriptのジョブは、中止できない対象です。",
  already_finished: "すでに終わっています。",
  already_canceling: "すでに中止済みです。止まるまで少しかかります。",
  scheduled_for_later: "予定の時刻が先のジョブは、中止できません。",
  actor_unknown: "操作者を確認できないため、中止しませんでした。",
  audit_unavailable: "操作の記録を残せないため、中止しませんでした。",
};

/** 人の判断を待つ作業項目の状態。照合は、この状態の作業項目を失敗にしない。 */
const WAITING_FOR_PERSON_STATUSES: readonly string[] = [
  "awaiting_approval",
  "awaiting_design_approval",
];

/** 中止の後に読み直した作業項目について伝える文。状態で、照合が失敗にするかが分かれる。 */
function describeCanceledWorkItem(workItem: JobCancelWorkItem | null): string {
  if (workItem === null) {
    return "作業項目の状態は読めませんでした。";
  }
  const head = `作業項目 #${String(workItem.id)} の状態: ${workItemStatusLabel(workItem.status)}。`;
  if (WAITING_FOR_PERSON_STATUSES.includes(workItem.status)) {
    return `${head}失敗にはならず、承認待ちのまま残ります。承認依頼の通知は届かないことがあります。`;
  }
  return workItem.lease_held
    ? `${head}リースがこのジョブを指したままなので、次の照合で失敗になります。`
    : head;
}

/**
 * ジョブの中止の結果。断りは失敗ではなく、何も変えなかった結果として伝える。
 * 中止の依頼は済んでいても、ジョブがまだ実行中か待ちに見えるときは、止まったとは言わず、状態を更新するよう伝える。
 * 中止の後に読み直した作業項目の状態を添える。承認待ちの作業項目は照合が失敗にしないので、失敗になるとは言わない。
 */
export function describeJobCancelResult(result: JobCancelResult): WriteNotice {
  if (!result.found) {
    return { tone: "info", message: "ジョブが見つかりません。" };
  }
  if (result.refused) {
    return { tone: "info", message: JOB_CANCEL_REFUSALS[result.reason] };
  }
  const workItem = describeCanceledWorkItem(result.work_item);
  const notStopped =
    result.job_state === "running" || result.job_state === "queued";
  const notice: WriteNotice = notStopped
    ? {
        tone: "warning",
        message: `中止を依頼しました。ジョブはまだ止まっていません。少し待って、状態を更新してください。${workItem}`,
      }
    : { tone: "success", message: `ジョブを中止しました。${workItem}` };
  return noteActionAudit(notice, result.action_audit);
}

const JOB_RERUN_REFUSALS: Readonly<Record<JobRerunRefusalReason, string>> = {
  not_scheduled: "定期の実行ではないため、再実行できません。",
  not_allowed: "このジョブは、再実行できない対象です。",
  not_failed: "失敗したジョブではないため、再実行しませんでした。",
  not_finished: "まだ終わっていないため、再実行しませんでした。",
  already_running:
    "同じ処理が実行中か待ちです。終わってから、もう一度確かめてください。",
  next_run_soon:
    "次の定期実行がもうすぐ始まります。再実行せず、次の回を待ってください。",
  schedule_disabled: "このscheduleは無効のため、再実行しませんでした。",
  schedule_changed: "scheduleの定義が変わったため、再実行しませんでした。",
  args_have_reference:
    "scheduleの引数に変数かresourceへの参照があるため、再実行しませんでした。",
  actor_unknown: "操作者を確認できないため、再実行しませんでした。",
  audit_unavailable: "操作の記録を残せないため、再実行しませんでした。",
};

/**
 * 定期ジョブの再実行の結果。断りは失敗ではなく、何も変えなかった結果として伝える。
 * 起動したときは、結果が新しいジョブにあることを伝える。再実行の失敗は、定期の失敗の検知に載らない。
 */
export function describeJobRerunResult(result: JobRerunResult): WriteNotice {
  if (!result.found) {
    return { tone: "info", message: "ジョブが見つかりません。" };
  }
  if (result.refused) {
    return { tone: "info", message: JOB_RERUN_REFUSALS[result.reason] };
  }
  return noteActionAudit(
    {
      tone: "success",
      message: "再実行を始めました。結果は新しいジョブで確認してください。",
    },
    result.action_audit,
  );
}

const CONFIG_UPDATE_REFUSALS: Readonly<
  Record<ConfigUpdateRefusalReason, string>
> = {
  item_not_allowed: "この項目は、Consoleから変更できない項目です。",
  invalid_value: "値が範囲に合わないため、変更しませんでした。",
  not_lowering:
    "止める向きか、下げる向きの変更だけできます。変更しませんでした。",
  has_reference: "設定に変数かresourceへの参照があるため、変更しませんでした。",
  conflict:
    "画面を開いた後に、設定の値が変わっていました。変更しませんでした。",
  actor_unknown: "操作者を確認できないため、変更しませんでした。",
  audit_unavailable:
    "操作の記録を残せないため、変更しませんでした。削除する要素が100字を超える、または記録に使えない文字を含むときも、この理由で断ります。",
  already_present: "その要素はすでにあります。変更しませんでした。",
  invalid_element:
    "要素の形式が正しくないため、変更しませんでした。repo_allowlist は https://github.com/owner/repo、dependabot_other_repos は owner/repo、default_reviewers は GitHub のログイン名で、どれも100字までです。",
  would_empty: LAST_ELEMENT_NOTE,
  owner_not_listed:
    "owners に無いアカウントのリポジトリは追加できません。変更しませんでした。",
};

/**
 * 設定の変更の断りの後にすること。理由ごとに、画面で直せるか、端末で直すかを分けて言う。
 * 断りの文は何が起きたかだけを言い、操作はここが受け持つ。
 */
const CONFIG_UPDATE_NEXT_STEPS: Readonly<
  Record<ConfigUpdateRefusalReason, string>
> = {
  item_not_allowed: "端末から変更します(wmill resource pushなど)。",
  invalid_value: "画面を更新して、いまの値を確かめてから、もう一度行います。",
  not_lowering:
    "画面を更新して、いまの値を確かめます。値の引き上げと有効にする向きは、端末から変更します(wmill resource pushなど)。",
  has_reference:
    "端末から変更します(wmill resource pushなど)。変更したら、画面を更新して、値が変わったことを確かめます。",
  conflict:
    "画面を更新して、いまの値を確かめます。変えたいときは、もう一度行います。",
  actor_unknown: "ログインし直して、もう一度行います。",
  audit_unavailable:
    "少し待って、もう一度行います。要素が原因のときは、CLIで直します。",
  already_present: "画面の一覧で、その要素があることを確かめます。",
  invalid_element: "要素を正しい形に直して、もう一度行います。",
  would_empty:
    "置き換えるときは、新しい要素を先に追加してから、古い要素を削除します。",
  owner_not_listed: "ownersを端末から変更して、もう一度行います。",
};

/**
 * 設定の変更の結果。断りは失敗ではなく、何も変えなかった結果として伝え、理由ごとに次の操作を添える。
 * 書いた後に読み直した値が期待と違うときは、変えたと言い切らず、Windmillで確かめるよう伝える。
 * 一覧の項目は、追加か削除かと、前後の件数を伝える。
 */
export function describeConfigUpdateResult(
  result: ConfigUpdateResult,
): WriteNotice {
  if (result.refused) {
    return {
      tone: "info",
      message: CONFIG_UPDATE_REFUSALS[result.reason],
      nextStep: CONFIG_UPDATE_NEXT_STEPS[result.reason],
    };
  }
  const item = safeText(result.item);
  if (!result.verified) {
    return noteActionAudit(
      {
        tone: "warning",
        message: `${item}を書き込みましたが、読み直した値が期待と違います。Windmillで確かめてください。`,
      },
      result.action_audit,
    );
  }
  return noteActionAudit(
    { tone: "success", message: configChangedMessage(item, result) },
    result.action_audit,
  );
}

/** 変更が済んだ項目の文。`item`は`safeText`を通した文字列である。 */
function configChangedMessage(
  item: string,
  result: Extract<ConfigUpdateResult, { refused: false }>,
): string {
  if ("op" in result) {
    const counts = `(${String(result.before_count)}件→${String(result.after_count)}件)`;
    return result.op === "add"
      ? `${item}に追加しました${counts}。`
      : `${item}から削除しました${counts}。`;
  }
  return typeof result.before === "boolean"
    ? `${item}を止めました。`
    : `${item}を${String(result.before)}から${String(result.after)}に下げました。`;
}

const HOLD_PLACE_REFUSALS: Readonly<Record<HoldPlaceRefusalReason, string>> = {
  invalid_kind: "置く種類が正しくないため、置きませんでした。",
  invalid_target: "対象が正しくないため、置きませんでした。",
  invalid_minutes: "期限が範囲外のため、置きませんでした。",
  invalid_reason: "理由が正しくないため、置きませんでした。",
  target_not_allowed: "このスケジュールは、凍結を置けない対象です。",
  already_active:
    "同じ対象に、有効な保留か凍結がすでにあります。置きませんでした。",
  other_holder_active:
    "ローカルのセッションが置いた保留か凍結があるため、置きませんでした。",
  limit_reached:
    "保留と凍結の件数が上限に達しています。不要なものを解除してから、もう一度置いてください。",
  actor_unknown: "操作者を確認できないため、置きませんでした。",
  audit_unavailable: "操作の記録を残せないため、置きませんでした。",
};

const PLACED_SUBJECTS = {
  merge: "マージの保留",
  deploy: "deployの保留",
  freeze: "凍結",
} as const;

/**
 * 保留や凍結を置いた結果。断りは失敗ではなく、何も変えなかった結果として伝える。
 * 置いた後の読み直しで行が見えなければ、置いたと言い切らず、一覧で確かめるよう伝える。
 * 止められるスケジュールの凍結は、止められるようになる時刻を添える。
 * 凍結が止められる前、または止める時点で残りの下限を割る前に終わるときは、添えない。
 */
export function describeHoldPlaceResult(result: HoldPlaceResult): WriteNotice {
  if (result.refused) {
    return { tone: "info", message: HOLD_PLACE_REFUSALS[result.reason] };
  }
  if (!result.verified) {
    return noteActionAudit(
      {
        tone: "warning",
        message:
          "置きましたが、読み直しで確認できませんでした。一覧を取り直して確かめてください。",
      },
      result.action_audit,
    );
  }
  const subject = `${PLACED_SUBJECTS[result.kind]}を置きました。`;
  const startsAt =
    result.kind === "freeze" && stopImpactNote(result.target) !== null
      ? stopWindowStart(result.created_at, result.expires_at)
      : null;
  const message =
    startsAt === null
      ? subject
      : `${subject}${formatShortAbsoluteIso(new Date(startsAt).toISOString())} 以降に、スケジュールを止められます。`;
  return noteActionAudit({ tone: "success", message }, result.action_audit);
}

const SCHEDULE_STOP_REFUSALS: Readonly<
  Record<ScheduleStopRefusalReason, string>
> = {
  not_allowed: "このスケジュールは、Consoleから止められない対象です。",
  no_freeze: "有効な凍結がありません。先に止める準備をしてください。",
  other_holder_freeze:
    "ローカルのセッションが置いた凍結のため、止めませんでした。",
  too_early: `まだ止められません。凍結を置いてから${String(STOP_READY_AFTER_MINUTES)}分待ってください。`,
  freeze_ending: `凍結が終わるまで${String(STOP_MIN_REMAINING_MINUTES)}分を切っているため、止めませんでした。`,
  self_update_running:
    "自己更新が実行中です。終わってから、もう一度止めてください。",
  schedule_changed: "スケジュールの定義が変わったため、止めませんでした。",
  already_stopped: "すでに無効です。",
  actor_unknown: "操作者を確認できないため、止めませんでした。",
  audit_unavailable: "操作の記録を残せないため、止めませんでした。",
};

/**
 * スケジュールを止めた結果。断りは失敗ではなく、何も変えなかった結果として伝える。
 * 早すぎる断りは、止められるようになる時刻を添える。
 * 読み直したスケジュールが無効になっていなければ、止めたと言い切らず、Windmillで確かめるよう伝える。
 * 止めたときの凍結が読み直しで有効でなければ、追従が戻さないことがあるので、Windmillで有効に戻すよう伝える。
 */
export function describeScheduleStopResult(
  result: ScheduleStopResult,
): WriteNotice {
  if (result.refused) {
    if (result.reason === "too_early" && result.ready_at !== null) {
      return {
        tone: "info",
        message: `まだ止められません。${formatShortAbsoluteIso(result.ready_at)} 以降に止められます。`,
      };
    }
    return { tone: "info", message: SCHEDULE_STOP_REFUSALS[result.reason] };
  }
  if (!result.verified) {
    return noteActionAudit(
      {
        tone: "warning",
        message:
          "止める操作をしましたが、スケジュールが無効になったことを確認できませんでした。Windmillで確かめてください。",
      },
      result.action_audit,
    );
  }
  if (!result.freeze_held) {
    return noteActionAudit(
      {
        tone: "warning",
        message:
          "スケジュールを止めましたが、凍結が先に終わった可能性があります。自己更新の追従では戻らないことがあるので、Windmillでスケジュールを有効に戻してください。",
      },
      result.action_audit,
    );
  }
  return noteActionAudit(
    {
      tone: "success",
      message: `スケジュールを止めました。凍結が終わる${formatShortAbsoluteIso(result.freeze_expires_at)}以降の自己更新の追従で、有効に戻ります。`,
    },
    result.action_audit,
  );
}

const STOP_ALL_REFUSALS: Readonly<Record<StopAllRefusalReason, string>> = {
  invalid_reason:
    "理由は1文字以上200文字以内で、改行を含めずに書いてください。何も変えていません。",
  state_unreadable:
    "全停止の状態を読めません。何も変えていません。急ぐときは、ホストでmise run stopを実行してください。",
  actor_unknown: "操作者を確かめられませんでした。何も変えていません。",
  audit_unavailable:
    "操作の記録を残せませんでした。何も変えていません。急ぐときは、ホストでmise run stopを実行してください。",
};

/**
 * すでに全停止中だったときの先頭の文。止め直せた段だけを「止め直しました」と言う。
 * 止められなかった段は、後ろの問題の文が伝える。
 */
function restoppedHead(
  result: Extract<StopAllResult, { refused: false }>,
): string {
  const config = result.config === "written" || result.config === "unchanged";
  const schedules = result.schedules_failed.length === 0;
  if (config && schedules) {
    return "すでに全停止中です。設定とスケジュールを止め直しました。";
  }
  if (config) return "すでに全停止中です。設定を止め直しました。";
  if (schedules) return "すでに全停止中です。スケジュールを止め直しました。";
  return "すでに全停止中です。";
}

/** 全停止の結果。止めきれなかった段があれば、警告にして確かめる場所を示す。 */
export function describeStopAllResult(result: StopAllResult): WriteNotice {
  if (result.refused) {
    return { tone: "info", message: STOP_ALL_REFUSALS[result.reason] };
  }
  const head = result.placed ? "全停止しました。" : restoppedHead(result);
  const problems: string[] = [];
  if (result.config === "has_reference") {
    problems.push(
      "設定に変数かresourceへの参照があるため、*_enabledは変えていません。CLIで止めてください。",
    );
  }
  if (result.config === "failed") {
    problems.push(
      "設定の*_enabledを止められませんでした。Windmillでfactory_configを確かめてください。",
    );
  }
  // 記録が失敗したときは、scriptが止めた名前をすべて`config_unrecorded`に入れるので、名前は1つの文にまとめる。
  const unrecorded = result.config_unrecorded ?? [];
  if (result.record === "failed") {
    const names =
      unrecorded.length > 0 ? `止めた名前: ${unrecorded.join("、")}。` : "";
    problems.push(
      `止めた*_enabledの名前を記録できませんでした。${names}mise run stop:restoreでは戻らないので、解除の後にWindmillでfactory_configを開いて手で戻してください。`,
    );
  } else if (unrecorded.length > 0) {
    problems.push(
      `記録に載らなかった名前: ${unrecorded.join("、")}。この名前は、解除の後に手で戻してください。`,
    );
  }
  if (result.schedules_failed.length > 0) {
    problems.push(
      `止められなかったスケジュールが${String(result.schedules_failed.length)}本あります。Windmillで確かめてください。`,
    );
  }
  if (problems.length > 0) {
    return noteActionAudit(
      { tone: "warning", message: `${head}${problems.join("")}` },
      result.action_audit,
    );
  }
  return noteActionAudit(
    {
      tone: "success",
      message: `${head}実行中のClaudeと検査は、15秒以内に止まります。`,
    },
    result.action_audit,
  );
}

const STOP_ALL_RELEASE_REFUSALS: Readonly<
  Record<StopAllReleaseRefusalReason, string>
> = {
  state_unreadable: "全停止の状態を読めません。何も変えていません。",
  freezes_unreadable:
    "凍結を読めず、有効に戻してよいスケジュールが分からないため、解除していません。",
  actor_unknown: "操作者を確かめられませんでした。何も変えていません。",
  audit_unavailable:
    "操作の記録を残せませんでした。何も変えていません。急ぐときは、ホストでmise run stop:releaseを実行してください。",
};

/** 全停止の解除の結果。`*_enabled`が戻らないことと、戻すコマンドを、毎回伝える。 */
export function describeStopAllReleaseResult(
  result: StopAllReleaseResult,
): WriteNotice {
  if (result.refused) {
    return { tone: "info", message: STOP_ALL_RELEASE_REFUSALS[result.reason] };
  }
  if (!result.released) {
    return { tone: "info", message: "全停止は置かれていません。" };
  }
  const notes: string[] = [];
  if (result.schedules_skipped.length > 0) {
    notes.push(
      `凍結のあるスケジュールを${String(result.schedules_skipped.length)}本、無効のまま残しました。凍結が終わると、自己更新が戻します。`,
    );
  }
  if (result.schedules_failed.length > 0) {
    notes.push(
      `有効に戻せなかったスケジュールが${String(result.schedules_failed.length)}本あります。Windmillで確かめてください。`,
    );
  }
  return noteActionAudit(
    {
      tone: result.schedules_failed.length > 0 ? "warning" : "success",
      message: `全停止を解除しました。factory_configの*_enabledは止めたままで、機能は動き出していません。修正の反映を確かめてから、ホストの端末でmise run stop:restoreを実行してください。${notes.join("")}`,
    },
    result.action_audit,
  );
}

/**
 * 閉じるまで残す知らせか。成功は済んだことを知らせるだけなので、時間で消えてよい。
 * 断り、確かめる警告、失敗は、読み手に操作が要るので、読み終えるまで残す。
 */
export function staysUntilClosed(notice: ReleaseNotice): boolean {
  return notice.tone !== "success";
}

/** 書き込みの結果を、トーストの文にする。失敗は、失敗の文をそのまま`error`にする。 */
export function releaseNotice<T>(
  outcome: WriteOutcome<T>,
  describe: (result: T) => WriteNotice,
): ReleaseNotice {
  if (outcome.kind === "failed") {
    return { tone: "error", message: outcome.message };
  }
  return describe(outcome.result);
}
