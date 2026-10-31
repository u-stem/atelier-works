// flowごとの図のデータ(console/src/generated/flows.json)が、f/factoryの実物と合うことを確かめる契約テスト。
// ステップのidはflow.yamlのモジュールと一致し、出口は起動の辺の表と承認の処理に合わせる。
// 承認の出口は、承認の処理が実際に起動するflowだけを描く。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FlowDefinition,
  type FlowsData,
  parseFlowsData,
} from "../../console/src/lib/flowsData.ts";
import { handlerPathFor } from "../../f/factory/lib/approval_support.ts";
import {
  KNOWN_FLOW_PATHS,
  REPO_SCHEDULES,
} from "../../f/factory/lib/console_known_paths.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import {
  type ApprovedBranchContext,
  buildApprovedBranchDeps,
} from "../../f/factory/steps/requirements_apply.ts";
import {
  APPROVAL_OUTCOMES,
  APPROVAL_STEPS,
  LAUNCH_EDGES,
  REWORK_LAUNCH_EDGES,
  SCRIPT_CALLERS,
  UNWIRED_LAUNCH_EDGES,
} from "../../scripts/launch-graph.ts";

const ROOT = join(import.meta.dir, "../..");
const FACTORY_DIR = join(ROOT, "f/factory");
const FACTORY_PREFIX = "f/factory/";

function load(): FlowsData {
  const raw: unknown = JSON.parse(
    readFileSync(join(ROOT, "console/src/generated/flows.json"), "utf8"),
  );
  const data = parseFlowsData(raw);
  if (data === null) throw new Error("flows.json is not in the expected shape");
  return data;
}

function flowNames(): string[] {
  return [...new Bun.Glob("*__flow/flow.yaml").scanSync(FACTORY_DIR)]
    .map((path) => path.replace(/__flow\/flow\.yaml$/, ""))
    .sort();
}

function moduleIds(name: string): string[] {
  const yaml: unknown = Bun.YAML.parse(
    readFileSync(join(FACTORY_DIR, `${name}__flow/flow.yaml`), "utf8"),
  );
  if (typeof yaml !== "object" || yaml === null || !("value" in yaml)) {
    return [];
  }
  const value = yaml.value;
  if (typeof value !== "object" || value === null || !("modules" in value)) {
    return [];
  }
  const modules = value.modules;
  if (!Array.isArray(modules)) return [];
  return modules.flatMap((module: unknown) =>
    typeof module === "object" &&
    module !== null &&
    "id" in module &&
    typeof module.id === "string"
      ? [module.id]
      : [],
  );
}

function flowOf(data: FlowsData, name: string): FlowDefinition {
  const flow = data.flows.find((candidate) => candidate.name === name);
  if (flow === undefined) throw new Error(`no flow ${name}`);
  return flow;
}

const data = load();
const relative = (path: string): string =>
  path.startsWith(FACTORY_PREFIX) ? path.slice(FACTORY_PREFIX.length) : path;

describe("the committed flows data", () => {
  test("passes the console's shape check", () => {
    expect(
      parseFlowsData(
        JSON.parse(
          readFileSync(join(ROOT, "console/src/generated/flows.json"), "utf8"),
        ),
      ),
    ).not.toBeNull();
  });

  test("has every flow of the repository", () => {
    expect(data.flows.map((flow) => flow.name).sort()).toEqual(flowNames());
  });

  test("has a flow for every flow path the console can see running", () => {
    expect(
      KNOWN_FLOW_PATHS.filter(
        (path) =>
          !data.flows.some((flow) => `${FACTORY_PREFIX}${flow.name}` === path),
      ),
    ).toEqual([]);
  });

  test.each(flowNames())(
    "the step ids of %s equal modules[].id of flow.yaml in order",
    (name) => {
      expect(flowOf(data, name).steps.map((step) => step.id)).toEqual(
        moduleIds(name),
      );
    },
  );

  test("every flow has at least one entry", () => {
    expect(data.flows.filter((flow) => flow.entries.length === 0)).toEqual([]);
  });

  test("every flow has a summary without a bracket prefix", () => {
    expect(
      data.flows.filter(
        (flow) => flow.summary === "" || flow.summary.startsWith("["),
      ),
    ).toEqual([]);
  });

  test("every step has a summary without a bracket prefix", () => {
    expect(
      data.flows
        .flatMap((flow) => flow.steps)
        .filter((step) => step.summary === "" || step.summary.startsWith("[")),
    ).toEqual([]);
  });

  test("every exit targets an existing flow", () => {
    const names = new Set(data.flows.map((flow) => flow.name));

    expect(
      data.flows
        .flatMap((flow) => flow.exits)
        .filter((exit) => !names.has(exit.flow)),
    ).toEqual([]);
  });
});

