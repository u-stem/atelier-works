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

/** 変数を読む確認を作る。読み取りを`timeoutMs`で区切り、時間切れは止めない扱いにする。 */
export function stopCheckFrom(
  io: StopAllReadIo,
  timeoutMs: number = STOP_ALL_CHECK_TIMEOUT_MS,
): StopCheck {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    try {
      return await Promise.race([readStopAll(io).then(stopsRuns), expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * 既定の確認。Windmillのジョブの中(`WM_WORKSPACE`がある)なら変数を読む確認を、外なら常に止めない確認を返す。
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
 * 前の確認が終わっていなければ、次の回は飛ばす。確認が重なって変数を読み続けないためである。
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
