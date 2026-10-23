import type { FlowGraph } from "../console/src/lib/flowGraph.ts";
import type { LaunchEdge } from "./launch-graph.ts";

export type ScheduleInput = {
  /** `f/factory/<name>.schedule.yaml`の`<name>`。 */
  readonly name: string;
  readonly cron: string;
  /** スケジュールが実行するscriptかflowのpath(`f/factory/poll_issues`)。 */
  readonly target: string;
  readonly isFlow: boolean;
};

export type FlowInput = {
  readonly name: string;
  readonly summary: string;
  /** flowのモジュールが実行するscriptのpath(`f/factory/steps/pr_fix_finish`)。 */
  readonly stepPaths: readonly string[];
};

export type FlowGraphInput = {
  readonly edges: readonly LaunchEdge[];
  readonly humanOperations: Readonly<Record<string, string>>;
  readonly humanEntryScripts: Readonly<Record<string, string>>;
  readonly schedules: readonly ScheduleInput[];
  readonly flows: readonly FlowInput[];
};

export function buildFlowGraph(_input: FlowGraphInput): FlowGraph {
  return { nodes: [], edges: [] };
}

export function renderFlowGraphJson(_graph: FlowGraph): string {
  return "";
}
