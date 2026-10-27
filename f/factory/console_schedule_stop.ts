// Consoleから、凍結を置いたscheduleを1件止めるscript。(スタブ)

import type { ActionAudit, ActionSqlClient } from "./lib/console_actions.ts";
import type { FreezeIo } from "./lib/freezes.ts";

export const STOPPABLE_SCHEDULES: readonly string[] = [];

export const NOT_STOPPABLE_SCHEDULES: Readonly<Record<string, string>> = {};

/** 凍結を置いてから、止められるまでの待ち(分)。 */
export const STOP_SETTLE_MINUTES = 0;

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
      /** 無効にした後に読み直したscheduleが有効か。 */
      readonly enabled: boolean;
      /** 凍結が終わる時刻。終わると、次の追従でリポジトリの定義に戻る。 */
      readonly freeze_expires_at: string;
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    };

export type StopPorts = {
  readonly now: () => Date;
  readonly deriveActor: () => string;
  readonly freeze: FreezeIo;
  /** 見つからないときは、`status`が404の例外を投げる。 */
  readonly getSchedule: (path: string) => Promise<unknown>;
  /** `f/factory/self_update`の実行中と待ちのジョブ。 */
  readonly listSelfUpdateQueue: () => Promise<readonly unknown[]>;
  readonly setEnabled: (path: string, enabled: boolean) => Promise<void>;
  readonly sql: ActionSqlClient;
};

export async function stopScheduleFromConsole(
  _schedulePath: unknown,
  _ports: StopPorts,
): Promise<StopResult> {
  return { refused: true, reason: "not_allowed", ready_at: null };
}

export async function main(_schedule_path: string): Promise<StopResult> {
  return { refused: true, reason: "not_allowed", ready_at: null };
}
