import { describe, expect, test } from "bun:test";
import {
  buildFlowsData,
  type FlowsInput,
  renderFlowsJson,
  withoutIdPrefix,
} from "../../scripts/flow-graph.ts";

describe("withoutIdPrefix", () => {
  test.each([
    ["[SF-1-2] PRを巡回", "PRを巡回"],
    ["[SYS-6] DBを掃除", "DBを掃除"],
    ["[OP-1-1/1] Issue を作成", "Issue を作成"],
    ["[LIB] 共通の部品", "共通の部品"],
  ])("strips the prefix of %s", (summary, expected) => {
    expect(withoutIdPrefix(summary)).toBe(expected);
  });

  test("keeps a summary without a prefix", () => {
    expect(withoutIdPrefix("監査")).toBe("監査");
  });

  test("removes only the leading prefix", () => {
    expect(withoutIdPrefix("[SF-1-1] 巡回 [参考]")).toBe("巡回 [参考]");
  });
});

const FACTORY = "f/factory/";

function stepInput(
  id: string,
  script: string,
  summary = `[SF-0] ${id}`,
  conditional = false,
) {
  return { id, summary, path: `${FACTORY}${script}`, conditional };
}

const FLOWS_INPUT: FlowsInput = {
  edges: [
    { from: "poll_issues", to: "pipeline", kind: "script" },
    { from: "poll_prs", to: "pr_fix", kind: "script" },
    { from: "retry_work_item", to: "pipeline", kind: "script" },
    { from: "steps/requirements_apply", to: "implement", kind: "script" },
    { from: "steps/requirements_apply", to: "pipeline", kind: "script" },
    { from: "steps/requirements_apply", to: "design", kind: "script" },
    { from: "steps/design_generate", to: "pipeline", kind: "script" },
    { from: "steps/pr_fix_finish", to: "pipeline", kind: "script" },
    { from: "steps/manual_intake_register", to: "pipeline", kind: "script" },
    { from: "form", to: "manual_intake", kind: "human" },
  ],
  humanOperations: { form: "人がフォームから実行" },
  humanEntryScripts: {
    retry_work_item: "Consoleの再実行",
    "steps/requirements_apply": "Consoleの承認と却下",
  },
  schedules: [
    {
      name: "poll_issues",
      summary: "[SF-1-1] Issueを巡回して担当を確定",
      cron: "0 */5 * * * *",
      target: "f/factory/poll_issues",
      isFlow: false,
      enabled: true,
    },
    {
      name: "poll_prs",
      summary: "[SF-1-2] PRを巡回",
      cron: "0 */5 * * * *",
      target: "f/factory/poll_prs",
      isFlow: false,
      enabled: true,
    },
    {
      name: "cleanup_db",
      summary: "[SYS-6] DBを掃除",
      cron: "0 30 3 * * *",
      target: "f/factory/cleanup_db",
      isFlow: false,
      enabled: true,
    },
  ],
  flows: [
    {
      name: "pipeline",
      summary: "[SF-2-1] 要件定義の生成と承認",
      description: "要件定義を生成します。",
      steps: [
        stepInput(
          "prepare",
          "steps/pipeline_prepare",
          "[SF-2-1/1] 作業領域の準備",
        ),
        stepInput(
          "request_approval",
          "steps/pipeline_request_approval",
          "[SF-2-1/3] 承認依頼",
          true,
        ),
      ],
    },
    {
      name: "design",
      summary: "[SF-2-3] 設計書の生成と承認",
      description: "",
      steps: [
        stepInput("generate", "steps/design_generate"),
        stepInput("request_approval", "steps/design_request_approval"),
      ],
    },
    {
      name: "implement",
      summary: "[SF-3-4] 実装とPR作成",
      description: "",
      steps: [stepInput("implement_prepare", "steps/implement_prepare")],
    },
    {
      name: "pr_fix",
      summary: "[SF-3-2] レビュー指摘の修正",
      description: "",
      steps: [stepInput("pr_fix_finish", "steps/pr_fix_finish")],
    },
    {
      name: "manual_intake",
      summary: "[OP-1-1] 手動投入フォーム",
      description: "",
      steps: [stepInput("register", "steps/manual_intake_register")],
    },
  ],
  approvalSteps: {
    "steps/pipeline_request_approval": "steps/requirements_apply",
    "steps/design_request_approval": null,
  },
  approvalOutcomes: {
    "steps/requirements_apply": [
      { to: "implement", outcome: "approve" },
      { to: "pipeline", outcome: "reject" },
      { to: "design", outcome: "approve" },
    ],
  },
  reworkEdges: [
    { from: "steps/design_generate", to: "pipeline" },
    { from: "steps/pr_fix_finish", to: "pipeline" },
  ],
  scriptCallers: {},
  prRelationEdges: [],
  unwiredEdges: [
    { from: "steps/requirements_apply", to: "design", kind: "script" },
  ],
};

