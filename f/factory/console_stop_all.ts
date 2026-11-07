// Consoleから、Factory全体を止める(全停止)script。
//
// 次の順に行う。
// 1. 変数`f/factory/stop_all`に、置いた時刻、操作者、理由を書く。すでに置かれていれば書き直さない。壊れた値は書き直す。
// 2. `factory_config`の`*_enabled`のうち`true`の項目を、1回の書き込みですべて`false`にする。
//    値のどこかに`$var:`か`$res:`があれば、参照の先をこのscriptが解決しないよう、設定は変えない。
//    書く直前に、止める名前を変数`f/factory/stop_all_record`に記録する。
//    全停止の変数が空だったときは記録を置き換え、すでに置かれていたときは読み直した記録との和集合にする。
//    止める名前が無いときは、前の記録に触らない。
//    記録を書けなくても設定は止め、結果の`record`と`config_unrecorded`で知らせる。
// 3. リポジトリの定義のscheduleを無効にする。見張りと片付けのschedule(`STOP_ALL_KEPT_SCHEDULES`)は止めない。
// 変数を書けなかったときは、止めずに記録を失敗にし、ジョブを失敗させる。設定とscheduleの段には進まない。
// 変数が置かれないと、実行中のClaudeと検査が止まらず、取り込みと自己更新の関門も開いたままだからである。
// このときの受け皿は、ホストの`mise run stop -- --kill-only`である。
// 変数を書いた後の設定やscheduleの失敗は、残りの段を続け、結果で知らせる。変数が止める働きの本体なので、残りが失敗しても止めた状態は保たれるためである。
// 要対応の通知とDiscordへの知らせは、scheduleの失敗の検出器が、次の回(5分以内)に変数を読んで出す。
// このscriptはConsole用workerで動き、Discordの送り先(秘密の変数)を読まないためである。
// 実行中のジョブは中止しない。中止すると、ジョブのプロセスと一緒に、子プロセスを止める監視が消えるためである。
// 実行中のClaudeと検査は、変数を15秒ごとに読み、置かれていれば自分で止まる。
// `*_enabled`は、解除しても戻さない。修正の反映を確かめた人が、ホストで`mise run stop:restore`を実行して記録から戻す。
//
// 操作の記録(`factory.console_actions`)は、書く前に`attempted`の行を入れ、後で結果を更新する。
// 行を入れられなければ、何も変えずに断る。記録するのは理由の長さと結果の数だけで、理由の本文は入れない。
// 操作者は、ジョブのWindmill実行文脈から導く(`deriveApprover`)。導けなければ断る。引数に操作者は取らない。
//
// Console用workerで動くので、どのsecret変数も読まない。SDKの呼び出しは、境界テストの許可表に収める。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  actionSqlClientFrom,
  type RecordedOperation,
  runRecordedAs,
} from "./lib/console_actions.ts";
import { REPO_SCHEDULES } from "./lib/console_known_paths.ts";
import { holdsReference, isRecord } from "./lib/console_redact.ts";
import {
  buildStopAllState,
  enabledFlags,
  isStopAllReason,
  planStopAllRecord,
  readStopAll,
  readStopAllRecord,
  STOP_ALL_RECORD_VARIABLE_DESCRIPTION,
  STOP_ALL_VARIABLE_DESCRIPTION,
  type StopAllReadIo,
  type StopAllState,
  schedulesToStop,
  sdkStopAllReadIo,
  sdkStopAllRecordReadIo,
  serializeStopAll,
  serializeStopAllRecord,
} from "./lib/stop_all.ts";

/**
 * 全停止を置けなかった理由。画面は日本語の固定文に直す。
 * Consoleの`STOP_ALL_REFUSAL_REASONS`と同じ並びで、契約テストが突き合わせる。
 */
