// tag `console`を受けるworkerが居るかを確かめる。
// 居ないと、tag付きのjobとscheduleがqueueに溜まり続け、Consoleが止まる。
// defaultのworkerで動く`self_update`が呼ぶ。Console用workerと同じworkerで確かめると、
// そのworkerが居ないときに確かめる処理も動かないため。
// Consoleが止まるとConsoleの中のnoticeは読めないので、noticeを新しく残したときはDiscordにも送る。
// 確認そのものが続けて失敗すると不在に気づけないので、失敗の回数を数え、続いたらnoticeにする。

import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import { isRecord, type NoticeRecord } from "./types.ts";

/** Console用workerが受けるtag。 */
export const CONSOLE_WORKER_TAG = "console";

/** この秒数以内にpingしたworkerだけを、居るものとして数える。 */
export const CONSOLE_WORKER_PING_SECONDS = 300;

/** 確認が終わるまで待つ上限。止まっても自己更新の反映を遅らせないための値。 */
export const CONSOLE_WORKER_CHECK_TIMEOUT_MS = 10_000;

/** 確認できない状態がこの回数(自己更新は10分ごとなので1時間)続いたら、noticeにする。 */
export const CONSOLE_WORKER_UNKNOWN_LIMIT = 6;

const MISSING_CAUSE = `tag ${CONSOLE_WORKER_TAG}を受けるworkerが居ません。Consoleのjobがqueueに溜まり、Consoleが止まります`;
const MISSING_ACTION =
  "mise run upでworkerを起動し直し、docker compose ps windmill_worker_consoleでコンテナの状態を確かめる";

const CHECK_FAILED_CAUSE =
  "Console用のworkerが居るかを、1時間続けて確認できていません。workerが止まっていても気づけません";
const CHECK_FAILED_ACTION =
  "self_updateのジョブログで、workerの確認の警告の内容を確かめる";

/**
 * 通知の本文は、workerが居ない間は毎回同じ文にする。
 * 同じ本文の未解決の通知があれば、`addNoticeUnlessUnresolved`が重ねて記録しない。
 */
export const CONSOLE_WORKER_MISSING_NOTICE: NoticeRecord = {
  kind: "console_worker_missing",
  message: `${MISSING_CAUSE}。次の操作: ${MISSING_ACTION}`,
};

/** 確認が続けて失敗したことを知らせる通知。本文は毎回同じ文にする。 */
export const CONSOLE_WORKER_CHECK_FAILED_NOTICE: NoticeRecord = {
  kind: "console_worker_check_failed",
  message: `${CHECK_FAILED_CAUSE}。次の操作: ${CHECK_FAILED_ACTION}`,
};

/**
 * workerの一覧の応答に、tag `console`を持つworkerがあるかを返す。
 * 応答は信頼できない入力として読み、形の違う要素は読み飛ばす。tagは完全一致で比べる。
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
      Array.isArray(tags) && tags.some((tag) => tag === CONSOLE_WORKER_TAG)
    );
  });
}

export type ConsoleWorkerCheckDeps = {
  /** `pingSince`秒以内にpingしたworkerの一覧(1ページ)の応答を返す。 */
  readonly listWorkers: (pingSince: number) => Promise<unknown>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
  /** 省略時は`CONSOLE_WORKER_CHECK_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
};

export type ConsoleWorkerCheck = "present" | "missing" | "unknown";

/** noticeを新しく挿入できたときだけDiscordに送る。どちらの失敗も呼び出し元に伝えない。 */
async function recordAndNotify(
  deps: ConsoleWorkerCheckDeps,
  record: NoticeRecord,
  event: NotifyEvent,
): Promise<void> {
  try {
    const noticeId = await deps.addNotice(record);
    if (noticeId !== null) {
      await deps.notify(event);
    }
  } catch (err) {
    deps.log.warn("could not record the console worker problem", {
      error: maskSecrets(String(err)),
    });
  }
}

