import { describe, expect, test } from "bun:test";
import flowsJson from "../generated/flows.json";
import {
  FLOWS_DATA,
  findFlow,
  flowDiagramPath,
  flowHistoryPath,
  flowRouteState,
  parseFlowsData,
  scheduleFlowsOf,
} from "./flowsData.ts";

function step(id: string) {
  return {
    id,
    summary: `${id}の説明`,
    scriptPath: `f/factory/steps/${id}`,
    conditional: false,
  };
}

function flow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    summary: `${name}の概要`,
    description: "",
    steps: [step("prepare"), step("finish")],
    entries: [{ kind: "human", label: "人" }],
    exits: [],
    ...overrides,
  };
}

function valid(overrides: Record<string, unknown> = {}) {
  return {
    flows: [
      flow("pipeline", {
        exits: [{ flow: "implement", step: "finish", via: "approve" }],
      }),
      flow("implement", {
        entries: [{ kind: "flow", flow: "pipeline", via: "approve" }],
      }),
    ],
    schedules: [
      { name: "poll_prs", summary: "PRを巡回", flows: ["pipeline"] },
      { name: "cleanup_db", summary: "DBを掃除", flows: [] },
    ],
    ...overrides,
  };
}

describe("parseFlowsData", () => {
  test("accepts the committed data", () => {
    expect(parseFlowsData(flowsJson)).not.toBeNull();
  });

  test("reads a value of the expected shape", () => {
    expect(parseFlowsData(valid())?.flows.map((item) => item.name)).toEqual([
      "pipeline",
      "implement",
    ]);
  });

  test("rejects a value that is not an object", () => {
    expect(parseFlowsData(null)).toBeNull();
  });

  test("rejects flows that are not an array", () => {
    expect(parseFlowsData(valid({ flows: {} }))).toBeNull();
  });

  test("rejects a duplicate flow name", () => {
    expect(
      parseFlowsData(valid({ flows: [flow("pipeline"), flow("pipeline")] })),
    ).toBeNull();
  });

  test.each(["", "../x", "Pipeline", "a/b", "constructor!"])(
    "rejects the unsafe flow name %p",
    (name) => {
      expect(parseFlowsData(valid({ flows: [flow(name)] }))).toBeNull();
    },
  );

  test("rejects a step without an id", () => {
    expect(
      parseFlowsData(
        valid({ flows: [flow("pipeline", { steps: [{ summary: "x" }] })] }),
      ),
    ).toBeNull();
  });

  test("rejects a duplicate step id in a flow", () => {
    expect(
      parseFlowsData(
        valid({
          flows: [flow("pipeline", { steps: [step("a"), step("a")] })],
        }),
      ),
    ).toBeNull();
  });

  test("rejects an exit to an unknown flow", () => {
    expect(
      parseFlowsData(
        valid({
          flows: [
            flow("pipeline", {
              exits: [{ flow: "missing", step: "finish", via: "launch" }],
            }),
          ],
        }),
      ),
    ).toBeNull();
  });

  test("rejects an exit from a step the flow does not have", () => {
    expect(
      parseFlowsData(
        valid({
          flows: [
            flow("pipeline", {
              exits: [{ flow: "pipeline", step: "nope", via: "launch" }],
            }),
          ],
        }),
      ),
    ).toBeNull();
  });

  test("rejects an exit of an unknown kind of way", () => {
    expect(
      parseFlowsData(
        valid({
          flows: [
            flow("pipeline", {
              exits: [{ flow: "pipeline", step: "finish", via: "teleport" }],
            }),
          ],
        }),
      ),
    ).toBeNull();
  });

  test("rejects an entry of an unknown kind", () => {
    expect(
      parseFlowsData(
        valid({
          flows: [
            flow("pipeline", { entries: [{ kind: "queue", name: "x" }] }),
          ],
        }),
      ),
    ).toBeNull();
  });

  test("rejects an entry from an unknown flow", () => {
    expect(
      parseFlowsData(
        valid({
          flows: [
            flow("pipeline", {
              entries: [{ kind: "flow", flow: "missing", via: "launch" }],
            }),
          ],
        }),
      ),
    ).toBeNull();
  });

  test("rejects a schedule that links an unknown flow", () => {
    expect(
      parseFlowsData(
        valid({
          schedules: [{ name: "poll_prs", summary: "x", flows: ["missing"] }],
        }),
      ),
    ).toBeNull();
  });

  test("rejects a duplicate schedule name", () => {
    expect(
      parseFlowsData(
        valid({
          schedules: [
            { name: "a", summary: "x", flows: [] },
            { name: "a", summary: "y", flows: [] },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("FLOWS_DATA", () => {
  test("is read from the committed data", () => {
    expect(FLOWS_DATA).not.toBeNull();
  });
});

describe("findFlow", () => {
  const data = parseFlowsData(valid());

  test("returns the flow by name", () => {
    expect(findFlow(data, "implement")?.name).toBe("implement");
  });

  test("returns null for an unknown name", () => {
    expect(findFlow(data, "missing")).toBeNull();
  });

  test("returns null for a name that exists on every object", () => {
    expect(findFlow(data, "constructor")).toBeNull();
  });

  test("returns null when there is no data", () => {
    expect(findFlow(null, "pipeline")).toBeNull();
  });
});

describe("scheduleFlowsOf", () => {
  const data = parseFlowsData(valid());

  test("gives the description and the flows of a schedule", () => {
    expect(scheduleFlowsOf(data, "f/factory/poll_prs")).toEqual({
      name: "poll_prs",
      summary: "PRを巡回",
      flows: ["pipeline"],
    });
  });

  test("gives a schedule that launches nothing an empty flow list", () => {
    expect(scheduleFlowsOf(data, "f/factory/cleanup_db")?.flows).toEqual([]);
  });

  test("returns null for a schedule that is not in the data", () => {
    expect(scheduleFlowsOf(data, "f/factory/unknown")).toBeNull();
  });

  test("returns null for a path outside the factory folder", () => {
    expect(scheduleFlowsOf(data, "u/someone/poll_prs")).toBeNull();
  });

  test("returns null when there is no data", () => {
    expect(scheduleFlowsOf(null, "f/factory/poll_prs")).toBeNull();
  });
});

describe("flowDiagramPath", () => {
  const data = parseFlowsData(valid());

  test("returns the path of a known flow", () => {
    expect(flowDiagramPath("pipeline", data)).toBe("/jobs/flows/pipeline");
  });

  test("returns null for a flow that is not in the data", () => {
    expect(flowDiagramPath("missing", data)).toBeNull();
  });

  test.each(["", "a/b", "..", "Pipeline"])(
    "returns null for the unsafe name %p",
    (name) => {
      expect(flowDiagramPath(name, data)).toBeNull();
    },
  );

  test("returns null when there is no data", () => {
    expect(flowDiagramPath("pipeline", null)).toBeNull();
  });
});

describe("flowRouteState", () => {
  const data = parseFlowsData(valid());

  test("redirects to the list when the route has no name", () => {
    expect(flowRouteState(undefined, data)).toEqual({ kind: "redirect" });
  });

  test("redirects to the list when the route has no name and no data", () => {
    expect(flowRouteState(undefined, null)).toEqual({ kind: "redirect" });
  });

  test("says the data is unreadable when there is a name but no data", () => {
    expect(flowRouteState("pipeline", null)).toEqual({ kind: "unreadable" });
  });

  test("says not found for a name that is not in the data", () => {
    expect(flowRouteState("missing", data)).toEqual({ kind: "not_found" });
  });

  test.each(["", "../x", "constructor", "Pipeline"])(
    "says not found for the unsafe name %p",
    (name) => {
      expect(flowRouteState(name, data)).toEqual({ kind: "not_found" });
    },
  );

  test("finds a flow by its name", () => {
    expect(flowRouteState("pipeline", data).kind).toBe("found");
  });

  test("gives the flow that it found", () => {
    const state = flowRouteState("implement", data);

    expect(state.kind === "found" ? state.flow.name : "").toBe("implement");
  });
});

describe("flowHistoryPath", () => {
  test("filters the history by the script of the flow", () => {
    expect(flowHistoryPath("pipeline")).toBe(
      "/jobs?tab=history&script=f%2Ffactory%2Fpipeline",
    );
  });
});
