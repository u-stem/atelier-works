// Console用のworkerがtag `console`のジョブを受けているかを確かめる。
// 受けていないと、tag付きのジョブとscheduleがqueueに溜まり続け、Consoleが止まる。
// workerの一覧は、ジョブのトークンでは読めない(Forbidden)ので、読めるqueueとジョブの履歴を見る。
// tag `console`のジョブが、予定時刻を過ぎても実行されずに待ち続けていれば、workerが受けていない。
// `console_fetch_watch`が10分ごとにtag `console`のジョブを作るので、workerが受けなければ待つジョブが現れる。
// 待つジョブが無いだけでは、スケジュールが無効で何も作られていない場合と区別できない。
// そのため、`console_fetch_watch`が最近終わっていること、または新しいジョブが待っていることを、
// 問題なしの根拠にする。どちらも無ければ、判定できないものとして扱う。
// defaultのworkerで動く`self_update`が呼ぶ。Console用workerと同じworkerで確かめると、
// そのworkerが止まっているときに確かめる処理も動かないため。
// Consoleが止まるとConsoleの中のnoticeは読めないので、noticeを新しく残したときはDiscordにも送る。
// 確認そのものが続けて失敗すると停止に気づけないので、失敗の回数を数え、続いたらnoticeにする。

import type {
  ListCompletedJobsData,
  ListQueueData,
} from "windmill-client@1.817.0";
import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import { isRecord, type NoticeRecord } from "./types.ts";

/** Console用workerが受けるtag。 */
export const CONSOLE_WORKER_TAG = "console";

/** 予定時刻からこの秒数以上、実行されずに待っているジョブがあれば、workerが受けていないと見なす。 */
export const CONSOLE_JOB_WAIT_SECONDS = 300;

/** Console用のworkerが動いている証拠として読む、`console_fetch_watch`を最後に完了した時刻の古さの上限(秒)。 */
export const CONSOLE_RECENT_RUN_SECONDS = 1800;

/** 10分ごとにtag `console`のジョブを作る、Console用workerの動作の証拠に使うscript。 */
export const CONSOLE_FETCH_WATCH_PATH = "f/factory/console_fetch_watch";

/** 確認が終わるまで待つ上限。確認が止まっても自己更新の反映を遅らせないための値。 */
export const CONSOLE_WORKER_CHECK_TIMEOUT_MS = 10_000;

/** 確認できない状態がこの回数(自己更新は10分ごとなので1時間)続いたら、noticeにする。 */
export const CONSOLE_WORKER_UNKNOWN_LIMIT = 6;

const MISSING_CAUSE = `Consoleのジョブが${CONSOLE_JOB_WAIT_SECONDS / 60}分以上待たされています。Console用のworkerが居ない、2枠とも塞がっている、またはtagの設定がずれていて、ジョブを受けていません。Consoleのジョブがqueueに溜まり、Consoleが止まります`;
const MISSING_ACTION =
  "docker compose ps windmill_worker_consoleでコンテナの状態を確かめ、無ければmise run upで起動し、動いていればdocker compose restart windmill_worker_consoleで再起動する。再起動しても直らなければ、Windmillの画面でtag consoleの実行中のジョブと、ワーカーグループconsoleのtagを確かめる";

const CHECK_FAILED_CAUSE =
  "Console用のworkerがジョブを受けているかを、1時間続けて確かめられていません。workerが止まっていても気づけません";
const CHECK_FAILED_ACTION =
  "self_updateのジョブログの警告を確かめる。could not confirm the console worker from the job listsが続くなら、console_fetch_watchのスケジュールが有効か、直近の実行がtag consoleで動いているかを確かめる。ほかの警告なら、その内容に従って原因を直す";

/**
 * 通知の本文は、workerがジョブを受けていない間は毎回同じ文にする。
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

/** 待ちのジョブの一覧を取るAPIの引数。待ちが長いジョブを取りこぼさないよう、古いものから取る。 */
export function consoleQueueQuery(workspace: string): ListQueueData {
  return {
    workspace,
    tag: CONSOLE_WORKER_TAG,
    running: false,
    scheduledForBeforeNow: true,
    orderDesc: false,
    perPage: 100,
  };
}

/**
 * `console_fetch_watch`の完了した実行を取るAPIの引数。新しい順に取る。
 * 手動の実行やpreviewはdefaultのworkerで動いてtagが違うので、サーバー側でもtagで絞る。
 * 判定側でもtagを確かめるので、絞りが効かなくても証拠を取り違えない。
 * 取り消されたジョブを除いても最新が残るよう、1件でなく10件取る。
 */
export function watchRunsQuery(workspace: string): ListCompletedJobsData {
  return {
    workspace,
    scriptPathExact: CONSOLE_FETCH_WATCH_PATH,
    tag: CONSOLE_WORKER_TAG,
    orderDesc: true,
    perPage: 10,
  };
}

/** 判定の結果。`stalled`は、Console用のworkerがジョブを受けていないこと。 */
export type ConsoleWorkerCheck = "ok" | "stalled" | "unknown";

/**
 * 実行履歴の1件の完了時刻(エポックミリ秒)を返す。
 * `completed_at`が日時として読めればそれを使う。Windmillの応答では`completed_at`がnullのことがあるため、
 * 読めなければ`started_at`に`duration_ms`を足す。どちらも読めなければ`null`を返す。
 */
