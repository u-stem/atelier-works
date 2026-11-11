// 閉じるまで残す知らせを1件だけ持つ置き場。設定の変更の断り、確かめる警告、失敗を、設定のタブの先頭に出すために使う。
// トーストは操作した場所から離れて出て、どの項目の結果かと次の操作を、項目の隣で読ませられないためである。
// 置き場は画面の部品の外に置く。結果が届いたときに画面を離れていても、戻ったときに残っているためである。

import type { ReleaseNotice } from "./writeNotices.ts";

export type PinnedNotice = {
  /** 置くたびに増える番号。同じ文の知らせでも、新しい知らせとして読み上げさせるために使う。 */
  readonly id: number;
  /** 知らせが指す設定の項目。残っている間も、どの操作の結果か分かるようにする。 */
  readonly item: string;
  readonly notice: ReleaseNotice;
};

export type PinnedNoticeStore = {
  readonly get: () => PinnedNotice | null;
  /** 知らせを置く。残っている知らせは置き換える。読み手は、残っている知らせを見た後で次の操作をしているためである。 */
  readonly pin: (item: string, notice: ReleaseNotice) => void;
  readonly dismiss: () => void;
  /** `useSyncExternalStore`に渡す。変わったときだけ呼ぶ。 */
  readonly subscribe: (listener: () => void) => () => void;
};

export function createPinnedNoticeStore(): PinnedNoticeStore {
  let current: PinnedNotice | null = null;
  let lastId = 0;
  const listeners = new Set<() => void>();

  const update = (next: PinnedNotice | null): void => {
    current = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    get: () => current,
    pin: (item, notice) => {
      lastId += 1;
      update({ id: lastId, item, notice });
    },
    dismiss: () => {
      if (current === null) {
        return;
      }
      update(null);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
