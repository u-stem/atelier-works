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

/**
 * キー操作で移る先のタブの位置。移さないときは`null`。
 * 修飾キーが付いているときは、ブラウザの操作を奪わないよう移さない。
 */
export function tabKeyTarget(
  event: {
    readonly key: string;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
  },
  current: number,
  count: number,
): number | null {
  if (hasModifierKey(event)) {
    return null;
  }
  return nextTabIndex(current, event.key, count);
}

/** タブの要素の`id`。本体の`aria-labelledby`が指す。 */
export function tabDomId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

/**
 * タブを離れるときのスクロール位置を覚えた、新しい記憶を返す。渡された記憶は変えない。
 * 2つのタブの本体が1つのスクロール枠を共有するとき、タブごとの位置を戻すために使う。
 */
export function rememberScroll<Id extends string>(
  memory: ReadonlyMap<Id, number>,
  id: Id,
  top: number,
): ReadonlyMap<Id, number> {
  return new Map(memory).set(id, top);
}

/** タブに戻るときのスクロール位置。まだ離れたことのないタブと、負の位置は先頭(0)にする。 */
export function recalledScroll<Id extends string>(
  memory: ReadonlyMap<Id, number>,
  id: Id,
): number {
  return Math.max(0, memory.get(id) ?? 0);
}

/**
 * タブに戻るときのスクロール位置。まだ離れたことのないタブは`fallback`にする。
 * 先頭でなく、タブの帯が枠の上端に来る位置のように、画面ごとの始点を渡せる。
 * 負の位置は先頭(0)にする。
 */
export function recalledScrollOr<Id extends string>(
  memory: ReadonlyMap<Id, number>,
  id: Id,
  fallback: number,
): number {
  return Math.max(0, memory.get(id) ?? fallback);
}
