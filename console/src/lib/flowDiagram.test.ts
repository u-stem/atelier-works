import { describe, expect, test } from "bun:test";
import type { StepViewData } from "../api/jobsQueries.ts";
import {
  activeScrollLeft,
  CONDITIONAL_EDGES_NOTE,
  CONDITIONAL_WORD,
  type DiagramBox,
  type DiagramLayout,
  drawnEntries,
  entryText,
  exitOriginText,
  exitText,
  exitWord,
  type FlowDiagramModel,
  flowDiagramModel,
  groupEntriesForList,
  hasConditionalEdges,
  isSelfExit,
  layoutFlowDiagram,
  stepLinkLabel,
  UNKNOWN_STEPS_HEADING,
  unwiredText,
} from "./flowDiagram.ts";
import {
  FIT_CHROME_WIDTH,
  type GraphPresentation,
  graphPresentation,
} from "./flowGraphFit.ts";
import { FLOWS_DATA, type FlowDefinition, findFlow } from "./flowsData.ts";

function realFlow(name: string): FlowDefinition {
  const flow = findFlow(FLOWS_DATA, name);
  if (flow === null) throw new Error(`no flow ${name}`);
  return flow;
}

function stepData(
  id: string,
  state: string,
  options: { skipped?: boolean; jobId?: string | null } = {},
): StepViewData {
  return {
    id,
    state,
    job_id: options.jobId ?? null,
    iterations: null,
    skipped: options.skipped ?? false,
  };
}

const FLOW: FlowDefinition = {
  name: "pr_fix",
  summary: "修正",
  description: "",
  steps: [
    {
      id: "a",
      summary: "A",
      scriptPath: "f/factory/steps/a",
      conditional: false,
    },
    {
      id: "b",
      summary: "B",
      scriptPath: "f/factory/steps/b",
      conditional: true,
    },
    {
      id: "c",
      summary: "C",
      scriptPath: "f/factory/steps/c",
      conditional: false,
    },
  ],
  entries: [],
  unwiredEntries: [],
  exits: [],
};