function completionMs(run: Record<string, unknown>): number | null {
  if (typeof run.completed_at === "string") {
    const completedMs = Date.parse(run.completed_at);
    if (!Number.isNaN(completedMs)) {
      return completedMs;
    }
  }
  if (
    typeof run.started_at === "string" &&
    typeof run.duration_ms === "number"
  ) {
    const startedMs = Date.parse(run.started_at);
    if (!Number.isNaN(startedMs) && Number.isFinite(run.duration_ms)) {
      return startedMs + run.duration_ms;
    }
  }
  return null;
}

/**
 * `console_fetch_watch`の実行履歴の応答から、Console用のworkerが動いた最も新しい完了時刻
 * (エポックミリ秒)を返す。
 * 数えるのは、tagが`console`で、取り消されていない実行だけである。
 * 手動の実行やpreviewはdefaultのworkerで動き、人が取り消したジョブもworkerの動作の証拠にならない。
 * 失敗した実行は、workerがジョブを受けて動いた証拠として数える。
 * 一覧でないとき、数えられる要素が無いときは`null`を返す。
 */
function latestCompletionMs(runs: unknown): number | null {
  if (!Array.isArray(runs)) {
    return null;
  }
  let latest: number | null = null;
  for (const run of runs) {
    if (
      !isRecord(run) ||
      run.tag !== CONSOLE_WORKER_TAG ||
      run.canceled === true
    ) {
      continue;
    }
    const completedMs = completionMs(run);
    if (completedMs !== null && (latest === null || completedMs > latest)) {
      latest = completedMs;
    }
  }
  return latest;
}

/**
 * 実行待ちのジョブと`console_fetch_watch`の実行履歴の応答から、Console用のworkerがジョブを受けているかを判定する。
 * 次の順に決める。
 * 1. 待ちの応答が一覧でなければ`unknown`。
 * 2. 予定時刻から`CONSOLE_JOB_WAIT_SECONDS`秒以上待っているジョブが1件でもあれば`stalled`。
 *    実行履歴の応答の形には左右されない。
 * 3. 待っているジョブが残っているか、直近`CONSOLE_RECENT_RUN_SECONDS`秒以内に
 *    Console用のworkerが`console_fetch_watch`を終えていれば`ok`。
 *    ジョブが作られていることが、スケジュールが生きている証拠になる。
 * 4. どちらも無ければ`unknown`。スケジュールが無効だと待つジョブが作られず、workerの状態を判定できない。
 * 応答は信頼できない入力として読み、実行中の要素と、日時が無い・日時として読めない要素は数えない。
 * 予定時刻が`nowMs`より後の要素は、待たされていないので待ちとして数えない。
 */
export function judgeConsoleQueue(
  waitingJobs: unknown,
  recentWatchRuns: unknown,
  nowMs: number,
): ConsoleWorkerCheck {
  if (!Array.isArray(waitingJobs)) {
    return "unknown";
  }
  const thresholdMs = CONSOLE_JOB_WAIT_SECONDS * 1000;
  let waitingCount = 0;
  for (const job of waitingJobs) {
    if (!isRecord(job) || job.running === true) {
      continue;
    }
    const scheduledFor = job.scheduled_for;
    if (typeof scheduledFor !== "string") {
      continue;
    }
    const scheduledMs = Date.parse(scheduledFor);
    if (Number.isNaN(scheduledMs)) {
      continue;
    }
    if (scheduledMs > nowMs) {
      continue;
    }
    if (nowMs - scheduledMs >= thresholdMs) {
      return "stalled";
    }
    waitingCount += 1;
  }
  if (waitingCount > 0) {
    return "ok";
  }
  const completedMs = latestCompletionMs(recentWatchRuns);
  if (
    completedMs !== null &&
    nowMs - completedMs <= CONSOLE_RECENT_RUN_SECONDS * 1000
  ) {
    return "ok";
  }
  return "unknown";
}

export type ConsoleWorkerCheckDeps = {
  /**
   * tag `console`で、予定時刻を過ぎても実行が始まっていないジョブの一覧(1ページ)の応答を返す。
   * 待ちが長いジョブを取りこぼさないよう、古いものから返す。
   */
  readonly listWaitingJobs: () => Promise<unknown>;
  /** `console_fetch_watch`の完了した実行を、新しい順に返す(tagで絞る前の複数件)。 */
  readonly listRecentWatchRuns: () => Promise<unknown>;
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
  let waitingJobs: unknown;
  let recentWatchRuns: unknown;
  let listFailed = false;
  try {
    waitingJobs = await deps.listWaitingJobs();
  } catch (err) {
    deps.log.warn("could not list the waiting console jobs", {
      error: maskSecrets(String(err)),
    });
    return "unknown";
  }
  try {
    recentWatchRuns = await deps.listRecentWatchRuns();
  } catch (err) {
    // 待ちが長いジョブがあれば履歴が無くても判定できるので、ここでは戻らない。
    listFailed = true;
    deps.log.warn("could not list the recent console_fetch_watch runs", {
      error: maskSecrets(String(err)),
    });
  }
  const result = judgeConsoleQueue(waitingJobs, recentWatchRuns, deps.now());
  if (result === "unknown" && !listFailed) {
    deps.log.warn("could not confirm the console worker from the job lists");
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
 * Console用のworkerがジョブを受けているかを確かめ、受けていなければnoticeを残してDiscordに送る。
 * 一覧を読めないとき、応答が一覧でないとき、根拠が無いとき、`timeoutMs`以内に終わらないときは
 * `unknown`を返し、noticeは残さない。workerが受けていないと決めつけないためである。例外は投げない。
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
