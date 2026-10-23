// 書き込みのボタンを、対象のキー単位でロックする。
// 同じ対象への操作が実行中の間は、次の操作を始めさせない。
// 承認の再実行は、記録済みの決定でもハンドラを起動し直すので、二重の送信を画面で止める。
// ロックは画面の部品をまたいで共有する。一覧と詳細の両方のボタンが、同じ対象で止まるためである。

/** 書き込みの対象の種類。キーの接頭辞になる。 */
type WriteTargetKind = "approval" | "work_item" | "notice";

/** 監査の起動は対象を持たないので、キーを1つに固定する。 */
export const AUDIT_WRITE_KEY = "audit";

// 仮の値。テストが失敗することを確かめるために、正しい値にしていない。
export const MANUAL_INTAKE_WRITE_KEY = "";

/** 対象の種類とIDから、ロックのキーを作る。承認の承認と却下は同じキーで止める。 */
export function writeTargetKey(kind: WriteTargetKind, id: number): string {
  return `${kind}:${String(id)}`;
}

export type WriteLocks = {
  /** 空いていれば取って`true`を返す。実行中なら取らずに`false`を返す。 */
  readonly tryAcquire: (key: string) => boolean;
  /** 取っていないキーの解放は何もしない。 */
  readonly release: (key: string) => void;
  readonly isLocked: (key: string) => boolean;
  /** `useSyncExternalStore`に渡す。変わったときだけ呼ぶ。 */
  readonly subscribe: (listener: () => void) => () => void;
  /** 変わるたびに新しい集合を返す。変わらないあいだは同じ参照を返す。 */
  readonly getSnapshot: () => ReadonlySet<string>;
};

export function createWriteLocks(): WriteLocks {
  let held: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();

  const update = (next: ReadonlySet<string>): void => {
    held = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    tryAcquire: (key) => {
      if (held.has(key)) {
        return false;
      }
      update(new Set([...held, key]));
      return true;
    },
    release: (key) => {
      if (!held.has(key)) {
        return;
      }
      update(new Set([...held].filter((candidate) => candidate !== key)));
    },
    isLocked: (key) => held.has(key),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => held,
  };
}

type LockedRun<T> =
  | { readonly started: false }
  | { readonly started: true; readonly value: T };

/**
 * `key`が空いていれば取り、`run`を実行して、終わったら放す。取れなければ`run`を呼ばない。
 * `run`が`keepLocked: true`を返したときは放さず、`holdUntilReleased`に放す関数を渡す。
 * 書き込みの後に一覧を読み直せなかったときに、古い一覧で同じ対象を操作させないためである。
 * `run`が例外を投げたときは、種類を問わず放してから投げ直す。プログラムの誤りで、押せないまま残さないためである。
 * ロックを持つのは、このタブの中だけである。
 */
export async function runLocked<T>(
  locks: WriteLocks,
  key: string,
  run: () => Promise<{ readonly value: T; readonly keepLocked: boolean }>,
  holdUntilReleased: (release: () => void) => void,
): Promise<LockedRun<T>> {
  if (!locks.tryAcquire(key)) {
    return { started: false };
  }
  let result: { readonly value: T; readonly keepLocked: boolean };
  try {
    result = await run();
  } catch (error) {
    locks.release(key);
    throw error;
  }
  if (result.keepLocked) {
    holdUntilReleased(() => {
      locks.release(key);
    });
  } else {
    locks.release(key);
  }
  return { started: true, value: result.value };
}

/** 画面全体で共有するロック。 */
export const writeLocks: WriteLocks = createWriteLocks();