function flowOf(input: FlowsInput, name: string) {
  return buildFlowsData(input).flows.find((flow) => flow.name === name);
}

describe("buildFlowsData: steps", () => {
  test("lists the steps in module order", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.steps.map((s) => s.id)).toEqual([
      "prepare",
      "request_approval",
    ]);
  });

  test("drops the id prefix from a step summary", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.steps[0]?.summary).toBe(
      "作業領域の準備",
    );
  });

  test("marks a step with skip_if as conditional", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.steps[1]?.conditional).toBe(true);
  });

  test("keeps the script path of a step", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.steps[0]?.scriptPath).toBe(
      "f/factory/steps/pipeline_prepare",
    );
  });

  test("keeps the summary without the prefix and the description of a flow", () => {
    const flow = flowOf(FLOWS_INPUT, "pipeline");

    expect([flow?.summary, flow?.description]).toEqual([
      "要件定義の生成と承認",
      "要件定義を生成します。",
    ]);
  });

  test("makes the flows in name order", () => {
    expect(buildFlowsData(FLOWS_INPUT).flows.map((flow) => flow.name)).toEqual([
      "design",
      "implement",
      "manual_intake",
      "pipeline",
      "pr_fix",
    ]);
  });
});

describe("buildFlowsData: entries", () => {
  test("names the flow of a launching step as an entry", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.entries).toContainEqual({
      kind: "flow",
      flow: "manual_intake",
      via: "launch",
    });
  });

  test("names the flow that sends work back as a rework entry", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.entries).toContainEqual({
      kind: "flow",
      flow: "pr_fix",
      via: "rework",
    });
  });

  test("does not name a rework entry as a plain launch", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.entries).not.toContainEqual({
      kind: "flow",
      flow: "pr_fix",
      via: "launch",
    });
  });

  test("shows a schedule of a launching script as an entry", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.entries).toContainEqual({
      kind: "schedule",
      name: "poll_issues",
    });
  });

  test("shows the console operation of a launching script as an entry", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.entries).toContainEqual({
      kind: "human",
      label: "Consoleの再実行",
    });
  });

  test("shows a human operation as an entry", () => {
    expect(flowOf(FLOWS_INPUT, "manual_intake")?.entries).toEqual([
      { kind: "human", label: "人がフォームから実行" },
    ]);
  });

  test("shows a launching script without a schedule or an operation as a script", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      edges: [{ from: "self_retry", to: "pr_fix", kind: "script" }],
    };

    expect(flowOf(input, "pr_fix")?.entries).toEqual([
      { kind: "script", name: "self_retry", caller: null },
    ]);
  });

  test("names the script that calls a launching script as the caller", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      edges: [{ from: "self_retry", to: "pr_fix", kind: "script" }],
      scriptCallers: { self_retry: "self_update" },
    };

    expect(flowOf(input, "pr_fix")?.entries).toEqual([
      { kind: "script", name: "self_retry", caller: "self_update" },
    ]);
  });

  test("does not give a caller to a script that has a schedule", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      scriptCallers: { poll_prs: "self_update" },
    };

    expect(flowOf(input, "pr_fix")?.entries).toEqual([
      { kind: "schedule", name: "poll_prs" },
    ]);
  });

  test("shows the approval step of the flow as the entry of the approved flow", () => {
    expect(flowOf(FLOWS_INPUT, "implement")?.entries).toEqual([
      { kind: "flow", flow: "pipeline", via: "approve" },
    ]);
  });

  test("shows the rejection as an entry of the flow itself", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.entries).toContainEqual({
      kind: "flow",
      flow: "pipeline",
      via: "reject",
    });
  });

  test("does not show the console operation of the approval handler as an entry", () => {
    expect(flowOf(FLOWS_INPUT, "implement")?.entries).not.toContainEqual({
      kind: "human",
      label: "Consoleの承認と却下",
    });
  });

  test("shows the script instead of a disabled schedule as an entry", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      schedules: FLOWS_INPUT.schedules.map((schedule) => ({
        ...schedule,
        enabled: false,
      })),
    };

    expect(flowOf(input, "pr_fix")?.entries).toEqual([
      { kind: "script", name: "poll_prs", caller: null },
    ]);
  });

  test("shows a schedule that runs a flow directly as an entry", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      schedules: [
        {
          name: "nightly",
          summary: "夜間",
          cron: "0 0 3 * * *",
          target: "f/factory/pr_fix",
          isFlow: true,
          enabled: true,
        },
      ],
      edges: [],
    };

    expect(flowOf(input, "pr_fix")?.entries).toEqual([
      { kind: "schedule", name: "nightly" },
    ]);
  });

  test("does not draw an unwired edge as an entry", () => {
    expect(flowOf(FLOWS_INPUT, "design")?.entries).toEqual([]);
  });

  test("keeps the unwired edge apart as an entry that does not start the flow yet", () => {
    expect(flowOf(FLOWS_INPUT, "design")?.unwiredEntries).toEqual([
      { kind: "flow", flow: "pipeline", via: "approve" },
    ]);
  });

  test("gives a flow without an unwired edge no unwired entries", () => {
    expect(flowOf(FLOWS_INPUT, "implement")?.unwiredEntries).toEqual([]);
  });

  test("does not read an inherited key of a table as an operation of a script", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      edges: [{ from: "constructor", to: "pr_fix", kind: "script" }],
    };

    expect(flowOf(input, "pr_fix")?.entries).toEqual([
      { kind: "script", name: "constructor", caller: null },
    ]);
  });

  test("does not read an inherited key of a table as the name of an operation", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      edges: [{ from: "toString", to: "manual_intake", kind: "human" }],
    };

    expect(flowOf(input, "manual_intake")?.entries).toEqual([
      { kind: "human", label: "toString" },
    ]);
  });
});

