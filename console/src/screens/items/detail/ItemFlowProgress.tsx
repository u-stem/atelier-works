import type { FlowGraph } from "../../../lib/flowGraph.ts";
import type { FlowProgressView } from "../../../lib/workItemFlowProgress.ts";

export function ItemFlowProgressView(_props: {
  kind: string;
  graph: FlowGraph | null;
  view: FlowProgressView;
  width: number;
}) {
  return null;
}

export function ItemFlowProgress(_props: {
  kind: string;
  view: FlowProgressView;
}) {
  return null;
}
