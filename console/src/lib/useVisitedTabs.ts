import { useState } from "react";
import { visitedTabsWith } from "./tabSet.ts";

/**
 * 開いたことのあるタブの集合を返す。タブを初めて開くまで描画を遅らせ、開いた後は残すために使う。
 * 取得が重いタブの描画を、開くまで避けつつ、一度開いたタブのスクロール位置や入力を保てる。
 * 描画の中で集合を更新する。効果で更新すると、タブを開いた最初の描画が空になるためである。
 */
export function useVisitedTabs<Id extends string>(
  selected: Id,
): ReadonlySet<Id> {
  const [visited, setVisited] = useState<ReadonlySet<Id>>(
    () => new Set([selected]),
  );
  const next = visitedTabsWith(visited, selected);
  if (next !== visited) {
    setVisited(next);
  }
  return next;
}