async function checkOnce(
  deps: ConsoleWorkerCheckDeps,
): Promise<ConsoleWorkerCheck> {
  let response: unknown;
  try {
    response = await deps.listWorkers(CONSOLE_WORKER_PING_SECONDS);
  } catch (err) {
    deps.log.warn("could not check for a console worker", {
      error: maskSecrets(String(err)),
    });
    return "unknown";
  }
  if (!Array.isArray(response)) {
    deps.log.warn("unexpected response while checking for a console worker");
    return "unknown";
  }
  if (hasConsoleWorker(response)) {
    return "present";
  }
  await recordAndNotify(deps, CONSOLE_WORKER_MISSING_NOTICE, {
    kind: "console_worker_missing",
    instance_name: deps.instanceName,
    cause: MISSING_CAUSE,
    next_action: MISSING_ACTION,
  });
  return "missing";
}

/**
 * `timeoutMs`以内に`work`が終わらなければ`fallback`を返す。
 * 呼び出し元の処理を止めないための上限で、`work`自体は中断しない。
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * tag `console`を受けるworkerが最近pingしたかを確かめ、居なければnoticeを残してDiscordに送る。
 * 一覧を読めないとき、応答が一覧でないとき、`timeoutMs`以内に終わらないときは`unknown`を返し、
 * noticeは残さない。居ないと決めつけないためである。例外は投げない。
 */
export async function checkConsoleWorker(
  deps: ConsoleWorkerCheckDeps,
): Promise<ConsoleWorkerCheck> {
  const timeoutMs = deps.timeoutMs ?? CONSOLE_WORKER_CHECK_TIMEOUT_MS;
  return await withTimeout<ConsoleWorkerCheck>(
    checkOnce(deps),
    timeoutMs,
    "unknown",
    () => {
      deps.log.warn("console worker check timed out", {
        timeout_ms: timeoutMs,
      });
    },
  );
}

/** 保存したstateから、確認できなかった回数を読む。読めなければ0。 */
export function parseUnknownCount(state: unknown): number {
  if (!isRecord(state)) {
    return 0;
  }
  const count = state.console_worker_unknown_count;
  return typeof count === "number" && Number.isInteger(count) && count >= 0
    ? count
    : 0;
}

/** 確認できなかったときは1足し、確認できたときは0に戻す。 */
export function nextUnknownCount(
  previous: number,
  result: ConsoleWorkerCheck,
): number {
  return result === "unknown" ? previous + 1 : 0;
}

export type WatchConsoleWorkerDeps = ConsoleWorkerCheckDeps & {
  /** Windmillのstateを読む。 */
  readonly getState: () => Promise<unknown>;
  /** Windmillのstateに書く。stateの全体を置き換える。 */
  readonly setState: (state: Record<string, unknown>) => Promise<void>;
};

/**
 * workerの有無を確かめ、確認できなかった回数をstateに数える。
 * `CONSOLE_WORKER_UNKNOWN_LIMIT`回続けて確認できなかったら、noticeを残す(新しく挿入したときだけDiscordにも送る)。
 * 確認できたら回数を0に戻す。stateを読めたときは、ほかのキーを保って書く。
 * stateを読めなければ0として数え、ほかのキーを保てないので、書くとほかのキーを失う。
 * 書けなければ警告だけにする。
 * 呼び出し元の処理を止めないよう、例外は投げない。
 */
export async function watchConsoleWorker(
  deps: WatchConsoleWorkerDeps,
): Promise<ConsoleWorkerCheck> {
  const result = await checkConsoleWorker(deps);
  try {
    let stored: Record<string, unknown> = {};
    try {
      const state = await deps.getState();
      if (isRecord(state)) {
        stored = state;
      }
    } catch (err) {
      deps.log.warn("could not read the console worker check state", {
        error: maskSecrets(String(err)),
      });
    }
    const previous = parseUnknownCount(stored);
    const count = nextUnknownCount(previous, result);
    if (count !== previous) {
      // stateの全体を置き換える書き込みなので、ほかのキーは読んだ値のまま残す。
      await deps.setState({ ...stored, console_worker_unknown_count: count });
    }
    if (count >= CONSOLE_WORKER_UNKNOWN_LIMIT) {
      await recordAndNotify(deps, CONSOLE_WORKER_CHECK_FAILED_NOTICE, {
        kind: "console_worker_check_failed",
        instance_name: deps.instanceName,
        cause: CHECK_FAILED_CAUSE,
        next_action: CHECK_FAILED_ACTION,
      });
    }
  } catch (err) {
    deps.log.warn("could not update the console worker check state", {
      error: maskSecrets(String(err)),
    });
  }
  return result;
}