describe("flowDiagramModel", () => {
  test("keeps the steps in the order of the definition, not of the job", () => {
    const model = flowDiagramModel(FLOW, [
      stepData("c", "waiting"),
      stepData("a", "success"),
      stepData("b", "success"),
    ]);

    expect(model.steps.map((node) => node.step.id)).toEqual(["a", "b", "c"]);
  });

  test("overlays the state of a step by id", () => {
    const model = flowDiagramModel(FLOW, [stepData("a", "failure")]);

    expect(model.steps[0]?.state?.label).toBe("失敗");
  });

  test("marks the running step", () => {
    const model = flowDiagramModel(FLOW, [
      stepData("a", "success"),
      stepData("b", "running"),
    ]);

    expect(model.steps.map((node) => node.running)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("uses the word of the job detail for a skipped step", () => {
    const model = flowDiagramModel(FLOW, [
      stepData("b", "success", { skipped: true }),
    ]);

    expect(model.steps[1]?.state?.label).toBe("スキップ");
  });

  test("leaves a defined step without a state when the job has no such step", () => {
    const model = flowDiagramModel(FLOW, [stepData("a", "success")]);

    expect(model.steps[2]?.state).toBeNull();
  });

  test("leaves every state empty when nothing overlays", () => {
    const model = flowDiagramModel(FLOW, null);

    expect(model.steps.map((node) => node.state)).toEqual([null, null, null]);
  });

  test("keeps the child job of a step", () => {
    const model = flowDiagramModel(FLOW, [
      stepData("a", "success", {
        jobId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
      }),
    ]);

    expect(model.steps[0]?.jobId).toBe("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c");
  });

  test("collects steps that the definition lacks, in the order of the job", () => {
    const model = flowDiagramModel(FLOW, [
      stepData("old2", "failure"),
      stepData("a", "success"),
      stepData("old1", "success"),
    ]);

    expect(model.unknownSteps.map((step) => step.id)).toEqual(["old2", "old1"]);
  });

  test("collects nothing when every id matches", () => {
    const model = flowDiagramModel(FLOW, [stepData("a", "success")]);

    expect(model.unknownSteps).toEqual([]);
  });

  test("collects nothing when nothing overlays", () => {
    expect(flowDiagramModel(FLOW, null).unknownSteps).toEqual([]);
  });

  test("does not mistake a step id that every object has for a defined step", () => {
    const model = flowDiagramModel(FLOW, [stepData("constructor", "success")]);

    expect(model.unknownSteps.map((step) => step.id)).toEqual(["constructor"]);
  });
});

describe("the overlay of a model", () => {
  test("has no overlay when nothing overlays", () => {
    expect(flowDiagramModel(FLOW, null).overlay).toBe(false);
  });

  test("has an overlay when a job overlays, even without steps", () => {
    expect(flowDiagramModel(FLOW, []).overlay).toBe(true);
  });
});

describe("hasConditionalEdges", () => {
  test.each(["pipeline", "implement", "pr_fix", "design"])(
    "is true for %s, which has an edge that settings or limits decide",
    (name) => {
      expect(hasConditionalEdges(realFlow(name))).toBe(true);
    },
  );

  test.each(["pr_review", "audit", "dependabot", "manual_intake"])(
    "is false for %s",
    (name) => {
      expect(hasConditionalEdges(realFlow(name))).toBe(false);
    },
  );

  test("writes the note", () => {
    expect(CONDITIONAL_EDGES_NOTE).toBe(
      "設定や試行の上限により、起動しない場合があります。",
    );
  });
});

describe("groupEntriesForList", () => {
  const grouped = groupEntriesForList(realFlow("pipeline"));

  test("gathers the flows whose step starts the flow", () => {
    expect(grouped.launchFlows).toEqual(["manual_intake"]);
  });

  test("gathers the flows that send work back", () => {
    expect(grouped.reworkFlows).toEqual(["design", "implement", "pr_fix"]);
  });

  test("leaves out the entry from the flow itself", () => {
    expect(
      grouped.entries.filter(
        (entry) => entry.kind === "flow" && entry.flow === "pipeline",
      ),
    ).toEqual([]);
  });

  test("keeps the schedule, the human entries and the entry from the rejection of design", () => {
    expect(grouped.entries.map((entry) => entry.kind).sort()).toEqual([
      "flow",
      "human",
      "schedule",
    ]);
  });

  test("keeps the entry from the approval of another flow", () => {
    expect(groupEntriesForList(realFlow("implement")).entries).toContainEqual({
      kind: "flow",
      flow: "pipeline",
      via: "approve",
    });
  });
});

describe("drawnEntries", () => {
  test("leaves out the entry from the flow itself", () => {
    expect(
      drawnEntries(realFlow("pipeline")).filter(
        (entry) => entry.kind === "flow" && entry.flow === "pipeline",
      ),
    ).toEqual([]);
  });

  test("keeps the entry from the approval of another flow", () => {
    expect(drawnEntries(realFlow("implement"))).toContainEqual({
      kind: "flow",
      flow: "pipeline",
      via: "approve",
    });
  });

  test("keeps every entry of a flow that has no entry from itself", () => {
    expect(drawnEntries(realFlow("pr_fix"))).toEqual(
      realFlow("pr_fix").entries,
    );
  });
});

describe("isSelfExit", () => {
  test("is true for the exit back to the flow itself", () => {
    expect(
      isSelfExit(realFlow("pipeline"), {
        flow: "pipeline",
        step: "request_approval",
        via: "reject",
      }),
    ).toBe(true);
  });

  test("is false for the exit to another flow", () => {
    expect(
      isSelfExit(realFlow("pipeline"), {
        flow: "implement",
        step: "request_approval",
        via: "approve",
      }),
    ).toBe(false);
  });
});

describe("the words", () => {
  test("names the conditional step", () => {
    expect(CONDITIONAL_WORD).toBe("条件で飛ぶ");
  });

  test("names the steps that the definition lacks", () => {
    expect(UNKNOWN_STEPS_HEADING).toBe("定義に無いステップ");
  });

  test("writes a schedule entry with its name", () => {
    expect(entryText({ kind: "schedule", name: "poll_prs" })).toBe(
      "スケジュール poll_prs",
    );
  });

  test("writes a human entry with its label", () => {
    expect(entryText({ kind: "human", label: "Consoleの再実行" })).toBe(
      "Consoleの再実行",
    );
  });

  test("writes a script entry with its name", () => {
    expect(
      entryText({ kind: "script", name: "auto_retry", caller: null }),
    ).toBe("script auto_retry");
  });

  test("writes the entry from the step of another flow", () => {
    expect(entryText({ kind: "flow", flow: "pr_fix", via: "launch" })).toBe(
      "pr_fixのステップ",
    );
  });

  test("writes the entry from an approval", () => {
    expect(entryText({ kind: "flow", flow: "pipeline", via: "approve" })).toBe(
      "pipelineの承認",
    );
  });

  test("writes the entry from a rejection", () => {
    expect(entryText({ kind: "flow", flow: "pipeline", via: "reject" })).toBe(
      "pipelineの却下",
    );
  });

  test.each([
    ["launch", "次に起動"],
    ["approve", "承認の後"],
    ["reject", "却下の後"],
    ["rework", "差し戻し"],
  ] as const)("names the way %s of an exit", (via, word) => {
    expect(exitWord(via)).toBe(word);
  });

  test("writes the entry from a flow that sends work back", () => {
    expect(entryText({ kind: "flow", flow: "implement", via: "rework" })).toBe(
      "implementの差し戻し",
    );
  });

  test("writes a script entry with the script that calls it", () => {
    expect(
      entryText({ kind: "script", name: "stale", caller: "self_update" }),
    ).toBe("script stale(self_updateから起動)");
  });

  test("writes an exit that sends work back", () => {
    expect(exitText({ flow: "pipeline", step: "x", via: "rework" })).toBe(
      "差し戻し: pipeline",
    );
  });

  test("writes the step an exit comes from", () => {
    expect(
      exitOriginText({
        flow: "pipeline",
        step: "request_approval",
        via: "reject",
      }),
    ).toBe("request_approvalから");
  });

  test("writes an entry that does not start the flow yet", () => {
    expect(
      unwiredText({ kind: "flow", flow: "pipeline", via: "approve" }),
    ).toBe("pipelineの承認からは、まだ起動されません。");
  });

  test("labels the link of a step with its summary and id", () => {
    expect(
      stepLinkLabel({
        id: "generate",
        summary: "要件定義の生成",
        scriptPath: "f/factory/steps/x",
        conditional: false,
      }),
    ).toBe("要件定義の生成(generate)のログと結果を見る");
  });

  test("writes an exit with the way and the next flow", () => {
    expect(exitText({ flow: "implement", step: "x", via: "approve" })).toBe(
      "承認の後: implement",
    );
  });
});

function overlaps(a: DiagramBox, b: DiagramBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function layoutOf(
  name: string,
  progress: readonly StepViewData[] | null = null,
) {
  return layoutFlowDiagram(flowDiagramModel(realFlow(name), progress));
}

function boxesOf(layout: DiagramLayout, kind: DiagramBox["kind"]) {
  return layout.boxes.filter((box) => box.kind === kind);
}

describe("layoutFlowDiagram", () => {
  test.each(FLOWS_DATA?.flows.map((flow) => flow.name) ?? [])(
    "draws no box over another box in %s",
    (name) => {
      const boxes = layoutOf(name).boxes;
      const pairs = boxes.flatMap((box, index) =>
        boxes.slice(index + 1).map((other) => [box, other] as const),
      );

      expect(pairs.filter(([a, b]) => overlaps(a, b))).toEqual([]);
    },
  );

  test.each(FLOWS_DATA?.flows.map((flow) => flow.name) ?? [])(
    "keeps every box inside the extent in %s",
    (name) => {
      const layout = layoutOf(name);

      expect(
        layout.boxes.filter(
          (box) =>
            box.x < 0 ||
            box.y < 0 ||
            box.x + box.width > layout.width ||
            box.y + box.height > layout.height,
        ),
      ).toEqual([]);
    },
  );

  test("draws a box for every entry, step and exit", () => {
    const flow = realFlow("pipeline");

    expect(layoutOf("pipeline").boxes).toHaveLength(
      drawnEntries(flow).length + flow.steps.length + flow.exits.length,
    );
  });

  test("draws no box for the entry from the flow itself", () => {
    expect(
      boxesOf(layoutOf("pipeline"), "entry").filter(
        (box) =>
          box.kind === "entry" &&
          box.entry.kind === "flow" &&
          box.entry.flow === "pipeline",
      ),
    ).toEqual([]);
  });

  test("draws one entry box fewer than the data has for pipeline", () => {
    expect(boxesOf(layoutOf("pipeline"), "entry")).toHaveLength(
      realFlow("pipeline").entries.length - 1,
    );
  });

  test("draws a link from every entry to the steps", () => {
    expect(
      layoutOf("pipeline").links.filter((link) => link.kind === "entry"),
    ).toHaveLength(drawnEntries(realFlow("pipeline")).length);
  });

  test("puts the entries to the left of the steps", () => {
    const layout = layoutOf("pipeline");
    const entryRight = Math.max(
      ...boxesOf(layout, "entry").map((box) => box.x + box.width),
    );
    const stepLeft = Math.min(...boxesOf(layout, "step").map((box) => box.x));

    expect(entryRight).toBeLessThan(stepLeft);
  });

  test("lines the steps up from left to right in the order of the definition", () => {
    const layout = layoutOf("pr_fix");
    const ids = boxesOf(layout, "step")
      .sort((a, b) => a.x - b.x)
      .map((box) => (box.kind === "step" ? box.node.step.id : ""));

    expect(ids).toEqual(realFlow("pr_fix").steps.map((step) => step.id));
  });

  test("puts every step on one row", () => {
    const rows = new Set(
      boxesOf(layoutOf("pr_fix"), "step").map((box) => box.y),
    );

    expect(rows.size).toBe(1);
  });

  test("puts the exits below the steps", () => {
    const layout = layoutOf("pipeline");
    const stepBottom = Math.max(
      ...boxesOf(layout, "step").map((box) => box.y + box.height),
    );
    const exitTop = Math.min(...boxesOf(layout, "exit").map((box) => box.y));

    expect(exitTop).toBeGreaterThan(stepBottom);
  });

  test("draws every exit of the approval step", () => {
    expect(boxesOf(layoutOf("pipeline"), "exit")).toHaveLength(3);
  });

  test("links each entry to the first step", () => {
    const layout = layoutOf("pipeline");
    const first = boxesOf(layout, "step").sort((a, b) => a.x - b.x)[0];
    const links = layout.links.filter((link) => link.kind === "entry");

    expect(links.filter((link) => link.to.x !== first?.x).length).toBe(0);
  });

  test("links neighbouring steps", () => {
    expect(
      layoutOf("pr_fix").links.filter((link) => link.kind === "next"),
    ).toHaveLength(4);
  });

  test("links the exit to its step", () => {
    const layout = layoutOf("pr_fix");
    const exit = boxesOf(layout, "exit")[0];
    const link = layout.links.find((candidate) => candidate.kind === "exit");

    expect(link?.to.y).toBe(exit?.y);
  });

  test("draws no exit row for a flow without exits", () => {
    expect(boxesOf(layoutOf("pr_review"), "exit")).toEqual([]);
  });

  test("draws the same boxes whether or not a state overlays", () => {
    const flow = realFlow("pr_fix");
    const first = flow.steps[0]?.id ?? "";

    expect(layoutOf("pr_fix", [stepData(first, "running")]).width).toBe(
      layoutOf("pr_fix").width,
    );
  });

  test("scrolls in the widest body exactly the flows whose exits spread to the right", () => {
    const scrolled = (FLOWS_DATA?.flows ?? [])
      .filter((flow) => layoutOf(flow.name).width > 1152 - FIT_CHROME_WIDTH)
      .map((flow) => flow.name)
      .sort();

    expect(scrolled).toEqual(["design", "pipeline", "pr_fix"]);
  });

  test("scrolls the widest flow in a narrower body", () => {
    expect(graphPresentation(900, layoutOf("pr_fix").width)).toBe("scroll");
  });
});

/** 作業項目の詳細の本文の幅(px)。 */
const ITEM_BODY_WIDTH = 760;

describe("the diagram without the column of entries", () => {
  function embeddedLayout(
    name: string,
    progress: readonly StepViewData[] | null = null,
  ) {
    return layoutFlowDiagram(flowDiagramModel(realFlow(name), progress), {
      entries: false,
    });
  }

  test("draws no entry box", () => {
    expect(boxesOf(embeddedLayout("pr_fix"), "entry")).toEqual([]);
  });

  test("draws no link from an entry", () => {
    expect(
      embeddedLayout("pr_fix").links.filter((link) => link.kind === "entry"),
    ).toEqual([]);
  });

  test("starts the steps at the margin", () => {
    expect(boxesOf(embeddedLayout("pr_fix"), "step")[0]?.x).toBe(20);
  });

  test("is narrower than the diagram with entries", () => {
    expect(embeddedLayout("pr_fix").width).toBeLessThan(
      layoutOf("pr_fix").width,
    );
  });

  test("keeps the diagram with entries when the option is left out", () => {
    expect(boxesOf(layoutOf("pr_fix"), "entry")).toHaveLength(
      drawnEntries(realFlow("pr_fix")).length,
    );
  });

  const EXPECTED: readonly (readonly [string, GraphPresentation])[] = [
    ["audit", "fit"],
    ["dependabot", "fit"],
    ["design", "scroll"],
    ["implement", "scroll"],
    ["manual_intake", "fit"],
    ["pipeline", "scroll"],
    ["pr_fix", "scroll"],
    ["pr_review", "fit"],
  ];

  test.each(EXPECTED)(
    "shows %s in the body of a work item as %s",
    (name, expected) => {
      expect(
        graphPresentation(ITEM_BODY_WIDTH, embeddedLayout(name).width),
      ).toBe(expected);
    },
  );

  test("covers every flow of the data in the table above", () => {
    expect(FLOWS_DATA?.flows.map((flow) => flow.name).sort()).toEqual([
      "audit",
      "dependabot",
      "design",
      "implement",
      "manual_intake",
      "pipeline",
      "pr_fix",
      "pr_review",
    ]);
  });
});

describe("activeScrollLeft", () => {
  const VIEWPORT = ITEM_BODY_WIDTH - FIT_CHROME_WIDTH;

  function scrollOf(progress: readonly StepViewData[] | null) {
    return activeScrollLeft(
      layoutFlowDiagram(flowDiagramModel(realFlow("pr_fix"), progress), {
        entries: false,
      }),
      VIEWPORT,
    );
  }

  test("is null when the job is not drawn", () => {
    expect(scrollOf(null)).toBeNull();
  });

  test("is null when no step is running or failed", () => {
    expect(scrollOf([stepData("pr_fix_prepare", "success")])).toBeNull();
  });

  test("is zero when the running step is already in view", () => {
    expect(scrollOf([stepData("pr_fix_prepare", "running")])).toBe(0);
  });

  test("moves a running step on the right edge into view", () => {
    const last = realFlow("pr_fix").steps[4];
    const layout = layoutFlowDiagram(
      flowDiagramModel(realFlow("pr_fix"), [
        stepData(last?.id ?? "", "running"),
      ]),
      { entries: false },
    );

    expect(activeScrollLeft(layout, VIEWPORT)).toBe(layout.width - VIEWPORT);
  });

  test("centers a running step in the middle", () => {
    const middle = realFlow("pr_fix").steps[2];
    const layout = layoutFlowDiagram(
      flowDiagramModel(realFlow("pr_fix"), [
        stepData(middle?.id ?? "", "running"),
      ]),
      { entries: false },
    );
    const box = boxesOf(layout, "step")[2];

    expect(activeScrollLeft(layout, VIEWPORT)).toBe(
      (box?.x ?? 0) + (box?.width ?? 0) / 2 - VIEWPORT / 2,
    );
  });

  test("brings a failed step into view as well", () => {
    const last = realFlow("pr_fix").steps[4];
    const layout = layoutFlowDiagram(
      flowDiagramModel(realFlow("pr_fix"), [
        stepData(last?.id ?? "", "failure"),
      ]),
      { entries: false },
    );

    expect(activeScrollLeft(layout, VIEWPORT)).toBeGreaterThan(0);
  });
});

describe("the model of a real flow", () => {
  test("has a conditional step in pipeline", () => {
    const model: FlowDiagramModel = flowDiagramModel(
      realFlow("pipeline"),
      null,
    );

    expect(model.steps.some((node) => node.step.conditional)).toBe(true);
  });
});
