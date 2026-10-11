// Issue作成のやり直しの後、同じ依頼のボタンを一定時間止める。
// 起票の処理は数分かかり、その間に押し直すと、2つの処理が重なる。
// サーバーも同時の処理を1つに絞るが、画面でも早い押し直しを止める。
// 時刻はこのタブのメモリにだけ持つ。別のタブや別の端末、リロードの後は止められない。

/**
 * やり直しの後にボタンを止める時間(ミリ秒)。
 * サーバーのIssue作成の印の有効期間(`ISSUE_CREATION_LEASE_SECONDS`、900秒)と同じ長さにする。
 */
export const REDO_COOLDOWN_MS = 15 * 60 * 1000;

/** 止めている時間の残り(ミリ秒)。やり直していないか、時間が過ぎていれば0。 */
export function redoCooldownRemaining(
  startedAt: number | undefined,
  nowMs: number,
): number {
  if (startedAt === undefined) {
    return 0;
  }
  return Math.max(0, startedAt + REDO_COOLDOWN_MS - nowMs);
}

/** 止めている間に出す文。残りの分は、切り上げて数える。 */
export function redoCooldownMessage(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60_000);
  return `起票に数分かかります。あと約${String(minutes)}分は押せません。`;
}

type RedoCooldowns = {
  readonly start: (approvalRequestId: number, nowMs: number) => void;
  readonly remaining: (approvalRequestId: number, nowMs: number) => number;
  /** `useSyncExternalStore`に渡す。変わったときだけ呼ぶ。 */
  readonly subscribe: (listener: () => void) => () => void;
  /** 変わるたびに新しい表を返す。変わらないあいだは同じ参照を返す。 */
  readonly getSnapshot: () => ReadonlyMap<number, number>;
};

export function createRedoCooldowns(): RedoCooldowns {
  let started: ReadonlyMap<number, number> = new Map();
  const listeners = new Set<() => void>();
  return {
    start: (approvalRequestId, nowMs) => {
      started = new Map([...started, [approvalRequestId, nowMs]]);
      for (const listener of listeners) {
        listener();
      }
    },
    remaining: (approvalRequestId, nowMs) =>
      redoCooldownRemaining(started.get(approvalRequestId), nowMs),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => started,
  };
}

/** 画面全体で共有する止めている時間。 */
export const redoCooldowns: RedoCooldowns = createRedoCooldowns();
