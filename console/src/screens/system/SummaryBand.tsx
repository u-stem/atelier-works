import type { BandRow } from "../../lib/summaryBand.ts";
import type { SystemTabId } from "../../lib/systemTabs.ts";

/**
 * システムの画面の先頭の要約の帯。チップごとに結論と段を出し、押すと関係する節か画面へ移る。
 * タブと一緒に本文のスクロール枠の外に置き、タブを替えても見える。
 */
export function SummaryBand(_props: {
  rows: readonly BandRow[];
  onJump: (tab: SystemTabId, targetId: string) => void;
}) {
  return null;
}
