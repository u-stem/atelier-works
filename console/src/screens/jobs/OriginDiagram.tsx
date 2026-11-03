import type { OriginGraphModel, OriginRunView } from "../../lib/originGraph.ts";

/**
 * 起動の図の本体。状態を持たず、幅と開いているflowを引数で受ける。
 * 幅に合わせて、図、横にスクロールする枠の図、列ごとの一覧のどれかで描く。
 */
export function OriginDiagramView(props: {
  model: OriginGraphModel;
  run: OriginRunView;
  width: number;
  expanded: ReadonlySet<string>;
  onToggle: (flow: string, open: boolean) => void;
}) {
  void props;
  return null;
}
