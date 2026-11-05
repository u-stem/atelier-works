import type { NotifyEvent } from "./discord.ts";
import type { Logger } from "./log.ts";
import type { StopAllStatus } from "./stop_all.ts";
import type { NoticeRecord } from "./types.ts";

export const STOP_ALL_ACTIVE_NOTICE_KIND = "stop_all_active";
export const STOP_ALL_RELEASED_NOTICE_KIND = "stop_all_released";
export const STOP_ALL_NOTICE_RESOLVER = "detect_schedule_failures";
export const STOP_ALL_NEXT_ACTION = "";
export const STOP_ALL_ACTIVE_MESSAGE = "";
export const STOP_ALL_RELEASED_MESSAGE = "";

export type StopAllNoticeDeps = {
  readonly read: () => Promise<StopAllStatus>;
  readonly listUnresolved: () => Promise<
    readonly { readonly message: string }[]
  >;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly resolveActive: () => Promise<number>;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: () => Promise<string>;
  readonly log: Logger;
};

export type StopAllNoticeOutcome =
  | "placed"
  | "kept"
  | "released"
  | "none"
  | "unreadable";

export function stopAllCause(_status: StopAllStatus): string {
  return "";
}

export async function syncStopAllNotice(
  _deps: StopAllNoticeDeps,
): Promise<StopAllNoticeOutcome> {
  return "none";
}