export const STOP_ALL_REFUSAL_REASONS = [
  "invalid_reason",
  "state_unreadable",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type StopAllRefusalReason = (typeof STOP_ALL_REFUSAL_REASONS)[number];

/**
 * 設定の段の結果。
 * - written: `true`の`*_enabled`をすべて`false`にした。
 * - unchanged: `true`の`*_enabled`が無かった。
 * - has_reference: 値に`$var:`か`$res:`があったので、変えなかった。
 * - failed: 読めなかったか、書けなかった。
 */
export type StopAllConfigOutcome =
  | "written"
  | "unchanged"
  | "has_reference"
  | "failed";

/**
 * 止めた名前の記録の段の結果。
 * - written: 記録を書いた(置き換えたか、和集合にした)。
 * - unchanged: 止めた名前が無いか、すでに置かれていた全停止で、止めた名前がすべて記録済みだった。記録には触っていない。
 * - failed: 記録を読めないか、壊れていたか、書けなかった。
 */
export type StopAllRecordOutcome = "written" | "unchanged" | "failed";

export type StopAllResult =
  | { readonly refused: true; readonly reason: StopAllRefusalReason }
  | {
      readonly refused: false;
      /** この操作で変数を書いたか。すでに置かれていたときは偽で、時刻はそのときのものを返す。 */
      readonly placed: boolean;
      readonly placed_at: string;
      readonly config: StopAllConfigOutcome;
      readonly disabled_flags: readonly string[];
      /**
       * 止めた名前の記録の段の結果と、止めたが記録に載らなかった名前。
       * このscriptは必ず返す。Consoleの型と一致させる契約のため、任意の項目として宣言する(Consoleは古い結果も読む)。
       */
      readonly record?: StopAllRecordOutcome;
      readonly config_unrecorded?: readonly string[];
      readonly schedules_disabled: readonly string[];
      readonly schedules_failed: readonly string[];
      readonly action_audit: ActionAudit;
    };

/** `stopAllFromConsole`が使う外部の操作。テストでは差し替える。 */
export type StopAllPorts = {
  readonly now: () => Date;
  /** 操作者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  readonly stopAll: StopAllReadIo;
  readonly writeStopAll: (text: string) => Promise<void>;
  readonly record: StopAllReadIo;
  readonly writeRecord: (text: string) => Promise<void>;
  /** `factory_config`の補間しない生の値。 */
  readonly readConfig: () => Promise<unknown>;
  readonly writeConfig: (value: Record<string, unknown>) => Promise<void>;
  readonly setScheduleEnabled: (
    path: string,
    enabled: boolean,
  ) => Promise<void>;
  readonly sql: ActionSqlClient;
};

/** 止める名前の決め方は`lib/stop_all.ts`にある。呼び出し側の読み込み先を変えないため、ここからも出す。 */
export { enabledFlags };

type RecordStep = {
  readonly outcome: StopAllRecordOutcome;
  /** 止める名前のうち、記録に載らなかったもの。 */
  readonly unrecorded: readonly string[];
};

type ConfigStep = {
  readonly outcome: StopAllConfigOutcome;
  readonly flags: readonly string[];
  readonly record: RecordStep;
};

/** 止める名前が無いときの記録の段の結果。 */
const NO_RECORD_CHANGE: RecordStep = { outcome: "unchanged", unrecorded: [] };

/**
 * 止める名前を記録する。`replace`が真なら、古い記録を引き継がずに置き換える。偽なら、読み直した記録との和集合にする。
 * 止める名前が無いときは、記録に触らない。設定を読めないときや参照があるときに、戻していない前の記録を消さないためである。
 * 和集合にする記録が読めないか壊れているときは、書き直さずに失敗にする。
 * 壊れた値を消すと、前の全停止が止めた名前が分からなくなるためである。
 */
async function recordFlags(
  ports: StopAllPorts,
  flags: readonly string[],
  replace: boolean,
): Promise<RecordStep> {
  if (flags.length === 0) return NO_RECORD_CHANGE;
  let previous: readonly string[] = [];
  if (!replace) {
    const status = await readStopAllRecord(ports.record);
    if (status.kind === "unreadable" || status.kind === "corrupt") {
      return { outcome: "failed", unrecorded: flags };
    }
    if (status.kind === "recorded") previous = status.record.flags;
  }
  const plan = planStopAllRecord({ previous, flags, now: ports.now() });
  if (!replace && plan.record.flags.length === previous.length) {
    return { outcome: "unchanged", unrecorded: plan.unrecorded };
  }
  try {
    await ports.writeRecord(serializeStopAllRecord(plan.record));
  } catch {
    return { outcome: "failed", unrecorded: flags };
  }
  return { outcome: "written", unrecorded: plan.unrecorded };
}

/**
 * 設定の`true`の`*_enabled`を止める。止める直前に、その名前を記録する。
 * 記録を書けなくても、設定は止める。止めることを、戻せることより優先するためである。
 * 記録を設定より先に書くので、止めた名前は必ず記録にある。
 * 設定の書き込みが失敗すると、止めていない名前が記録に残るが、戻すコマンドは今`false`の名前だけを戻すので害は無い。
 */
async function stopConfig(
  ports: StopAllPorts,
  replaceRecord: boolean,
): Promise<ConfigStep> {
  let current: unknown;
  try {
    current = await ports.readConfig();
  } catch {
    current = undefined;
  }
  if (!isRecord(current)) {
    return { outcome: "failed", flags: [], record: NO_RECORD_CHANGE };
  }
  if (holdsReference(current)) {
    return { outcome: "has_reference", flags: [], record: NO_RECORD_CHANGE };
  }
  const flags = enabledFlags(current);
  const record = await recordFlags(ports, flags, replaceRecord);
  if (flags.length === 0) return { outcome: "unchanged", flags, record };
  const next: Record<string, unknown> = { ...current };
  for (const flag of flags) next[flag] = false;
  try {
    await ports.writeConfig(next);
  } catch {
    return { outcome: "failed", flags: [], record };
  }
  return { outcome: "written", flags, record };
}

type ScheduleStep = {
  readonly disabled: readonly string[];
  readonly failed: readonly string[];
};

async function stopSchedules(ports: StopAllPorts): Promise<ScheduleStep> {
  const disabled: string[] = [];
  const failed: string[] = [];
  for (const path of schedulesToStop(REPO_SCHEDULES)) {
    try {
      await ports.setScheduleEnabled(path, false);
      disabled.push(path);
    } catch {
      failed.push(path);
    }
  }
  return { disabled, failed };
}

type StopStep = {
  readonly placed: boolean;
  readonly placedAt: string;
  readonly config: ConfigStep;
  readonly schedules: ScheduleStep;
};

/**
 * 全停止を置く。呼び出しの順序は、理由の検査、変数の読み取り、操作者の導出、記録(`attempted`)、
 * 変数の書き込み、止める名前の記録、設定の書き込み、scheduleの無効化、記録(結果)に固定する。
 * 変数の書き込みの失敗は、記録を`failed`にしてから投げる。
 */
export async function stopAllFromConsole(
  reason: unknown,
  ports: StopAllPorts,
): Promise<StopAllResult> {
  if (!isStopAllReason(reason)) {
    return { refused: true, reason: "invalid_reason" };
  }
  const status = await readStopAll(ports.stopAll);
  if (status.kind === "unreadable") {
    return { refused: true, reason: "state_unreadable" };
  }
  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return { refused: true, reason: "actor_unknown" };
  }
  const built = buildStopAllState({ reason, actor, now: ports.now() });
  if (!built.ok) return { refused: true, reason: "actor_unknown" };
  const existing: StopAllState | null =
    status.kind === "active" ? status.state : null;

  const recorded = await runRecordedAs(
    () => actor,
    {
      action: "stop_all",
      target: "factory:stop_all",
      changes: { reason_chars: [...reason].length },
    },
    async (): Promise<RecordedOperation<StopStep>> => {
      if (existing === null) {
        await ports.writeStopAll(serializeStopAll(built.state));
      }
      // 変数が空だったときだけ、記録を置き換える。壊れた値は前の全停止が残したものでありうるので、和集合にする。
      const config = await stopConfig(ports, status.kind === "clear");
      const schedules = await stopSchedules(ports);
      const complete =
        (config.outcome === "written" || config.outcome === "unchanged") &&
        config.record.outcome !== "failed" &&
        config.record.unrecorded.length === 0 &&
        schedules.failed.length === 0;
      return {
        outcome: complete ? "succeeded" : "partial",
        changes: {
          placed: existing === null,
          config: config.outcome,
          flags: config.flags.length,
          record: config.record.outcome,
          unrecorded: config.record.unrecorded.length,
          disabled: schedules.disabled.length,
          failed: schedules.failed.length,
        },
        value: {
          placed: existing === null,
          placedAt: existing?.placed_at ?? built.state.placed_at,
          config,
          schedules,
        },
      };
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) return { refused: true, reason: "audit_unavailable" };
  const { value } = recorded;
  return {
    refused: false,
    placed: value.placed,
    placed_at: value.placedAt,
    config: value.config.outcome,
    disabled_flags: value.config.flags,
    record: value.config.record.outcome,
    config_unrecorded: value.config.record.unrecorded,
    schedules_disabled: value.schedules.disabled,
    schedules_failed: value.schedules.failed,
    action_audit: recorded.audit,
  };
}

function sdkPorts(): StopAllPorts {
  const workspace = wmillDefault.getWorkspace();
  return {
    now: () => new Date(),
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    stopAll: sdkStopAllReadIo(),
    writeStopAll: async (text) => {
      await wmill.setVariable(
        "f/factory/stop_all",
        text,
        false,
        STOP_ALL_VARIABLE_DESCRIPTION,
      );
    },
    record: sdkStopAllRecordReadIo(),
    writeRecord: async (text) => {
      await wmill.setVariable(
        "f/factory/stop_all_record",
        text,
        false,
        STOP_ALL_RECORD_VARIABLE_DESCRIPTION,
      );
    },
    readConfig: () =>
      wmill.ResourceService.getResourceValue({
        workspace,
        path: "f/factory/factory_config",
      }),
    writeConfig: async (value) => {
      await wmill.ResourceService.updateResourceValue({
        workspace,
        path: "f/factory/factory_config",
        requestBody: { value },
      });
    },
    setScheduleEnabled: async (path, enabled) => {
      await wmill.ScheduleService.setScheduleEnabled({
        workspace,
        path,
        requestBody: { enabled },
      });
    },
    sql: actionSqlClientFrom(() => wmill.datatable()),
  };
}

/** Consoleから、Factory全体を止める。操作者はジョブの実行文脈から導く。 */
export async function main(reason: string): Promise<StopAllResult> {
  return await stopAllFromConsole(reason, sdkPorts());
}
