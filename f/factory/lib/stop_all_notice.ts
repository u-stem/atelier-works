// 全停止の要対応の通知を、変数`f/factory/stop_all`に合わせる。scheduleの失敗の検出器が、5分ごとに成功の経路の最後で呼ぶ。
// 止まっていて未解決の通知が無ければ、通知を残し、Discordに知らせる。
// 止まっていなくて未解決の通知があれば、解除の情報の通知を残してから、未解決の通知を解決する。
// 置く操作と解除する操作は、Console用workerとホストの端末で動き、Discordの送り先を読めないので、知らせはここで出す。
// 通知の本文は固定の文にする。時刻、操作者、理由はConsoleのシステムの画面に出し、Discordの知らせにだけ添える。

import type { NotifyEvent } from "./discord.ts";
import { formatJstMinute, INVALID_JST_MINUTE } from "./jst.ts";
import { type Logger, maskSecrets } from "./log.ts";
import { withCallTimeout } from "./self_update_support.ts";
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
  "全停止が解除されました。止めたscheduleは有効に戻りましたが、factory_configの*_enabledは止めたままで、機能は動き出していません。次の操作: 修正の反映を確かめてから、ホストの端末でmise run stop:restoreを実行し、止めた設定を戻す";

export type StopAllNoticeDeps = {
  readonly read: () => Promise<StopAllStatus>;
  readonly listUnresolved: () => Promise<
    readonly { readonly message: string }[]
  >;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** 未解決の全停止の通知を、本文によらず種類で解決し、解決した数を返す。 */
  readonly resolveActive: () => Promise<number>;
  /** Discordの送り先。 */
  readonly readWebhookUrl: () => Promise<string>;
  readonly instanceName: () => Promise<string>;
  readonly notify: (webhookUrl: string, event: NotifyEvent) => Promise<unknown>;
  readonly log: Logger;
  /** Discordへの知らせの、内側の上限(ミリ秒)。省略すると既定の値を使う。テストで短くする。 */
  readonly callTimeoutMs?: { readonly read: number; readonly send: number };
};

/**
 * Discordへの知らせの、内側の上限(ミリ秒)。送り先の読み取りと設定の読み取りは各3秒、送信は5秒である。
 * 1つの段が詰まっても、その段だけを諦めて`placed`を返す。
 * 通知を残した後に呼び出し側の上限で切られると、結果を返せず、検出器の後の処理の時間も食うためである。
 */
const NOTIFY_TIMEOUTS_MS = { read: 3_000, send: 5_000 } as const;

export type StopAllNoticeOutcome =
  | "placed"
  | "kept"
  | "released"
  | "none"
  | "unreadable";

const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Discordに載せる文字列。制御文字と書式文字を空白にし、長さを切る。 */
function plain(text: string): string {
  return [...text.replace(CONTROL_CHARS, " ")]
    .slice(0, STOP_ALL_REASON_MAX)
    .join("");
}

/** ISO文字列の時刻を、JSTの`YYYY-MM-DD HH:mm JST`にする。読めなければ、各部品を`NaN`にする。 */
function jstMinute(iso: string): string {
  return `${formatJstMinute(Date.parse(iso)) ?? INVALID_JST_MINUTE} JST`;
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
    // 解除の情報を先に残す。残せずに先に解決すると、次の回は未解決の通知が無く`none`になり、情報が二度と残らない。
    // 解決に失敗して次の回にやり直しても、`addNotice`は未解決の同じ通知を重ねない。
    await deps.addNotice({
      kind: STOP_ALL_RELEASED_NOTICE_KIND,
      message: STOP_ALL_RELEASED_MESSAGE,
    });
    await deps.resolveActive();
    return "released";
  }
  if (open) return "kept";
  const id = await deps.addNotice({
    kind: STOP_ALL_ACTIVE_NOTICE_KIND,
    message: STOP_ALL_ACTIVE_MESSAGE,
  });
  if (id !== null) {
    // 通知は残してあるので、Discordへの知らせが失敗しても時間切れでも、置いた結果は変えない。
    // 送り先の変数や設定を読めなくても、検出器の後の処理を止めないためである。
    const timeouts = deps.callTimeoutMs ?? NOTIFY_TIMEOUTS_MS;
    try {
      const webhookUrl = await withCallTimeout(
        "read discord webhook url",
        deps.readWebhookUrl,
        timeouts.read,
      );
      const instanceName = await withCallTimeout(
        "load factory_config",
        deps.instanceName,
        timeouts.read,
      );
      await withCallTimeout(
        "notify discord",
        () =>
          deps.notify(webhookUrl, {
            kind: "stop_all_active",
            instance_name: instanceName,
            cause: stopAllCause(status),
            next_action: STOP_ALL_NEXT_ACTION,
          }),
        timeouts.send,
      );
    } catch (err) {
      deps.log.warn("could not tell Discord about the stop-all", {
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return "placed";
}