describe("buildFlowsData: exits", () => {
  test("puts the exit of a launching step on that step", () => {
    expect(flowOf(FLOWS_INPUT, "manual_intake")?.exits).toEqual([
      { flow: "pipeline", step: "register", via: "launch" },
    ]);
  });

  test("marks the exit that sends work back as a rework exit", () => {
    expect(flowOf(FLOWS_INPUT, "pr_fix")?.exits).toEqual([
      { flow: "pipeline", step: "pr_fix_finish", via: "rework" },
    ]);
  });

  test("keeps the exit of a script named like an inherited key", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      edges: [{ from: "constructor", to: "pipeline", kind: "script" }],
      flows: FLOWS_INPUT.flows.map((flow) =>
        flow.name === "pr_fix"
          ? { ...flow, steps: [stepInput("a", "constructor")] }
          : flow,
      ),
    };

    expect(flowOf(input, "pr_fix")?.exits).toEqual([
      { flow: "pipeline", step: "a", via: "launch" },
    ]);
  });

  test("puts the approve and reject exits on the approval step only", () => {
    expect(flowOf(FLOWS_INPUT, "pipeline")?.exits).toEqual([
      { flow: "implement", step: "request_approval", via: "approve" },
      { flow: "pipeline", step: "request_approval", via: "reject" },
    ]);
  });

  test("gives a flow whose approval has no handler no approval exit", () => {
    expect(
      flowOf(FLOWS_INPUT, "design")?.exits.filter(
        (exit) => exit.step === "request_approval",
      ),
    ).toEqual([]);
  });

  test("does not draw an unwired edge as an exit", () => {
    expect(
      flowOf(FLOWS_INPUT, "pipeline")?.exits.map((exit) => exit.flow),
    ).not.toContain("design");
  });

  test("leaves no mark of implement_enabled on the approve exit", () => {
    expect(
      Object.keys(flowOf(FLOWS_INPUT, "pipeline")?.exits[0] ?? {}).sort(),
    ).toEqual(["flow", "step", "via"]);
  });

  test("throws when an edge of the approval handler has no outcome", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      approvalOutcomes: {
        "steps/requirements_apply": [
          { to: "implement", outcome: "approve" },
          { to: "pipeline", outcome: "reject" },
        ],
      },
    };

    expect(() => buildFlowsData(input)).toThrow(
      "approval handler edge has no outcome: steps/requirements_apply -> design",
    );
  });

  test("throws when an edge targets an unknown flow", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      edges: [{ from: "poll_prs", to: "missing", kind: "script" }],
    };

    expect(() => buildFlowsData(input)).toThrow(
      "launch edge targets an unknown flow: missing",
    );
  });
});

