// tag `console`を受けるworkerが居ない、または止まっていることを確かめる。
// 居ないと、tag付きのjobとscheduleがqueueに溜まり続け、Consoleが止まる。
// workerの一覧はインスタンスの管理者でないと読めないので、jobのtokenで読めるqueueを見る。
// tag `console`のjobが、予定時刻を過ぎても実行されずに待ち続けていれば、workerが受けていない。
// `console_fetch_watch`が10分ごとにtag `console`のjobを作るので、workerが居なければ待つjobが必ず現れる。
// defaultのworkerで動く`self_update`が呼ぶ。Console用workerと同じworkerで確かめると、
// そのworkerが居ないときに確かめる処理も動かないため。
// Consoleが止まるとConsoleの中のnoticeは読めないので、noticeを新しく残したときはDiscordにも送る。
// 確認そのものが続けて失敗すると不在に気づけないので、失敗の回数を数え、続いたらnoticeにする。

import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import { isRecord, type NoticeRecord } from "./types.ts";

/** Console用workerが受けるtag。 */
export const CONSOLE_WORKER_TAG = "console";

/** 予定時刻からこの秒数以上、実行されずに待っているjobがあれば、workerが受けていないと見なす。 */
export const CONSOLE_JOB_WAIT_SECONDS = 300;

/** 確認が終わるまで待つ上限。止まっても自己更新の反映を遅らせないための値。 */
export const CONSOLE_WORKER_CHECK_TIMEOUT_MS = 10_000;

/** 確認できない状態がこの回数(自己更新は10分ごとなので1時間)続いたら、noticeにする。 */
export const CONSOLE_WORKER_UNKNOWN_LIMIT = 6;

const MISSING_CAUSE =
  "Consoleのジョブが5分以上待たされています。Console用のworkerが居ないか止まっています。Consoleのジョブがqueueに溜まり、Consoleが止まります";
const MISSING_ACTION =
  "mise run upでworkerを起動し直し、docker compose ps windmill_worker_consoleでコンテナの状態を確かめる";

const CHECK_FAILED_CAUSE =
  "Console用のworkerが居ないか止まっていないかを、1時間続けて確認できていません。workerが止まっていても気づけません";
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

/** 判定の結果。`stalled`は、Console用のworkerが居ないか止まっていること。 */
export type ConsoleWorkerCheck = "ok" | "stalled" | "unknown";

/**
 * 実行待ちのjobの一覧の応答から、Console用のworkerが受けていないかを判定する。
 * 予定時刻から`CONSOLE_JOB_WAIT_SECONDS`秒以上待っているjobが1件でもあれば`stalled`、無ければ`ok`を返す。
 * 一覧でない応答は`unknown`を返す。
 * 応答は信頼できない入力として読み、実行中の要素と、予定時刻が無い・日時として読めない要素は数えない。
 * 予定時刻が`nowMs`より後の要素は、待たされていないので数えない。
 */
export function judgeConsoleQueue(
  jobs: unknown,
  nowMs: number,
): ConsoleWorkerCheck {
  if (!Array.isArray(jobs)) {
    return "unknown";
  }
  const thresholdMs = CONSOLE_JOB_WAIT_SECONDS * 1000;
  const stalled = jobs.some((job) => {
    if (!isRecord(job) || job.running === true) {
      return false;
    }
    const scheduledFor = job.scheduled_for;
    if (typeof scheduledFor !== "string") {
      return false;
    }
    const scheduledMs = Date.parse(scheduledFor);
    return !Number.isNaN(scheduledMs) && nowMs - scheduledMs >= thresholdMs;
  });
  return stalled ? "stalled" : "ok";
}

export type ConsoleWorkerCheckDeps = {
  /**
   * tag `console`で、予定時刻を過ぎても実行が始まっていないjobの一覧(1ページ)の応答を返す。
   * 待ちが長いjobを取りこぼさないよう、古いものから返す。
   */
  readonly listWaitingJobs: () => Promise<unknown>;
  /** 現在時刻(エポックミリ秒)。 */
  readonly now: () => number;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
  /** 省略時は`CONSOLE_WORKER_CHECK_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
};

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
    response = await deps.listWaitingJobs();
  } catch (err) {
    deps.log.warn("could not list the waiting console jobs", {
      error: maskSecrets(String(err)),
    });
    return "unknown";
  }
  const result = judgeConsoleQueue(response, deps.now());
  if (result === "unknown") {
    deps.log.warn("unexpected response while listing the waiting console jobs");
  }
  if (result === "stalled") {
    await recordAndNotify(deps, CONSOLE_WORKER_MISSING_NOTICE, {
      kind: "console_worker_missing",
      instance_name: deps.instanceName,
      cause: MISSING_CAUSE,
      next_action: MISSING_ACTION,
    });
  }
  return result;
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
 * tag `console`のjobが実行されずに待ち続けていないかを確かめ、待っていればnoticeを残してDiscordに送る。
 * 一覧を読めないとき、応答が一覧でないとき、`timeoutMs`以内に終わらないときは`unknown`を返し、
 * noticeは残さない。workerが止まっていると決めつけないためである。例外は投げない。
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
 * Console用のworkerが受けているかを確かめ、確認できなかった回数をstateに数える。
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
