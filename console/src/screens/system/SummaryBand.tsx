import type { BandRow } from "../../lib/summaryBand.ts";
import type { SystemTabId } from "../../lib/systemTabs.ts";

/**
 * システムの画面の先頭の要約の帯。各行は結論と段と最終取得時刻を出し、押すと関係するタブの節へ移る。
 * タブの上に置き、タブを替えても見える。目次の役も兼ねる。
 */
export function SummaryBand(_props: {
  rows: readonly BandRow[];
  now: number;
  onJump: (tab: SystemTabId, targetId: string) => void;
}) {
  return null;
}
