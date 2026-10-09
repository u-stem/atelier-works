// tag `console`を受けるworkerが居るかを確かめる。
// 居ないと、tag付きのjobとscheduleがqueueに溜まり続け、Consoleが止まる。
// defaultのworkerで動く`self_update`が呼ぶ。Console用workerと同じworkerで確かめると、
// そのworkerが居ないときに確かめる処理も動かないため。

import { type Logger, maskSecrets } from "./log.ts";
import { isRecord, isString, type NoticeRecord } from "./types.ts";

/** Console用workerが受けるtag。 */
export const CONSOLE_WORKER_TAG = "console";

/** この秒数以内にpingしたworkerだけを、居るものとして数える。 */
export const CONSOLE_WORKER_PING_SECONDS = 300;

const WORKERS_PER_PAGE = 100;
const MAX_PAGES = 5;

/**
 * 通知の本文は、workerが居ない間は毎回同じ文にする。
 * 同じ本文の未解決の通知があれば、`addNoticeUnlessUnresolved`が重ねて記録しない。
 */
export const CONSOLE_WORKER_MISSING_NOTICE: NoticeRecord = {
  kind: "console_worker_missing",
  message: `tag ${CONSOLE_WORKER_TAG} を受けるworkerが${String(CONSOLE_WORKER_PING_SECONDS)}秒以内にpingしていません。Consoleのjobがqueueに溜まり、Consoleが止まります。次の操作: Console用のworker(windmill_worker_console)のコンテナが起動しているか確かめ、止まっていれば mise run up で起動し直す`,
};

/**
 * workerの一覧の応答に、tag `console`を持つworkerがあるかを返す。
 * 応答は信頼できない入力として読み、配列でなければ、形の違う要素は読み飛ばす。
 * tagは完全一致で比べる。
 */
export function hasConsoleWorker(workers: unknown): boolean {
  if (!Array.isArray(workers)) {
    return false;
  }
  return workers.some((worker) => {
    if (!isRecord(worker)) {
      return false;
    }
    const tags = worker.custom_tags;
    return (
      Array.isArray(tags) &&
      tags.some((tag) => isString(tag) && tag === CONSOLE_WORKER_TAG)
    );
  });
}

export type ConsoleWorkerCheckDeps = {
  /** `page`(1始まり)のworkerの一覧を返す。`pingSince`秒以内にpingしたworkerだけにする。 */
  readonly listWorkers: (page: number, pingSince: number) => Promise<unknown>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly log: Logger;
};

export type ConsoleWorkerCheck = "present" | "missing" | "unknown";

/**
 * tag `console`を受けるworkerが最近pingしたかを確かめ、居なければnoticeを残す。
 * 一覧を読めなければ`unknown`を返し、noticeは残さない。居ないと決めつけないためである。
 * 呼び出し元の処理を止めないよう、例外は投げない。
 */
export async function checkConsoleWorker(
  deps: ConsoleWorkerCheckDeps,
): Promise<ConsoleWorkerCheck> {
  let found = false;
  try {
    for (let page = 1; page <= MAX_PAGES && !found; page += 1) {
      const workers = await deps.listWorkers(page, CONSOLE_WORKER_PING_SECONDS);
      found = hasConsoleWorker(workers);
      if (!Array.isArray(workers) || workers.length < WORKERS_PER_PAGE) {
        break;
      }
    }
  } catch (err) {
    deps.log.warn("could not list workers to check the console worker", {
      error: maskSecrets(String(err)),
    });
    return "unknown";
  }
  if (found) {
    return "present";
  }
  try {
    await deps.addNotice(CONSOLE_WORKER_MISSING_NOTICE);
  } catch (err) {
    deps.log.warn("could not record the console worker notice", {
      error: maskSecrets(String(err)),
    });
  }
  return "missing";
}