/** PRを介した関係を持つ入力。pr_reviewが追加のflowで、pr_fixが戻りの行き先になる。 */
const PR_INPUT: FlowsInput = {
  ...FLOWS_INPUT,
  flows: [
    ...FLOWS_INPUT.flows,
    {
      name: "pr_review",
      summary: "[SF-3-1] PRの自動レビュー",
      description: "",
      steps: [stepInput("post", "steps/pr_review_post")],
    },
  ],
  prRelationEdges: [
    { from: "steps/pr_review_post", to: "pr_fix", direction: "forward" },
    { from: "steps/pr_fix_finish", to: "pr_review", direction: "return" },
  ],
};

describe("buildFlowsData: PR relation edges", () => {
  test("resolves a PR relation edge to the step and the entry", () => {
    const review = flowOf(PR_INPUT, "pr_review");
    const fix = flowOf(PR_INPUT, "pr_fix");

    expect({
      exit: review?.exits,
      entry: fix?.entries.filter(
        (entry) => entry.kind === "flow" && entry.via === "pr",
      ),
    }).toEqual({
      exit: [{ flow: "pr_fix", step: "post", via: "pr" }],
      entry: [{ kind: "flow", flow: "pr_review", via: "pr" }],
    });
  });

  test("marks a return edge as an exit and an entry of the way pr_return", () => {
    const fix = flowOf(PR_INPUT, "pr_fix");
    const review = flowOf(PR_INPUT, "pr_review");

    expect({
      exit: fix?.exits.filter((exit) => exit.via === "pr_return"),
      entry: review?.entries.filter(
        (entry) => entry.kind === "flow" && entry.via === "pr_return",
      ),
    }).toEqual({
      exit: [{ flow: "pr_review", step: "pr_fix_finish", via: "pr_return" }],
      entry: [{ kind: "flow", flow: "pr_fix", via: "pr_return" }],
    });
  });

  test("puts the PR exit after the other exits of the same step", () => {
    expect(flowOf(PR_INPUT, "pr_fix")?.exits.map((exit) => exit.via)).toEqual([
      "rework",
      "pr_return",
    ]);
  });

  test("keeps the entries in the order of the way", () => {
    expect(
      flowOf(PR_INPUT, "pr_fix")?.entries.map((entry) =>
        entry.kind === "flow" ? entry.via : entry.kind,
      ),
    ).toEqual(["schedule", "pr"]);
  });

  test("leaves the exits of a flow without a PR relation as they are", () => {
    expect(flowOf(PR_INPUT, "manual_intake")?.exits).toEqual(
      flowOf(FLOWS_INPUT, "manual_intake")?.exits,
    );
  });

  test("does not add a PR relation to the flows of a schedule", () => {
    expect(buildFlowsData(PR_INPUT).schedules).toEqual(
      buildFlowsData(FLOWS_INPUT).schedules,
    );
  });

  test("names a flow that two steps lead into once for each way", () => {
    const input: FlowsInput = {
      ...PR_INPUT,
      prRelationEdges: [
        ...PR_INPUT.prRelationEdges,
        { from: "steps/pr_review_post", to: "pr_fix", direction: "forward" },
      ],
    };

    expect(
      flowOf(input, "pr_fix")?.entries.filter(
        (entry) => entry.kind === "flow" && entry.via === "pr",
      ),
    ).toEqual([{ kind: "flow", flow: "pr_review", via: "pr" }]);
  });

  test("throws when a PR relation edge targets an unknown flow", () => {
    const input: FlowsInput = {
      ...PR_INPUT,
      prRelationEdges: [
        { from: "steps/pr_review_post", to: "missing", direction: "forward" },
      ],
    };

    expect(() => buildFlowsData(input)).toThrow(
      "PR relation edge targets an unknown flow: missing",
    );
  });

  test("throws when a PR relation edge starts at a script no flow runs", () => {
    const input: FlowsInput = {
      ...PR_INPUT,
      prRelationEdges: [
        { from: "steps/nowhere", to: "pr_fix", direction: "forward" },
      ],
    };

    expect(() => buildFlowsData(input)).toThrow(
      "PR relation edge starts at a script no flow runs: steps/nowhere",
    );
  });

  test("does not depend on the order of the PR relation edges", () => {
    const reversed: FlowsInput = {
      ...PR_INPUT,
      prRelationEdges: [...PR_INPUT.prRelationEdges].reverse(),
    };

    expect(buildFlowsData(reversed)).toEqual(buildFlowsData(PR_INPUT));
  });
});

