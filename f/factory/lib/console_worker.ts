// tag `console`を受けるworkerが居るかを確かめる。
// 居ないと、tag付きのjobとscheduleがqueueに溜まり続け、Consoleが止まる。
// defaultのworkerで動く`self_update`が呼ぶ。Console用workerと同じworkerで確かめると、
// そのworkerが居ないときに確かめる処理も動かないため。
// Consoleが止まるとConsoleの中のnoticeは読めないので、noticeを新しく残したときはDiscordにも送る。

import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import { isRecord, type NoticeRecord } from "./types.ts";

/** Console用workerが受けるtag。 */
export const CONSOLE_WORKER_TAG = "console";

/** 確認が終わるまで待つ上限。止まっても自己更新の反映を遅らせないための値。 */
export const CONSOLE_WORKER_CHECK_TIMEOUT_MS = 10_000;

const CAUSE = `tag ${CONSOLE_WORKER_TAG}を受けるworkerが居ません。Consoleのjobがqueueに溜まり、Consoleが止まります`;
const NEXT_ACTION =
  "mise run upでworkerを起動し直し、docker compose ps windmill_worker_consoleでコンテナの状態を確かめる";

/**
 * 通知の本文は、workerが居ない間は毎回同じ文にする。
 * 同じ本文の未解決の通知があれば、`addNoticeUnlessUnresolved`が重ねて記録しない。
 */
export const CONSOLE_WORKER_MISSING_NOTICE: NoticeRecord = {
  kind: "console_worker_missing",
  message: `${CAUSE}。次の操作: ${NEXT_ACTION}`,
};

/**
 * `existsWorkersWithTags`の応答(タグから、そのタグのworkerが居るかへの対応)を読み、
 * tag `console`のworkerが居るかを返す。応答の形が違えば`null`を返す。
 */
export function parseConsoleWorkerExists(response: unknown): boolean | null {
  if (!isRecord(response)) {
    return null;
  }
  const exists = response[CONSOLE_WORKER_TAG];
  return typeof exists === "boolean" ? exists : null;
}

export type ConsoleWorkerCheckDeps = {
  /** `tag`のworkerが居るかの応答を返す。 */
  readonly existsWorker: (tag: string) => Promise<unknown>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
  /** 省略時は`CONSOLE_WORKER_CHECK_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
};

export type ConsoleWorkerCheck = "present" | "missing" | "unknown";

async function checkOnce(
  deps: ConsoleWorkerCheckDeps,
): Promise<ConsoleWorkerCheck> {
  let exists: boolean | null;
  try {
    exists = parseConsoleWorkerExists(
      await deps.existsWorker(CONSOLE_WORKER_TAG),
    );
  } catch (err) {
    deps.log.warn("could not check for a console worker", {
      error: maskSecrets(String(err)),
    });
    return "unknown";
  }
  if (exists === null) {
    deps.log.warn("unexpected response while checking for a console worker");
    return "unknown";
  }
  if (exists) {
    return "present";
  }
  try {
    const noticeId = await deps.addNotice(CONSOLE_WORKER_MISSING_NOTICE);
    if (noticeId !== null) {
      await deps.notify({
        kind: "console_worker_missing",
        instance_name: deps.instanceName,
        cause: CAUSE,
        next_action: NEXT_ACTION,
      });
    }
  } catch (err) {
    deps.log.warn("could not record the console worker problem", {
      error: maskSecrets(String(err)),
    });
  }
  return "missing";
}

/**
 * tag `console`を受けるworkerが居るかを確かめ、居なければnoticeを残してDiscordに送る。
 * Discordは、noticeを新しく挿入できたときだけ送る。
 * 応答を読めないときと、`timeoutMs`以内に終わらないときは`unknown`を返し、noticeは残さない。
 * 居ないと決めつけないためである。呼び出し元の処理を止めないよう、例外は投げない。
 */
export async function checkConsoleWorker(
  deps: ConsoleWorkerCheckDeps,
): Promise<ConsoleWorkerCheck> {
  const timeoutMs = deps.timeoutMs ?? CONSOLE_WORKER_CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ConsoleWorkerCheck>((resolve) => {
    timer = setTimeout(() => {
      deps.log.warn("console worker check timed out", {
        timeout_ms: timeoutMs,
      });
      resolve("unknown");
    }, timeoutMs);
  });
  try {
    return await Promise.race([checkOnce(deps), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