describe("the exits and the launch edges", () => {
  function stepScript(flow: FlowDefinition, stepId: string): string {
    const step = flow.steps.find((candidate) => candidate.id === stepId);
    return relative(step?.scriptPath ?? "");
  }

  test("every launch edge from a step script is drawn as an exit", () => {
    const missing = LAUNCH_EDGES.filter(
      (edge) => edge.kind === "script" && edge.from.startsWith("steps/"),
    ).filter(
      (edge) =>
        !data.flows.some((flow) =>
          flow.exits.some((exit) => {
            const script = stepScript(flow, exit.step);
            const handler = APPROVAL_STEPS[script];
            return (
              exit.flow === edge.to &&
              (script === edge.from ||
                (handler !== undefined && handlerOf(handler) === edge.from))
            );
          }),
        ),
    );

    expect(missing).toEqual([]);
  });

  test("pipeline approval exits: approve→design / approve→implement / reject→pipeline", () => {
    expect(
      flowOf(data, "pipeline").exits.filter(
        (exit) => exit.step === "request_approval",
      ),
    ).toEqual([
      { flow: "design", step: "request_approval", via: "approve" },
      { flow: "implement", step: "request_approval", via: "approve" },
      { flow: "pipeline", step: "request_approval", via: "reject" },
    ]);
  });

  test("the approval of design is handled by design_apply", () => {
    expect(handlerOf("design")).toBe("steps/design_apply");
  });

  test("design approval exits: approve→implement / reject→design / reject→pipeline", () => {
    expect(
      flowOf(data, "design").exits.filter(
        (exit) => exit.step === "request_approval",
      ),
    ).toEqual([
      { flow: "implement", step: "request_approval", via: "approve" },
      { flow: "design", step: "request_approval", via: "reject" },
      { flow: "pipeline", step: "request_approval", via: "reject" },
    ]);
  });

  test("no launch edge is left out of the diagrams as unwired", () => {
    expect(UNWIRED_LAUNCH_EDGES).toEqual([]);
  });

  test("no flow keeps an entry that does not start it yet", () => {
    expect(
      data.flows.flatMap((flow) => flow.unwiredEntries.map(() => flow.name)),
    ).toEqual([]);
  });

  test.each([true, false])(
    "buildApprovedBranchDeps passes startDesign null with design_enabled false and implement_enabled %p",
    (implementEnabled) => {
      expect(depsFor(implementEnabled, false).startDesign).toBeNull();
    },
  );

  test.each([true, false])(
    "buildApprovedBranchDeps wires startDesign with design_enabled true and implement_enabled %p, inside the design_enabled check only",
    (implementEnabled) => {
      expect(typeof depsFor(implementEnabled, true).startDesign).toBe(
        "function",
      );
    },
  );

  test("requirements_apply wires startDesign only inside the design_enabled check", () => {
    expect(
      readFileSync(join(FACTORY_DIR, "steps/requirements_apply.ts"), "utf8"),
    ).toMatch(
      /startDesign:\s*config\.design_enabled\s*\?\s*buildStartDesign\(/,
    );
  });

  test.each([
    [true, false],
    [false, true],
  ])(
    "buildApprovedBranchDeps with implement_enabled %p starts implement only when it is on (null is %p)",
    (implementEnabled, startsNothing) => {
      expect(depsFor(implementEnabled, false).startImplement === null).toBe(
        startsNothing,
      );
    },
  );
});

function handlerOf(kind: string): string | null {
  if (kind !== "requirements" && kind !== "design") return null;
  try {
    return relative(handlerPathFor(kind));
  } catch {
    return null;
  }
}

describe("the approval steps", () => {
  const approvalScripts = Object.keys(APPROVAL_STEPS);

  test.each(approvalScripts)(
    "the kind of %s matches the kind in its source",
    (script) => {
      const source = readFileSync(join(FACTORY_DIR, `${script}.ts`), "utf8");
      const match = /insertApprovalRequest\(\{\s*kind: "(\w+)"/.exec(source);

      expect(match?.[1]).toBe(APPROVAL_STEPS[script]);
    },
  );

  test("every request_approval step of the flows is an approval step", () => {
    const missing = data.flows
      .flatMap((flow) => flow.steps)
      .map((step) => relative(step.scriptPath))
      .filter((script) => script.endsWith("_request_approval"))
      .filter((script) => !approvalScripts.includes(script));

    expect(missing).toEqual([]);
  });

  test("the handler of a wired approval kind is the key of the outcome table", () => {
    const handlers = approvalScripts
      .map((script) => handlerOf(APPROVAL_STEPS[script] ?? ""))
      .filter((handler) => handler !== null);

    expect(
      handlers.every((handler) => Object.hasOwn(APPROVAL_OUTCOMES, handler)),
    ).toBe(true);
  });

  test("every edge of a handler has an outcome, wired or not", () => {
    const unlisted = LAUNCH_EDGES.filter((edge) =>
      Object.hasOwn(APPROVAL_OUTCOMES, edge.from),
    ).filter(
      (edge) =>
        !(APPROVAL_OUTCOMES[edge.from] ?? []).some(
          (outcome) => outcome.to === edge.to,
        ),
    );

    expect(unlisted).toEqual([]);
  });
});

describe("the schedules in the data", () => {
  test("every schedule of the repository has a description", () => {
    const described = new Set(data.schedules.map((item) => item.name));

    expect(
      REPO_SCHEDULES.map((item) => relative(item.path)).filter(
        (name) => !described.has(name),
      ),
    ).toEqual([]);
  });

  test("every schedule in the data is a schedule of the repository", () => {
    const paths = REPO_SCHEDULES.map((item) => relative(item.path));

    expect(data.schedules.filter((item) => !paths.includes(item.name))).toEqual(
      [],
    );
  });

  test("no description keeps a bracket prefix", () => {
    expect(
      data.schedules.filter(
        (item) => item.summary === "" || item.summary.startsWith("["),
      ),
    ).toEqual([]);
  });

  test("poll_prs links pr_review and pr_fix", () => {
    expect(
      data.schedules.find((item) => item.name === "poll_prs")?.flows,
    ).toEqual(["pr_fix", "pr_review"]);
  });

  test("self_update links the flows that the script it calls starts", () => {
    expect(
      data.schedules.find((item) => item.name === "self_update")?.flows,
    ).toEqual(["implement", "pr_fix"]);
  });

  test("cleanup_db launches no flow", () => {
    expect(
      data.schedules.find((item) => item.name === "cleanup_db")?.flows,
    ).toEqual([]);
  });
});

/** 承認の分岐の依存を、implement_enabledとdesign_enabledを変えて組み立てる。組み立てるだけで、外には触れない。 */
function depsFor(implementEnabled: boolean, designEnabled: boolean) {
  const item: WorkItem = {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "octo",
    repo: "widgets",
    issue_number: 42,
    issue_url: "https://github.com/octo/widgets/issues/42",
    pr_number: null,
    title: "t",
    body: "b",
    status: "awaiting_approval",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 0,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    ci_check_id: null,
    conflict_check_id: null,
    conflict_episode: null,
    design_attempt: 0,
    created_at: new Date("2026-10-26T00:00:00Z"),
    updated_at: new Date("2026-10-26T00:00:00Z"),
  };
  const context: ApprovedBranchContext = {
    workItem: item,
    issueNumber: 42,
    attempt: 1,
    client: {
      run: async () => {
        throw new Error("the builder must not call GitHub");
      },
      ghToken: "token",
    },
    viewerLogin: "factory-bot",
    webhookUrl: "",
    log: { info() {}, warn() {}, error() {} },
  };
  return buildApprovedBranchDeps(
    {
      implement_enabled: implementEnabled,
      design_enabled: designEnabled,
      windmill_public_url: "http://127.0.0.1:8080",
      instance_name: "local",
    },
    context,
  );
}

describe("the rework exits", () => {
  const sourceOf = (script: string): string =>
    readFileSync(join(FACTORY_DIR, `${script}.ts`), "utf8");

  test("every rework edge is an edge of the launch table", () => {
    expect(
      REWORK_LAUNCH_EDGES.filter(
        (edge) =>
          !LAUNCH_EDGES.some(
            (other) => other.from === edge.from && other.to === edge.to,
          ),
      ),
    ).toEqual([]);
  });

  test.each(REWORK_LAUNCH_EDGES.map((edge) => edge.from))(
    "%s sends work back because of a requirements gap",
    (from) => {
      expect(sourceOf(from)).toContain("requirements_gap");
    },
  );

  test("a step that starts pipeline without a rework edge reports no requirements gap", () => {
    const plain = LAUNCH_EDGES.filter(
      (edge) =>
        edge.kind === "script" &&
        edge.from.startsWith("steps/") &&
        edge.to === "pipeline" &&
        !REWORK_LAUNCH_EDGES.some((other) => other.from === edge.from),
    ).filter((edge) => sourceOf(edge.from).includes("requirements_gap"));

    expect(plain).toEqual([]);
  });

  test("the data draws each rework edge as a rework exit", () => {
    const missing = REWORK_LAUNCH_EDGES.filter(
      (edge) =>
        !data.flows.some((flow) =>
          flow.exits.some(
            (exit) =>
              exit.flow === edge.to &&
              exit.via === "rework" &&
              flow.steps.some(
                (step) =>
                  step.id === exit.step &&
                  relative(step.scriptPath) === edge.from,
              ),
          ),
        ),
    );

    expect(missing).toEqual([]);
  });

  test("the data draws no plain launch exit for a rework edge", () => {
    const plain = data.flows.flatMap((flow) =>
      flow.exits
        .filter((exit) => exit.via === "launch")
        .filter((exit) =>
          REWORK_LAUNCH_EDGES.some(
            (edge) =>
              edge.to === exit.flow &&
              flow.steps.some(
                (step) =>
                  step.id === exit.step &&
                  relative(step.scriptPath) === edge.from,
              ),
          ),
        ),
    );

    expect(plain).toEqual([]);
  });

  test("pipeline has a rework entry from every flow that sends work back", () => {
    const flows = new Set(
      data.flows
        .filter((flow) => flow.exits.some((exit) => exit.via === "rework"))
        .map((flow) => flow.name),
    );
    const entries = new Set(
      flowOf(data, "pipeline").entries.flatMap((entry) =>
        entry.kind === "flow" && entry.via === "rework" ? [entry.flow] : [],
      ),
    );

    expect([...flows].sort()).toEqual([...entries].sort());
  });
});

describe("the script entries", () => {
  const scriptEntries = data.flows.flatMap((flow) =>
    flow.entries.flatMap((entry) => (entry.kind === "script" ? [entry] : [])),
  );

  test("every script entry names the script that calls it", () => {
    expect(scriptEntries.filter((entry) => entry.caller === null)).toEqual([]);
  });

  test.each(Object.entries(SCRIPT_CALLERS))(
    "%s is called by %s in its source",
    (script, caller) => {
      expect(readFileSync(join(FACTORY_DIR, `${caller}.ts`), "utf8")).toContain(
        `"f/factory/${script}"`,
      );
    },
  );
});
