// flowを起動する辺の表(scripts/launch-graph.ts)と、f/factoryの実物を突き合わせる契約テスト。
//
// 起動の検出は文字列の照合で、追えない形がある。
// - `wmill.runFlowAsync`を別名の変数や文字列の組み立てで呼ぶ起動は、検出できない。
// - 起動先の検出は、flowのpathの文字列、`*_FLOW_PATH`の定数、起動を包む関数の名前に限る。
//   新しい包みの関数を足したら、FLOW_REFERENCESにも足す。
// - コメントは、行頭が`//`か`*`か`/*`の行だけを読み飛ばす。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeOrigin,
  HUMAN_ENTRY_SCRIPTS,
  HUMAN_OPERATIONS,
  LAUNCH_EDGES,
  REWORK_LAUNCH_EDGES,
  UNWIRED_LAUNCH_EDGES,
} from "../../scripts/launch-graph.ts";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");

/** 起動の呼び出しを検出する正規表現。 */
const LAUNCH_CALL = /\bwmill\.runFlow\w*\s*\(/;

/** 起動先のflowを示す識別子と、その先。 */
const FLOW_REFERENCES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\bPIPELINE_FLOW_PATH\b/, ["pipeline"]],
  [/\bIMPLEMENT_FLOW_PATH\b/, ["implement"]],
  [/\bDESIGN_FLOW_PATH\b/, ["design"]],
  [/\bDEPENDABOT_FLOW_PATH\b/, ["dependabot"]],
  [/\bPR_REVIEW_FLOW_PATH\b/, ["pr_review"]],
  [/\bPR_FIX_FLOW_PATH\b/, ["pr_fix"]],
  [/\bMANUAL_INTAKE_FLOW_PATH\b/, ["manual_intake"]],
  [/\blaunchPrFixFlow\b/, ["pr_fix"]],
  [/\bstartImplement\b/, ["implement"]],
  [/\bstartDesign\b/, ["design"]],
  [/\brerouteRequirementsGap\b/, ["pipeline"]],
  [/\bretryStaleImageItems\b/, ["implement", "pr_fix"]],
  [/\bretryTransientPrReviews\b/, ["pr_review"]],
];

function flowNames(): string[] {
  return [...new Bun.Glob("*__flow/flow.yaml").scanSync(FACTORY_DIR)]
    .map((path) => path.replace(/__flow\/flow\.yaml$/, ""))
    .sort();
}

/** コメントだけの行を除いたソースを返す。 */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

type Launcher = { readonly script: string; readonly code: string };

/** `f/factory`の下で、flowを起動する呼び出しを含むscriptを返す。 */
function launchers(): Launcher[] {
  const found: Launcher[] = [];
  for (const path of new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)) {
    if (path.endsWith(".test.ts")) continue;
    const code = codeOf(readFileSync(join(FACTORY_DIR, path), "utf8"));
    if (!LAUNCH_CALL.test(code)) continue;
    found.push({ script: path.replace(/\.ts$/, ""), code });
  }
  return found.sort((a, b) => a.script.localeCompare(b.script));
}

/** ソースが起動先として示すflowの名前を返す。 */
function referencedFlows(code: string, flows: readonly string[]): string[] {
  const names = new Set<string>();
  for (const [pattern, targets] of FLOW_REFERENCES) {
    if (pattern.test(code)) for (const target of targets) names.add(target);
  }
  for (const match of code.matchAll(/"f\/factory\/([a-z_]+)"/g)) {
    const name = match[1] ?? "";
    if (flows.includes(name)) names.add(name);
  }
  return [...names].sort();
}

const scriptEdges = LAUNCH_EDGES.filter((edge) => edge.kind === "script");
const humanEdges = LAUNCH_EDGES.filter((edge) => edge.kind === "human");

describe("launch edges and the scripts that start flows", () => {
  test("every script that starts a flow appears as an origin", () => {
    const origins = new Set(scriptEdges.map((edge) => edge.from));

    const missing = launchers()
      .map((launcher) => launcher.script)
      .filter((script) => !origins.has(script));

    expect(missing).toEqual([]);
  });

  test("every script origin starts a flow in its source", () => {
    const launching = new Set(launchers().map((launcher) => launcher.script));

    const stale = scriptEdges
      .map((edge) => edge.from)
      .filter((from) => !launching.has(from));

    expect(stale).toEqual([]);
  });

  test("every flow a launcher refers to is a target of its edges", () => {
    const flows = flowNames();

    const missing = launchers().flatMap((launcher) => {
      const targets = new Set(
        scriptEdges
          .filter((edge) => edge.from === launcher.script)
          .map((edge) => edge.to),
      );
      return referencedFlows(launcher.code, flows)
        .filter((flow) => !targets.has(flow))
        .map((flow) => `${launcher.script} -> ${flow}`);
    });

    expect(missing).toEqual([]);
  });
});

describe("each launch edge and its source", () => {
  test("every script edge is backed by a reference to its flow in the origin's source", () => {
    const flows = flowNames();
    const codes = new Map(
      launchers().map((launcher) => [launcher.script, launcher.code]),
    );

    const unbacked = scriptEdges
      .filter(
        (edge) =>
          !referencedFlows(codes.get(edge.from) ?? "", flows).includes(edge.to),
      )
      .map((edge) => `${edge.from} -> ${edge.to}`);

    expect(unbacked).toEqual([]);
  });

  test("every *_FLOW_PATH constant in a launcher is known to FLOW_REFERENCES", () => {
    const unknown = launchers().flatMap((launcher) =>
      [...launcher.code.matchAll(/\b[A-Z][A-Z_]*_FLOW_PATH\b/g)]
        .map((match) => match[0])
        .filter(
          (name) => !FLOW_REFERENCES.some(([pattern]) => pattern.test(name)),
        )
        .map((name) => `${launcher.script}: ${name}`),
    );

    expect(unknown).toEqual([]);
  });
});

