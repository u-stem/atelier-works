// flowの図の組み立て。定義のステップに実行の状態を重ね、箱と線の座標を決める純関数。
// 語は`screens/jobs/FlowDiagram.tsx`が表示する。実行の状態の語は、ジョブ詳細と同じ`stepStateInfo`で決める。

import type { StepViewData } from "../api/jobsQueries.ts";
import type {
  ExitVia,
  FlowDefinition,
  FlowEntry,
  FlowExit,
  FlowStep,
} from "./flowsData.ts";
import type { JobStateInfo } from "./jobsView.ts";

/** 定義のステップ1つと、重ねる実行の状態。 */
export type StepNode = {
  readonly step: FlowStep;
  /** 重ねるジョブにそのステップが無ければ`null`。 */
  readonly state: JobStateInfo | null;
  readonly running: boolean;
  /** ステップの子のジョブ。無ければ`null`。 */
  readonly jobId: string | null;
};

export type FlowDiagramModel = {
  readonly flow: FlowDefinition;
  readonly steps: readonly StepNode[];
  /** 定義に無いidのステップ。ジョブが返した順に並ぶ。 */
  readonly unknownSteps: readonly StepViewData[];
};

/** 条件で飛ぶステップに添える語。 */
export const CONDITIONAL_WORD = "条件で飛ぶ";

/** 定義に無いステップの見出し。 */
export const UNKNOWN_STEPS_HEADING = "定義に無いステップ";

export function flowDiagramModel(
  flow: FlowDefinition,
  _progress: readonly StepViewData[] | null,
): FlowDiagramModel {
  return { flow, steps: [], unknownSteps: [] };
}

/** 入口に書く文。 */
export function entryText(_entry: FlowEntry): string {
  return "";
}

/** 出口に書く、経路の語。 */
export function exitWord(_via: ExitVia): string {
  return "";
}

/** 出口に書く文。経路の語と、次のflowの名前を「: 」でつなぐ。 */
export function exitText(_exit: FlowExit): string {
  return "";
}

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type DiagramBox =
  | (Box & { readonly kind: "entry"; readonly entry: FlowEntry })
  | (Box & { readonly kind: "step"; readonly node: StepNode })
  | (Box & { readonly kind: "exit"; readonly exit: FlowExit });

export type Point = { readonly x: number; readonly y: number };

export type DiagramLink = {
  readonly kind: "entry" | "next" | "exit";
  readonly from: Point;
  readonly to: Point;
};

export type DiagramLayout = {
  readonly boxes: readonly DiagramBox[];
  readonly links: readonly DiagramLink[];
  readonly width: number;
  readonly height: number;
};

export function layoutFlowDiagram(_model: FlowDiagramModel): DiagramLayout {
  return { boxes: [], links: [], width: 0, height: 0 };
}
