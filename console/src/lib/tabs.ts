// タブの共通の純関数。キー操作で移る先、要素のid、タブごとのスクロール位置の記憶を決める。

/**
 * タブの並びでキーを押したときに移る先の位置。端では反対側へ回る。
 * 矢印とHomeとEnd以外のキーは`null`にして、既定の動作に任せる。
 */
export function nextTabIndex(
  current: number,
  key: string,
  count: number,
): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * キー操作に修飾キーが付いているか。
 * Alt+矢印(戻る・進む)やCtrl+Homeなどのブラウザの操作を、タブの移動で奪わないために使う。
 */
export function hasModifierKey(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}

export function tabKeyTarget(
  _event: {
    readonly key: string;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
  },
  _current: number,
  _count: number,
): number | null {
  return null;
}

export function tabDomId(_idPrefix: string, _id: string): string {
  return "";
}

export function rememberScroll<Id extends string>(
  memory: ReadonlyMap<Id, number>,
  _id: Id,
  _top: number,
): ReadonlyMap<Id, number> {
  return memory;
}

export function recalledScroll<Id extends string>(
  _memory: ReadonlyMap<Id, number>,
  _id: Id,
): number {
  return -1;
}
