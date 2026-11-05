// 全停止の要対応の通知を、変数`f/factory/stop_all`に合わせる。scheduleの失敗の検出器が、5分ごとに成功の経路の最後で呼ぶ。
// 止まっていて未解決の通知が無ければ、通知を残し、Discordに知らせる。
// 止まっていなくて未解決の通知があれば、解決し、解除の情報の通知を残す。
// 置く操作と解除する操作は、Console用workerとホストの端末で動き、Discordの送り先を読めないので、知らせはここで出す。
// 通知の本文は固定の文にする。時刻、操作者、理由はConsoleのシステムの画面に出し、Discordの知らせにだけ添える。

import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import { STOP_ALL_REASON_MAX, type StopAllStatus } from "./stop_all.ts";
import type { NoticeRecord } from "./types.ts";

export const STOP_ALL_ACTIVE_NOTICE_KIND = "stop_all_active";
export const STOP_ALL_RELEASED_NOTICE_KIND = "stop_all_released";
/** 解除で通知を解決するときの、解決者の名前。 */
export const STOP_ALL_NOTICE_RESOLVER = "detect_schedule_failures";

export const STOP_ALL_NEXT_ACTION =
  "原因を確かめ、Consoleのシステムの画面の「保留と凍結」か、ホストのmise run stop:releaseで解除する";

export const STOP_ALL_ACTIVE_MESSAGE = `全停止中です。Claudeと検査の実行、Issueの取り込み、自己更新と、見張りと片付けを除くリポジトリのscheduleが止まっています。次の操作: ${STOP_ALL_NEXT_ACTION}。解除すると、この通知は5分以内に自動で解決される`;

export const STOP_ALL_RELEASED_MESSAGE =
  "全停止が解除されました。止めたscheduleは有効に戻りましたが、factory_configの*_enabledは止めたままです。次の操作: 使う機能を1つずつ有効にする";

export type StopAllNoticeDeps = {
  readonly read: () => Promise<StopAllStatus>;
  readonly listUnresolved: () => Promise<
    readonly { readonly message: string }[]
  >;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** 未解決の全停止の通知を解決し、解決した数を返す。 */
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

const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Discordに載せる文字列。制御文字と書式文字を空白にし、長さを切る。 */
function plain(text: string): string {
  return [...text.replace(CONTROL_CHARS, " ")]
    .slice(0, STOP_ALL_REASON_MAX)
    .join("");
}

function jstMinute(iso: string): string {
  const shifted = new Date(Date.parse(iso) + JST_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} JST`;
}

/** Discordの知らせの説明。置いた時刻(JST)、操作者、理由を載せる。 */
export function stopAllCause(status: StopAllStatus): string {
  if (status.kind === "active") {
    return `${jstMinute(status.state.placed_at)}に${plain(status.state.placed_by)}が全停止を置きました。理由: ${plain(status.state.reason)}`;
  }
  return "全停止の変数が壊れているため、止まっている扱いです。";
}

/** 通知を変数に合わせる。読めないときは何も変えない。 */
export async function syncStopAllNotice(
  deps: StopAllNoticeDeps,
): Promise<StopAllNoticeOutcome> {
  const status = await deps.read();
  if (status.kind === "unreadable") {
    deps.log.warn("could not read the stop-all variable", {
      reason: maskSecrets(status.reason),
    });
    return "unreadable";
  }
  const open = (await deps.listUnresolved()).length > 0;
  if (status.kind === "clear") {
    if (!open) return "none";
    await deps.resolveActive();
    await deps.addNotice({
      kind: STOP_ALL_RELEASED_NOTICE_KIND,
      message: STOP_ALL_RELEASED_MESSAGE,
    });
    return "released";
  }
  if (open) return "kept";
  const id = await deps.addNotice({
    kind: STOP_ALL_ACTIVE_NOTICE_KIND,
    message: STOP_ALL_ACTIVE_MESSAGE,
  });
  if (id !== null) {
    await deps.notify({
      kind: "stop_all_active",
      instance_name: await deps.instanceName(),
      cause: stopAllCause(status),
      next_action: STOP_ALL_NEXT_ACTION,
    });
  }
  return "placed";
}
