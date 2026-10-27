// Consoleから、凍結を置いたscheduleを1件止める(無効にする)script。
//
// 凍結を置いたあとで、次のすべてを満たすときだけ止める。
// - 名前で列挙したschedule(`STOPPABLE_SCHEDULES`)である。反映を担う`self_update`、作業項目の照合を兼ねる`poll_issues`、
//   失敗の検出と見張りは、止めると他の仕組みが黙るので列挙しない(`NOT_STOPPABLE_SCHEDULES`に理由を書く)。
// - そのscheduleに有効な凍結があり、置いたのが人である。ローカルのセッションが置いた凍結の下では止めない。
// - 凍結を置いてから7分が過ぎている。凍結を置く前に始まった`self_update`のpushが、終わるまでの時間にあたる。
//   その間は、凍結の前の定義でscheduleを上書きしうる。
// - 凍結を置く前から実行中の`self_update`が無い。7分を超えて続く反映が、まだ上書きしうるためである。
// - scheduleが今もそのscriptの定期処理で、有効である。
// 凍結が終わるか解除されると、次の自己更新の追従がscheduleをリポジトリの定義(有効)に戻す。有効に戻す操作は持たない。
//
// 操作の記録(`factory.console_actions`)は、無効にする前に`attempted`の行を入れ、後で結果を更新する。
// 行を入れられなければ、止めずに断る。更新に失敗しても止めた結果は戻さず、`action_audit`を`failed`にする。
// 無効にした後にscheduleを読み直し、無効になっていなければ記録の結果を`partial`にする。
// 操作者は、ジョブのWindmill実行文脈から導く(`deriveApprover`)。導けなければ断る。引数に操作者は取らない。
//
// Console用workerで動くので、どのsecret変数も読まない。SDKの呼び出しは、境界テストの許可表に収める。
// 凍結の変数は読むだけで、書かない。パスはリテラルで、走査が固定する。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  actionSqlClientFrom,
  type RecordedOperation,
  runRecordedAs,
} from "./lib/console_actions.ts";
import { isRecord } from "./lib/console_redact.ts";
import {
  activeFreezes,
  type FreezeEntry,
  type FreezeReadIo,
  type FreezeState,
  readFreezeStateVia,
} from "./lib/freezes.ts";

const SELF_UPDATE_PATH = "f/factory/self_update";

/**
 * 凍結を置いてから、止めてよくなるまでの待ち(分)。
 * 凍結を置く前に始まった`self_update`のpushが、終わるまでの目安である。
 * 凍結の読み(10秒)、トークンの取得(30秒)、push(300秒)、時間切れ後の停止の猶予(約11秒)で約351秒、余裕を足して7分。
 * `scripts/freeze.ts`の待ちと同じ値で、契約テストが突き合わせる。
 */
export const STOP_SETTLE_MINUTES = 7;

const MINUTE_MS = 60_000;

/**
 * 止めてよいschedule。止めても、他の仕組みが黙るだけで、作業項目の状態も反映も壊さないものに限る。
 * 止めると出る通知と影響は、画面の確認の文と文書に書く。
 * 新しいscheduleは、ここに足すか、`NOT_STOPPABLE_SCHEDULES`に理由つきで置くまで、止められない。
 * 契約テスト(`tests/scripts/console_schedule_stop.test.ts`)が、リポジトリのscheduleとの差を固定する。
 */
export const STOPPABLE_SCHEDULES: readonly string[] = [
  "f/factory/auto_retry_pr_review",
  "f/factory/collect_github",
  "f/factory/drawio_viewer_bump",
  "f/factory/notify_daily_summary",
  "f/factory/poll_prs",
  "f/factory/watch_main_ci",
  "f/factory/watch_pr_ci",
  "f/factory/watch_pr_conflicts",
];

/** 止めないscheduleと、その理由。 */
export const NOT_STOPPABLE_SCHEDULES: Readonly<Record<string, string>> = {
  "f/factory/audit_kickoff":
    "週1回の監査の起動。止める必要が無く、起動はConsoleの操作で行える",
  "f/factory/cleanup_db": "古い行を削除する。止めると表が育ち続ける",
  "f/factory/cleanup_workspaces":
    "作業領域を掃除する。止めると、止まらないClaudeのプロセスが残る",
  "f/factory/console_fetch_watch":
    "Consoleの取り込みの見張り。止めると、取り込みの問題を知らせる者がいなくなる",
  "f/factory/default_worker_watch":
    "workerの見張り。止めると、停止を知らせる者がいなくなる",
  "f/factory/detect_schedule_failures":
    "scheduleの失敗の検出器。止めると、ほかのscheduleの失敗を拾えない",
  "f/factory/poll_dependabot":
    "dependabotのPRの取り込み。機能は設定の項目で止める",
  "f/factory/poll_issues":
    "作業項目の照合とdeployed_shaの見張りを兼ねる。止めると、失敗した作業項目が進行中のまま残る",
  "f/factory/sample_worker_load":
    "workerの負荷の標本。止めると、負荷の通知が古い値になる",
  "f/factory/self_update":
    "凍結を反映の上書きから外す仕組みの本体。止めると、追従も止まる",
};