describe("buildFlowsData: schedules", () => {
  function scheduleOf(input: FlowsInput, name: string) {
    return buildFlowsData(input).schedules.find((item) => item.name === name);
  }

  test("gives each schedule its summary without the prefix", () => {
    expect(scheduleOf(FLOWS_INPUT, "poll_issues")?.summary).toBe(
      "Issueを巡回して担当を確定",
    );
  });

  test("links a schedule to the flows its script launches", () => {
    expect(scheduleOf(FLOWS_INPUT, "poll_prs")?.flows).toEqual(["pr_fix"]);
  });

  test("gives a schedule that launches nothing an empty flow list", () => {
    expect(scheduleOf(FLOWS_INPUT, "cleanup_db")?.flows).toEqual([]);
  });

  test("links a schedule that runs a flow directly to that flow", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      schedules: [
        {
          name: "nightly",
          summary: "夜間",
          cron: "0 0 3 * * *",
          target: "f/factory/pr_fix",
          isFlow: true,
          enabled: true,
        },
      ],
    };

    expect(scheduleOf(input, "nightly")?.flows).toEqual(["pr_fix"]);
  });

  test("gives a disabled schedule no flow link but keeps its summary", () => {
    const input: FlowsInput = {
      ...FLOWS_INPUT,
      schedules: FLOWS_INPUT.schedules.map((schedule) => ({
        ...schedule,
        enabled: false,
      })),
    };

    expect(scheduleOf(input, "poll_prs")).toEqual({
      name: "poll_prs",
      summary: "PRを巡回",
      flows: [],
    });
  });

  test("lists the schedules in name order", () => {
    expect(
      buildFlowsData(FLOWS_INPUT).schedules.map((item) => item.name),
    ).toEqual(["cleanup_db", "poll_issues", "poll_prs"]);
  });
});

describe("buildFlowsData: the script that is called by another", () => {
  const input: FlowsInput = {
    ...FLOWS_INPUT,
    edges: [{ from: "self_retry", to: "pr_fix", kind: "script" }],
    scriptCallers: { self_retry: "self_update" },
    schedules: [
      {
        name: "self_update",
        summary: "[SYS-1] 最新化",
        cron: "0 0 * * * *",
        target: "f/factory/self_update",
        isFlow: false,
        enabled: true,
      },
    ],
  };

  test("adds the flows of the called script to the schedule of the caller", () => {
    expect(
      buildFlowsData(input).schedules.find(
        (item) => item.name === "self_update",
      )?.flows,
    ).toEqual(["pr_fix"]);
  });

  test("adds nothing when the schedule of the caller is disabled", () => {
    const disabled: FlowsInput = {
      ...input,
      schedules: input.schedules.map((item) => ({ ...item, enabled: false })),
    };

    expect(
      buildFlowsData(disabled).schedules.find(
        (item) => item.name === "self_update",
      )?.flows,
    ).toEqual([]);
  });

  test("adds nothing for a schedule that is not the caller", () => {
    const other: FlowsInput = {
      ...input,
      scriptCallers: { self_retry: "someone_else" },
    };

    expect(
      buildFlowsData(other).schedules.find(
        (item) => item.name === "self_update",
      )?.flows,
    ).toEqual([]);
  });
});

describe("buildFlowsData", () => {
  test("does not depend on the order of the input", () => {
    const reversed: FlowsInput = {
      ...FLOWS_INPUT,
      edges: [...FLOWS_INPUT.edges].reverse(),
      schedules: [...FLOWS_INPUT.schedules].reverse(),
      flows: [...FLOWS_INPUT.flows].reverse(),
    };

    expect(buildFlowsData(reversed)).toEqual(buildFlowsData(FLOWS_INPUT));
  });
});

describe("renderFlowsJson", () => {
  test("ends with a newline", () => {
    expect(renderFlowsJson(buildFlowsData(FLOWS_INPUT)).endsWith("}\n")).toBe(
      true,
    );
  });

  test("round-trips through JSON.parse", () => {
    const data = buildFlowsData(FLOWS_INPUT);

    expect(JSON.parse(renderFlowsJson(data))).toEqual(data);
  });

  test("puts a short array of names on one line, as the formatter does", () => {
    const json = renderFlowsJson({
      flows: [],
      schedules: [{ name: "poll_prs", summary: "x", flows: ["a", "b"] }],
    });

    expect(json).toContain('"flows": ["a", "b"]');
  });

  test("keeps an empty array as it is", () => {
    const json = renderFlowsJson({
      flows: [],
      schedules: [{ name: "x", summary: "y", flows: [] }],
    });

    expect(json).toContain('"flows": []');
  });
});
