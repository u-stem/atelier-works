// 全停止の監視。Claudeと検査のコマンドの実行中に、全停止の変数を一定の間隔で読み、置かれていれば止める合図を出す。
// 合図はランナーの`stopSignal`に渡り、ランナーがプロセスグループを止める。
// 確認(`stopCheckFrom`)は、変数を読めないとき、時間内に読み終わらないときは、止めない扱いにする。
// Windmillのジョブの外(テストや手元の実行)では変数を読まず、常に止めない。
// 人が中止した作業項目を止める確認(`lib/work_item_stop.ts`)も、同じ`watchStop`で動かす。確認ごとに別の監視を作り、待ちの管理を共有しない。

import {
  readStopAll,
  STOP_ALL_CHECK_TIMEOUT_MS,
  type StopAllReadIo,
  sdkStopAllReadIo,
  stopsRuns,
} from "./stop_all.ts";

/** 実行中の確認の間隔(ミリ秒)。 */
export const STOP_CHECK_INTERVAL_MS = 15_000;

/**
 * 残っている読み取りを見切るまでの時間(ミリ秒)。
 * 読み取りを重ねすぎないことと、返らない読み取りで全停止の監視を止めないことを両立させる。
 * 短いと応答しないAPIへ読み取りが積み重なり、長いと全停止が実行中のClaudeと検査に届くのが遅れる。
 */
export const STALE_READ_MS = 60_000;

/** 全停止が置かれているかを答える。 */
export type StopCheck = () => Promise<boolean>;

/** 常に止めない確認。ジョブの外で使う。 */
export const NEVER_STOPPED: StopCheck = async () => false;

/**
 * 読み取り`read`を`timeoutMs`で区切る確認を作る。時間切れと、読み取りの失敗は、止めない扱いにする。
 * `read`が同期に例外を投げても、確認は投げない。
 * 時間切れになった読み取りは止められずに残る。
 * 残っている間は、始めてから`STALE_READ_MS`が過ぎるまで、新しい読み取りを始めず止めない扱いにする。応答しないAPIに読み取りを積み重ねないためである。
 * `STALE_READ_MS`が過ぎた読み取りは見切り、新しく読む。見切った読み取りが後で終わっても、新しい読み取りの状態は消さない。
 * 残っている読み取りの管理は、この関数を呼んで作る確認ごとに別になる。2つの確認は、互いの遅れに影響されない。
 * `now`は現在の時刻(ミリ秒)を返す。テストで差し替える。
 */
export function boundedCheckFrom(
  read: () => Promise<boolean>,
  timeoutMs: number,
  now: () => number = Date.now,
): StopCheck {
  let pending: { readonly id: number; readonly startedAt: number } | undefined;
  let nextId = 0;
  return async () => {
    if (pending !== undefined && now() - pending.startedAt < STALE_READ_MS) {
      return false;
    }
    const mine = { id: nextId, startedAt: now() };
    nextId += 1;
    pending = mine;
    const result = Promise.resolve()
      .then(read)
      .catch(() => false);
    const clear = () => {
      if (pending?.id === mine.id) pending = undefined;
    };
    result.then(clear, clear);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    try {
      return await Promise.race([result, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** 変数を読む確認を作る。読み取りを`timeoutMs`で区切り、時間切れは止めない扱いにする(`boundedCheckFrom`)。 */
export function stopCheckFrom(
  io: StopAllReadIo,
  timeoutMs: number = STOP_ALL_CHECK_TIMEOUT_MS,
  now: () => number = Date.now,
): StopCheck {
  return boundedCheckFrom(
    () => readStopAll(io).then(stopsRuns),
    timeoutMs,
    now,
  );
}

/**
 * 既定の確認。Windmillのジョブの中(`WM_WORKSPACE`がある)なら変数を読む確認を、外なら常に止めない確認を返す。
 * 読み取りは`STOP_ALL_CHECK_TIMEOUT_MS`で区切る。時間切れの読み取りが終わるまで、または`STALE_READ_MS`が過ぎるまでは、次の読み取りを始めない。
 * 監視の間隔(`STOP_CHECK_INTERVAL_MS`)ごとの呼び出しは、その間は止めない扱いで返る。
 * 読み取りが返らないときの全停止は、最長で`STALE_READ_MS`遅れて届く。
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

/**
 * 2つの合図を1つにまとめる。どちらかが中断されたら中断される。
 * `AbortSignal.any`は、実行環境の版で使えるかを確かめていないので使わない。
 * ランナーが受ける`stopSignal`は1つなので、2つの監視の合図を渡すときに使う。
 */
export function mergeSignals(
  first: AbortSignal,
  second: AbortSignal,
): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  if (first.aborted || second.aborted) {
    abort();
    return controller.signal;
  }
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  return controller.signal;
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
 * 確認が時間切れで返った後に残る読み取りは、確認の側(`stopCheckFrom`)が`STALE_READ_MS`まで重ねず、過ぎたら見切って読み直す。
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