/** 断る理由。画面は日本語の固定文に直す。 */
export const STOP_REFUSAL_REASONS = [
  "not_allowed",
  "no_freeze",
  "other_holder_freeze",
  "too_early",
  "self_update_running",
  "schedule_changed",
  "already_stopped",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type StopRefusalReason = (typeof STOP_REFUSAL_REASONS)[number];

export type StopResult =
  | {
      readonly refused: true;
      readonly reason: StopRefusalReason;
      /** `too_early`のときだけ、止められるようになる時刻。 */
      readonly ready_at: string | null;
    }
  | {
      readonly refused: false;
      readonly schedule_path: string;
      readonly freeze_id: string;
      /** 無効にした後に読み直したscheduleが有効か。読み直せなかったときも真にする。 */
      readonly enabled: boolean;
      /** 凍結が終わる時刻。終わると、次の追従でリポジトリの定義に戻る。 */
      readonly freeze_expires_at: string;
      /** 読み直したscheduleが無効になっていたか。 */
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    };

/** `stopScheduleFromConsole`が使う外部の操作。テストでは差し替える。 */
export type StopPorts = {
  readonly now: () => Date;
  /** 操作者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  /** 凍結の変数の入出力。この操作は読むだけで、書かない。 */
  readonly freeze: FreezeReadIo;
  /** 見つからないときは、`status`が404の例外を投げる。 */
  readonly getSchedule: (path: string) => Promise<unknown>;
  /** `f/factory/self_update`の実行中と待ちのジョブ。 */
  readonly listSelfUpdateQueue: () => Promise<readonly unknown[]>;
  readonly setEnabled: (path: string, enabled: boolean) => Promise<void>;
  readonly sql: ActionSqlClient;
};

function refused(
  reason: StopRefusalReason,
  readyAt: string | null = null,
): StopResult {
  return { refused: true, reason, ready_at: readyAt };
}

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err.status === 404;
}

function isStoppable(path: string): boolean {
  return STOPPABLE_SCHEDULES.includes(path);
}

type FreezeCheck =
  | { readonly kind: "ok"; readonly freeze: FreezeEntry }
  | { readonly kind: "refused"; readonly result: StopResult };

/**
 * `path`の有効な凍結を探し、止めてよいか判定する。
 * 置いたのが人でない凍結が1つでもあれば断る。有効な凍結が複数あれば、最も新しいものの時刻から待つ。
 * 待ちは、凍結を置いた時刻からちょうど`STOP_SETTLE_MINUTES`分で終わる。
 */
export function checkFreeze(
  state: FreezeState,
  path: string,
  now: Date,
): FreezeCheck {
  const active = activeFreezes(state, now).filter(
    (entry) => entry.target === path,
  );
  const newest = active.reduce<FreezeEntry | null>(
    (latest, entry) =>
      latest === null ||
      Date.parse(entry.created_at) > Date.parse(latest.created_at)
        ? entry
        : latest,
    null,
  );
  if (newest === null) {
    return { kind: "refused", result: refused("no_freeze") };
  }
  if (active.some((entry) => entry.holder_kind !== "human")) {
    return { kind: "refused", result: refused("other_holder_freeze") };
  }
  const readyAt =
    Date.parse(newest.created_at) + STOP_SETTLE_MINUTES * MINUTE_MS;
  if (now.getTime() < readyAt) {
    return {
      kind: "refused",
      result: refused("too_early", new Date(readyAt).toISOString()),
    };
  }
  return { kind: "ok", freeze: newest };
}

/**
 * 凍結を置く前から実行中の`self_update`があるか。
 * 実行中で、開始が凍結の時刻以前か、読めないものを数える。凍結の後に始まった回は、凍結を読んでいる。
 * 待ちのジョブは、始まるときに凍結を読むので数えない。
 */