describe("launch edges and the assets", () => {
  test("every target is an existing flow", () => {
    const flows = new Set(flowNames());

    const unknown = LAUNCH_EDGES.map((edge) => edge.to).filter(
      (to) => !flows.has(to),
    );

    expect(unknown).toEqual([]);
  });

  test("every flow has at least one origin", () => {
    const targets = new Set(LAUNCH_EDGES.map((edge) => edge.to));

    const orphans = flowNames().filter((flow) => !targets.has(flow));

    expect(orphans).toEqual([]);
  });

  test("every script origin is a deployed script", () => {
    const missing = scriptEdges
      .map((edge) => edge.from)
      .filter((from) => !existsSync(join(FACTORY_DIR, `${from}.script.yaml`)));

    expect(missing).toEqual([]);
  });

  test("every human origin is a known operation", () => {
    const unknown = humanEdges
      .map((edge) => edge.from)
      .filter((from) => !(from in HUMAN_OPERATIONS));

    expect(unknown).toEqual([]);
  });

  test("every known operation starts a flow", () => {
    const used = new Set(humanEdges.map((edge) => edge.from));

    const unused = Object.keys(HUMAN_OPERATIONS).filter(
      (operation) => !used.has(operation),
    );

    expect(unused).toEqual([]);
  });

  test("every entry script of a person is a script origin", () => {
    const origins = new Set(scriptEdges.map((edge) => edge.from));

    const unknown = Object.keys(HUMAN_ENTRY_SCRIPTS).filter(
      (script) => !origins.has(script),
    );

    expect(unknown).toEqual([]);
  });

  test("no edge is listed twice", () => {
    const keys = LAUNCH_EDGES.map((edge) => `${edge.from} -> ${edge.to}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("describeOrigin", () => {
  test("names the operation of a human edge", () => {
    const edge = LAUNCH_EDGES.find((candidate) => candidate.kind === "human");

    expect(edge === undefined ? "" : describeOrigin(edge)).toBe(
      "人がフォームから実行",
    );
  });

  test("shows a script origin in code", () => {
    const edge = LAUNCH_EDGES.find(
      (candidate) => candidate.from === "poll_issues",
    );

    expect(edge === undefined ? "" : describeOrigin(edge)).toBe(
      "`poll_issues`",
    );
  });

  test("uses the file name of a step script", () => {
    const edge = LAUNCH_EDGES.find(
      (candidate) => candidate.from === "steps/pr_fix_finish",
    );

    expect(edge === undefined ? "" : describeOrigin(edge)).toBe(
      "`pr_fix_finish`",
    );
  });

  test("lists the design flow among the flows the Console retry starts", () => {
    expect(LAUNCH_EDGES).toContainEqual({
      from: "retry_work_item",
      to: "design",
      kind: "script",
    });
  });

  test.each(["implement", "pipeline", "design"])(
    "lists the %s flow among the flows that design_apply starts",
    (flow) => {
      expect(LAUNCH_EDGES).toContainEqual({
        from: "steps/design_apply",
        to: flow,
        kind: "script",
      });
    },
  );

  test("lists the design flow among the flows that pr_fix_finish starts", () => {
    expect(LAUNCH_EDGES).toContainEqual({
      from: "steps/pr_fix_finish",
      to: "design",
      kind: "script",
    });
  });

  test("lists no edge as one that is not wired", () => {
    expect(UNWIRED_LAUNCH_EDGES).toEqual([]);
  });

  test("keeps the edge from requirements_apply to the design flow among the launch edges", () => {
    expect(LAUNCH_EDGES).toContainEqual({
      from: "steps/requirements_apply",
      to: "design",
      kind: "script",
    });
  });

  test("keeps the edge from requirements_apply to the implement flow among the launch edges", () => {
    expect(LAUNCH_EDGES).toContainEqual({
      from: "steps/requirements_apply",
      to: "implement",
      kind: "script",
    });
  });

  test("does not list the return of pr_fix_finish to the design flow as a rework edge", () => {
    expect(REWORK_LAUNCH_EDGES).not.toContainEqual({
      from: "steps/pr_fix_finish",
      to: "design",
    });
  });

  test("names the approval and rejection of the Console as the entry of design_apply", () => {
    expect(HUMAN_ENTRY_SCRIPTS["steps/design_apply"]).toBe(
      "Consoleの承認と却下",
    );
  });

  test("shows design_apply with the operation of a person", () => {
    const edge = LAUNCH_EDGES.find(
      (candidate) => candidate.from === "steps/design_apply",
    );

    expect(edge === undefined ? "" : describeOrigin(edge)).toBe(
      "`design_apply`(Consoleの承認と却下)",
    );
  });

  test("adds the operation of a person to an entry script", () => {
    const edge = LAUNCH_EDGES.find(
      (candidate) => candidate.from === "retry_work_item",
    );

    expect(edge === undefined ? "" : describeOrigin(edge)).toBe(
      "`retry_work_item`(Consoleの再実行)",
    );
  });
});
