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
import { type JobStateInfo, stepStateInfo } from "./jobsView.ts";

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

/**
 * flowの定義に、ジョブのステップの状態を重ねる。重ねるものが無ければ`progress`は`null`にする。
 * ステップは定義の順に並べ、idの突き合わせだけで状態を決める。
 * 定義に無いidのステップは、`unknownSteps`に分ける。定義を直した後に古いジョブを開いても、止まったステップを隠さないためである。
 */
export function flowDiagramModel(
  flow: FlowDefinition,
  progress: readonly StepViewData[] | null,
): FlowDiagramModel {
  const byId = new Map<string, StepViewData>();
  for (const data of progress ?? []) {
    if (!byId.has(data.id)) byId.set(data.id, data);
  }
  const defined = new Set(flow.steps.map((step) => step.id));
  return {
    flow,
    steps: flow.steps.map((step) => {
      const data = byId.get(step.id);
      return {
        step,
        state: data === undefined ? null : stepStateInfo(data),
        running: data?.state === "running",
        jobId: data?.job_id ?? null,
      };
    }),
    unknownSteps: (progress ?? []).filter((data) => !defined.has(data.id)),
  };
}

/** 入口に書く文。 */
export function entryText(entry: FlowEntry): string {
  switch (entry.kind) {
    case "schedule":
      return `スケジュール ${entry.name}`;
    case "human":
      return entry.label;
    case "script":
      return `script ${entry.name}`;
    case "flow":
      return entry.via === "launch"
        ? `${entry.flow}のステップ`
        : entry.via === "approve"
          ? `${entry.flow}の承認`
          : `${entry.flow}の却下`;
  }
}

const EXIT_WORDS: Readonly<Record<ExitVia, string>> = {
  launch: "次に起動",
  approve: "承認の後",
  reject: "却下の後",
};

/** 出口に書く、経路の語。 */
export function exitWord(via: ExitVia): string {
  return EXIT_WORDS[via];
}

/** 出口に書く文。経路の語と、次のflowの名前を「: 」でつなぐ。 */
export function exitText(exit: FlowExit): string {
  return `${exitWord(exit.via)}: ${exit.flow}`;
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

export const MARGIN = 20;
export const ENTRY_WIDTH = 172;
export const ENTRY_HEIGHT = 44;
const ENTRY_GAP = 10;
export const STEP_WIDTH = 150;
export const STEP_HEIGHT = 96;
const STEP_GAP = 26;
const COLUMN_GAP = 40;
export const EXIT_WIDTH = 176;
export const EXIT_HEIGHT = 44;
const EXIT_GAP = 12;
const ROW_GAP = 48;

/**
 * 図の配置を決める。入口は左の列に縦に並べ、ステップは右へ一列に並べ、出口はステップの下の行に並べる。
 * 出口は、つくステップの真下に置く。同じ行で重なるときは右へずらす。
 * 線は隣り合う列と行の間だけを引くので、他の箱の上を通らない。
 * 箱の幅は、5ステップのflowが、Consoleの本体の最大の幅(1152px)に収まるように決めた。
 */
export function layoutFlowDiagram(model: FlowDiagramModel): DiagramLayout {
  const { flow, steps } = model;
  const entriesHeight =
    flow.entries.length === 0
      ? 0
      : flow.entries.length * ENTRY_HEIGHT +
        (flow.entries.length - 1) * ENTRY_GAP;
  const contentHeight = Math.max(entriesHeight, STEP_HEIGHT);
  const centerY = MARGIN + contentHeight / 2;
  const stepsLeft =
    MARGIN + (flow.entries.length === 0 ? 0 : ENTRY_WIDTH + COLUMN_GAP);
  const stepY = centerY - STEP_HEIGHT / 2;

  const boxes: DiagramBox[] = [];
  const links: DiagramLink[] = [];

  const stepBoxes = steps.map((node, index): DiagramBox => {
    return {
      kind: "step",
      node,
      x: stepsLeft + index * (STEP_WIDTH + STEP_GAP),
      y: stepY,
      width: STEP_WIDTH,
      height: STEP_HEIGHT,
    };
  });
  const first = stepBoxes[0];

  flow.entries.forEach((entry, index) => {
    const y = centerY - entriesHeight / 2 + index * (ENTRY_HEIGHT + ENTRY_GAP);
    boxes.push({
      kind: "entry",
      entry,
      x: MARGIN,
      y,
      width: ENTRY_WIDTH,
      height: ENTRY_HEIGHT,
    });
    if (first !== undefined) {
      links.push({
        kind: "entry",
        from: { x: MARGIN + ENTRY_WIDTH, y: y + ENTRY_HEIGHT / 2 },
        to: { x: first.x, y: centerY },
      });
    }
  });

  stepBoxes.forEach((box, index) => {
    boxes.push(box);
    const next = stepBoxes[index + 1];
    if (next !== undefined) {
      links.push({
        kind: "next",
        from: { x: box.x + box.width, y: centerY },
        to: { x: next.x, y: centerY },
      });
    }
  });

  const exitY = MARGIN + contentHeight + ROW_GAP;
  let exitRight = Number.NEGATIVE_INFINITY;
  for (const exit of flow.exits) {
    const owner = stepBoxes.find(
      (box) => box.kind === "step" && box.node.step.id === exit.step,
    );
    if (owner === undefined) continue;
    const ownerCenter = owner.x + owner.width / 2;
    const x = Math.max(
      MARGIN,
      ownerCenter - EXIT_WIDTH / 2,
      exitRight + EXIT_GAP,
    );
    exitRight = x + EXIT_WIDTH;
    boxes.push({
      kind: "exit",
      exit,
      x,
      y: exitY,
      width: EXIT_WIDTH,
      height: EXIT_HEIGHT,
    });
    links.push({
      kind: "exit",
      from: { x: ownerCenter, y: owner.y + owner.height },
      to: { x: x + EXIT_WIDTH / 2, y: exitY },
    });
  }

  const hasExits = exitRight !== Number.NEGATIVE_INFINITY;
  const stepsRight =
    stepBoxes.length === 0
      ? stepsLeft
      : stepsLeft + stepBoxes.length * (STEP_WIDTH + STEP_GAP) - STEP_GAP;
  return {
    boxes,
    links,
    width: Math.max(stepsRight, hasExits ? exitRight : 0) + MARGIN,
    height: exitY + (hasExits ? EXIT_HEIGHT : -ROW_GAP) + MARGIN,
  };
}