export function selfUpdateRunningBefore(
  queue: readonly unknown[],
  freezeCreatedAt: string,
): boolean {
  const frozenAt = Date.parse(freezeCreatedAt);
  return queue.some((entry) => {
    if (
      !isRecord(entry) ||
      entry.script_path !== SELF_UPDATE_PATH ||
      entry.running !== true
    ) {
      return false;
    }
    const started =
      typeof entry.started_at === "string"
        ? Date.parse(entry.started_at)
        : Number.NaN;
    return Number.isNaN(started) || started <= frozenAt;
  });
}

type ScheduleCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly reason: StopRefusalReason };

/** scheduleが今もそのscriptの定期処理で、有効かを判定する。 */
export function checkSchedule(raw: unknown, path: string): ScheduleCheck {
  if (!isRecord(raw) || raw.script_path !== path || raw.is_flow !== false) {
    return { kind: "refused", reason: "schedule_changed" };
  }
  return raw.enabled === true
    ? { kind: "ok" }
    : { kind: "refused", reason: "already_stopped" };
}

/** 無効にした後の読み直し。失敗は`null`にして、止めた結果を隠さない。 */
async function readBack(ports: StopPorts, path: string): Promise<unknown> {
  try {
    return await ports.getSchedule(path);
  } catch {
    return null;
  }
}

/**
 * schedule`schedulePath`を止める。呼び出しの順序は、許可表の判定、凍結の読み取りと判定、scheduleの読み取りと判定、
 * 自己更新のキューの読み取り、操作者の導出、記録(`attempted`)、無効にする、読み直し、記録(結果)に固定する。
 * 凍結の変数を読めない、壊れているとき、scheduleの読み取りの404以外の失敗は、投げる。
 * 無効にする呼び出しが失敗したときは、記録を`failed`にしてから投げる。
 */
export async function stopScheduleFromConsole(
  schedulePath: unknown,
  ports: StopPorts,
): Promise<StopResult> {
  if (typeof schedulePath !== "string" || !isStoppable(schedulePath)) {
    return refused("not_allowed");
  }
  const path = schedulePath;

  const state = await readFreezeStateVia(ports.freeze);
  if (!state.ok) {
    throw new Error(`schedule stop: ${state.reason}`);
  }
  const frozen = checkFreeze(state.value, path, ports.now());
  if (frozen.kind === "refused") return frozen.result;
  const { freeze } = frozen;

  let scheduleRaw: unknown;
  try {
    scheduleRaw = await ports.getSchedule(path);
  } catch (err) {
    if (isNotFound(err)) return refused("schedule_changed");
    throw err;
  }
  const schedule = checkSchedule(scheduleRaw, path);
  if (schedule.kind === "refused") return refused(schedule.reason);

  if (
    selfUpdateRunningBefore(
      await ports.listSelfUpdateQueue(),
      freeze.created_at,
    )
  ) {
    return refused("self_update_running");
  }

  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return refused("actor_unknown");
  }

  const recorded = await runRecordedAs(
    () => actor,
    {
      action: "schedule_stop",
      target: `schedule:${path}`,
      changes: { freeze_id: freeze.id },
    },
    async (): Promise<RecordedOperation<boolean>> => {
      await ports.setEnabled(path, false);
      const after = await readBack(ports, path);
      const stillEnabled = !(isRecord(after) && after.enabled === false);
      return {
        outcome: stillEnabled ? "partial" : "succeeded",
        changes: { enabled_after: stillEnabled },
        value: stillEnabled,
      };
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) return refused("audit_unavailable");
  return {
    refused: false,
    schedule_path: path,
    freeze_id: freeze.id,
    enabled: recorded.value,
    freeze_expires_at: freeze.expires_at,
    verified: !recorded.value,
    action_audit: recorded.audit,
  };
}

function sdkPorts(): StopPorts {
  const workspace = wmillDefault.getWorkspace();
  return {
    now: () => new Date(),
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    freeze: {
      now: () => new Date(),
      readVariable: () => wmill.getVariable("f/factory/freezes"),
    },
    getSchedule: (path) =>
      wmill.ScheduleService.getSchedule({ workspace, path }),
    listSelfUpdateQueue: () =>
      wmill.JobService.listQueue({
        workspace,
        scriptPathExact: SELF_UPDATE_PATH,
        perPage: 50,
      }),
    setEnabled: async (path, enabled) => {
      await wmill.ScheduleService.setScheduleEnabled({
        workspace,
        path,
        requestBody: { enabled },
      });
    },
    sql: actionSqlClientFrom(() => wmill.datatable()),
  };
}

/** Consoleから、凍結を置いたscheduleを1件止める。操作者はジョブの実行文脈から導く。 */
export async function main(schedule_path: string): Promise<StopResult> {
  return await stopScheduleFromConsole(schedule_path, sdkPorts());
}
