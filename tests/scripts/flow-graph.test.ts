import { describe, expect, test } from "bun:test";
import {
  buildFlowGraph,
  type FlowGraphInput,
  renderFlowGraphJson,
} from "../../scripts/flow-graph.ts";

const INPUT: FlowGraphInput = {
  edges: [
    { from: "poll_prs", to: "pr_fix", kind: "script" },
    { from: "retry_work_item", to: "pipeline", kind: "script" },
    { from: "steps/pr_fix_finish", to: "pipeline", kind: "script" },
    { from: "form", to: "manual_intake", kind: "human" },
  ],
  humanOperations: { form: "人がフォームから実行" },
  humanEntryScripts: { retry_work_item: "Consoleの再実行" },
  schedules: [
    {
      name: "poll_prs",
      cron: "0 */5 * * * *",
      target: "f/factory/poll_prs",
      isFlow: false,
    },
    {
      name: "cleanup_db",
      cron: "0 30 3 * * *",
      target: "f/factory/cleanup_db",
      isFlow: false,
    },
  ],
  flows: [
    {
      name: "pipeline",
      summary: "[SF-2-1] 要件定義の生成と承認",
      stepPaths: ["f/factory/steps/pipeline_prepare"],
    },
    {
      name: "pr_fix",
      summary: "[SF-4-1] レビュー指摘の修正",
      stepPaths: [
        "f/factory/steps/pr_fix_finish",
        "f/factory/steps/pr_fix_prepare",
      ],
    },
    {
      name: "manual_intake",
      summary: "手動投入フォーム",
      stepPaths: [],
    },
  ],
};

function nodeIds(input: FlowGraphInput, kind: string): string[] {
  return buildFlowGraph(input)
    .nodes.filter((node) => node.kind === kind)
    .map((node) => node.id);
}

function edgeKeys(input: FlowGraphInput, kind: string): string[] {
  return buildFlowGraph(input)
    .edges.filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.from} -> ${edge.to}`);
}

describe("buildFlowGraph", () => {
  test("makes one flow node per flow, in name order", () => {
    expect(nodeIds(INPUT, "flow")).toEqual([
      "flow:manual_intake",
      "flow:pipeline",
      "flow:pr_fix",
    ]);
  });

  test("labels a flow with its name and the summary without the id prefix", () => {
    const node = buildFlowGraph(INPUT).nodes.find(
      (candidate) => candidate.id === "flow:pipeline",
    );

    expect(node).toEqual({
      id: "flow:pipeline",
      kind: "flow",
      label: "pipeline",
      note: "要件定義の生成と承認",
    });
  });

  test("makes script nodes only for scripts that start a flow", () => {
    expect(nodeIds(INPUT, "script")).toEqual([
      "script:poll_prs",
      "script:retry_work_item",
      "script:steps/pr_fix_finish",
    ]);
  });

  test("makes a schedule node with the cron for a script that starts a flow", () => {
    const node = buildFlowGraph(INPUT).nodes.find(
      (candidate) => candidate.id === "schedule:poll_prs",
    );

    expect(node).toEqual({
      id: "schedule:poll_prs",
      kind: "schedule",
      label: "poll_prs",
      note: "0 */5 * * * *",
    });
  });

  test("leaves out a schedule that does not start a flow", () => {
    expect(nodeIds(INPUT, "schedule")).toEqual(["schedule:poll_prs"]);
  });

  test("connects a schedule to its script", () => {
    expect(edgeKeys(INPUT, "schedule")).toEqual([
      "schedule:poll_prs -> script:poll_prs",
    ]);
  });

  test("connects a schedule that runs a flow directly to the flow", () => {
    const input: FlowGraphInput = {
      ...INPUT,
      schedules: [
        {
          name: "nightly",
          cron: "0 0 3 * * *",
          target: "f/factory/pipeline",
          isFlow: true,
        },
      ],
    };

    expect(edgeKeys(input, "schedule")).toEqual([
      "schedule:nightly -> flow:pipeline",
    ]);
  });

  test("connects a script to each flow it starts", () => {
    expect(edgeKeys(INPUT, "run")).toEqual([
      "script:poll_prs -> flow:pr_fix",
      "script:retry_work_item -> flow:pipeline",
      "script:steps/pr_fix_finish -> flow:pipeline",
    ]);
  });

  test("makes a human node for an operation that starts a flow", () => {
    const node = buildFlowGraph(INPUT).nodes.find(
      (candidate) => candidate.id === "human:op:form",
    );

    expect(node).toEqual({
      id: "human:op:form",
      kind: "human",
      label: "人がフォームから実行",
      note: "",
    });
  });

  test("connects a human operation to the flow it starts, and a console operation to its script", () => {
    expect(edgeKeys(INPUT, "human")).toEqual([
      "human:entry:retry_work_item -> script:retry_work_item",
      "human:op:form -> flow:manual_intake",
    ]);
  });

  test("connects a flow to the launching scripts among its steps", () => {
    expect(edgeKeys(INPUT, "step")).toEqual([
      "flow:pr_fix -> script:steps/pr_fix_finish",
    ]);
  });

  test("does not depend on the order of the input", () => {
    const reversed: FlowGraphInput = {
      ...INPUT,
      edges: [...INPUT.edges].reverse(),
      schedules: [...INPUT.schedules].reverse(),
      flows: [...INPUT.flows].reverse(),
    };

    expect(buildFlowGraph(reversed)).toEqual(buildFlowGraph(INPUT));
  });

  test("throws when an edge targets a flow that does not exist", () => {
    const input: FlowGraphInput = {
      ...INPUT,
      edges: [{ from: "poll_prs", to: "missing", kind: "script" }],
    };

    expect(() => buildFlowGraph(input)).toThrow(
      "launch edge targets an unknown flow: missing",
    );
  });
});

describe("renderFlowGraphJson", () => {
  test("ends with a newline", () => {
    expect(renderFlowGraphJson(buildFlowGraph(INPUT)).endsWith("}\n")).toBe(
      true,
    );
  });

  test("round-trips through JSON.parse", () => {
    const graph = buildFlowGraph(INPUT);

    expect(JSON.parse(renderFlowGraphJson(graph))).toEqual(graph);
  });
});
