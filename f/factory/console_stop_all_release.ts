// Consoleから、全停止を解除するscript。
//
// 変数`f/factory/stop_all`を空に戻し、リポジトリの定義で有効なscheduleを有効に戻す。
// 有効な凍結があるscheduleは戻さない。人が止めている途中のscheduleを、解除で動かさないためである。
// 凍結の変数を読めないときは、戻してよいかが分からないので、何も変えずに断る。
// `factory_config`の`*_enabled`は戻さない。修正の反映を確かめた人が、ホストで`mise run stop:restore`を実行して記録から戻す。
// 置かれていなければ、何も変えずに`released: false`を返す。壊れた値は解除する。
// 解除の通知(情報)は、scheduleの失敗の検出器が、次の回(5分以内)に残す。
//
// 操作の記録は、置くscriptと同じ順序で残し、残せなければ何も変えずに断る。
// Console用workerで動くので、どのsecret変数も読まない。

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
import {
  activeFreezes,
  type FreezeReadIo,
  readFreezeStateVia,
  readVariableOrNull,
} from "./lib/freezes.ts";
import {
  readStopAll,
  STOP_ALL_VARIABLE_DESCRIPTION,
  type StopAllReadIo,
  schedulesToRestart,
  sdkStopAllReadIo,
} from "./lib/stop_all.ts";

/** 解除できなかった理由。Consoleの`STOP_ALL_RELEASE_REFUSAL_REASONS`と同じ並びで、契約テストが突き合わせる。 */
export const STOP_ALL_RELEASE_REFUSAL_REASONS = [
  "state_unreadable",
  "freezes_unreadable",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type StopAllReleaseRefusalReason =
  (typeof STOP_ALL_RELEASE_REFUSAL_REASONS)[number];

export type StopAllReleaseResult =
  | { readonly refused: true; readonly reason: StopAllReleaseRefusalReason }
  | { readonly refused: false; readonly released: false }
  | {
      readonly refused: false;
      readonly released: true;
      readonly schedules_enabled: readonly string[];
      /** 有効な凍結があるので、戻さなかったschedule。 */
      readonly schedules_skipped: readonly string[];
      readonly schedules_failed: readonly string[];
      readonly action_audit: ActionAudit;
    };

/** `releaseStopAllFromConsole`が使う外部の操作。テストでは差し替える。 */
export type StopAllReleasePorts = {
  readonly now: () => Date;
  readonly deriveActor: () => string;
  readonly stopAll: StopAllReadIo;
  readonly clearStopAll: () => Promise<void>;
  /** 凍結の変数の入出力。この操作は読むだけで、書かない。 */
  readonly freeze: FreezeReadIo;
  readonly setScheduleEnabled: (
    path: string,
    enabled: boolean,
  ) => Promise<void>;
  readonly sql: ActionSqlClient;
};

type ReleaseStep = {
  readonly enabled: readonly string[];
  readonly failed: readonly string[];
};

/**
 * 全停止を解除する。呼び出しの順序は、変数の読み取り、凍結の読み取り、操作者の導出、記録(`attempted`)、
 * 変数を空にする、scheduleを有効に戻す、記録(結果)に固定する。
 * 変数を空にできなかったときは、記録を`failed`にしてから投げる。
 */
export async function releaseStopAllFromConsole(
  ports: StopAllReleasePorts,
): Promise<StopAllReleaseResult> {
  const status = await readStopAll(ports.stopAll);
  if (status.kind === "unreadable") {
    return { refused: true, reason: "state_unreadable" };
  }
  if (status.kind === "clear") return { refused: false, released: false };
  const freezes = await readFreezeStateVia(ports.freeze);
  if (!freezes.ok) return { refused: true, reason: "freezes_unreadable" };
  const frozen = new Set(
    activeFreezes(freezes.value, ports.now()).map((entry) => entry.target),
  );
  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return { refused: true, reason: "actor_unknown" };
  }
  const plan = schedulesToRestart(REPO_SCHEDULES, frozen);

  const recorded = await runRecordedAs(
    () => actor,
    {
      action: "stop_all_release",
      target: "factory:stop_all",
      changes: { was_corrupt: status.kind === "corrupt" },
    },
    async (): Promise<RecordedOperation<ReleaseStep>> => {
      await ports.clearStopAll();
      const enabled: string[] = [];
      const failed: string[] = [];
      for (const path of plan.enable) {
        try {
          await ports.setScheduleEnabled(path, true);
          enabled.push(path);
        } catch {
          failed.push(path);
        }
      }
      return {
        outcome: failed.length === 0 ? "succeeded" : "partial",
        changes: {
          enabled: enabled.length,
          skipped: plan.skip.length,
          failed: failed.length,
        },
        value: { enabled, failed },
      };
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) return { refused: true, reason: "audit_unavailable" };
  return {
    refused: false,
    released: true,
    schedules_enabled: recorded.value.enabled,
    schedules_skipped: plan.skip,
    schedules_failed: recorded.value.failed,
    action_audit: recorded.audit,
  };
}

function sdkPorts(): StopAllReleasePorts {
  const workspace = wmillDefault.getWorkspace();
  return {
    now: () => new Date(),
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    stopAll: sdkStopAllReadIo(),
    clearStopAll: async () => {
      await wmill.setVariable(
        "f/factory/stop_all",
        "",
        false,
        STOP_ALL_VARIABLE_DESCRIPTION,
      );
    },
    freeze: {
      now: () => new Date(),
      readVariable: () =>
        readVariableOrNull(
          () => wmill.getVariable("f/factory/freezes"),
          () =>
            wmill.VariableService.existsVariable({
              workspace,
              path: "f/factory/freezes",
            }),
        ),
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

/** Consoleから、全停止を解除する。操作者はジョブの実行文脈から導く。 */
export async function main(): Promise<StopAllReleaseResult> {
  return await releaseStopAllFromConsole(sdkPorts());
}
