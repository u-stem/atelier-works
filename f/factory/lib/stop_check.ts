// 全停止の監視。Claudeと検査のコマンドの実行中に、全停止の変数を一定の間隔で読み、置かれていれば止める合図を出す。
// 合図はランナーの`stopSignal`に渡り、ランナーがプロセスグループを止める。
// 確認(`stopCheckFrom`)は、変数を読めないとき、時間内に読み終わらないときは、止めない扱いにする。
// Windmillのジョブの外(テストや手元の実行)では変数を読まず、常に止めない。

import {
  readStopAll,
  STOP_ALL_CHECK_TIMEOUT_MS,
  type StopAllReadIo,
  sdkStopAllReadIo,
  stopsRuns,
} from "./stop_all.ts";

/** 実行中の確認の間隔(ミリ秒)。 */
export const STOP_CHECK_INTERVAL_MS = 15_000;

/** 全停止が置かれているかを答える。 */
export type StopCheck = () => Promise<boolean>;

/** 常に止めない確認。ジョブの外で使う。 */
export const NEVER_STOPPED: StopCheck = async () => false;

/**
 * 変数を読む確認を作る。読み取りを`timeoutMs`で区切り、時間切れは止めない扱いにする。
 * 時間切れになった読み取りは止められずに残る。
 * 残っている間は、新しい読み取りを始めず止めない扱いにする。応答しないAPIに読み取りを積み重ねないためである。
 */
export function stopCheckFrom(
  io: StopAllReadIo,
  timeoutMs: number = STOP_ALL_CHECK_TIMEOUT_MS,
): StopCheck {
  let pending: Promise<boolean> | undefined;
  return async () => {
    if (pending !== undefined) return false;
    const read = readStopAll(io).then(stopsRuns);
    pending = read;
    const clear = () => {
      if (pending === read) pending = undefined;
    };
    read.then(clear, clear);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    try {
      return await Promise.race([read, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * 既定の確認。Windmillのジョブの中(`WM_WORKSPACE`がある)なら変数を読む確認を、外なら常に止めない確認を返す。
 * 読み取りは`STOP_ALL_CHECK_TIMEOUT_MS`で区切る。時間切れの読み取りが終わるまでは、次の読み取りを始めない。
 * 監視の間隔(`STOP_CHECK_INTERVAL_MS`)ごとの呼び出しは、その間は止めない扱いで返る。
 */
export function defaultStopCheck(
  workspace: string | undefined = process.env.WM_WORKSPACE,
): StopCheck {
  if (workspace === undefined || workspace === "") return NEVER_STOPPED;
  return stopCheckFrom(sdkStopAllReadIo());
}

/** 確認を1回呼ぶ。例外を投げたときは止めない扱いにする。 */
export async function checkStop(check: StopCheck): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

export type StopWatch = {
  /** 全停止が見つかったら中断される。ランナーの`stopSignal`に渡す。 */
  readonly signal: AbortSignal;
  /** 全停止が見つかったか。 */
  readonly stopped: () => boolean;
  /** 確認をやめる。実行が終わったら必ず呼ぶ。 */
  readonly dispose: () => void;
};

/**
 * `intervalMs`ごとに`check`を呼び、真が返ったら`signal`を中断する。
 * 前の確認が返っていなければ、次の回は飛ばす。確認が重ならないようにするためである。
 * 確認が時間切れで返った後に残る読み取りは、確認の側(`stopCheckFrom`)が重ねない。
 */
export function watchStop(
  check: StopCheck,
  intervalMs: number = STOP_CHECK_INTERVAL_MS,
): StopWatch {
  const controller = new AbortController();
  let busy = false;
  const timer = setInterval(() => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    void checkStop(check)
      .then((stop) => {
        if (stop) controller.abort();
      })
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  return {
    signal: controller.signal,
    stopped: () => controller.signal.aborted,
    dispose: () => {
      clearInterval(timer);
    },
  };
}
