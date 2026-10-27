// 起動関係の図のデータ(console/src/generated/flow-graph.json)が、
// Consoleの検査を通り、実行の状態を重ねるパスとノードの対応と合うことを確かめる契約テスト。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlowGraph } from "../../console/src/lib/flowGraph.ts";
import {
  flowNodeId,
  flowPathOfNode,
} from "../../console/src/lib/flowOverlay.ts";
import {
  KNOWN_FLOW_PATHS,
  REPO_SCHEDULES,
} from "../../f/factory/lib/console_known_paths.ts";
import { FLOW_GRAPH_FILE } from "../../scripts/docs-gen.ts";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");

const raw: unknown = JSON.parse(readFileSync(FLOW_GRAPH_FILE, "utf8"));
const graph = parseFlowGraph(raw);

describe("the committed flow graph", () => {
  test("passes the console's shape check", () => {
    expect(graph).not.toBeNull();
  });

  test("has a node for every flow of the repository", () => {
    const names = [...new Bun.Glob("*__flow/flow.yaml").scanSync(FACTORY_DIR)]
      .map((path) => `flow:${path.replace(/__flow\/flow\.yaml$/, "")}`)
      .sort();
    const ids = (graph?.nodes ?? [])
      .filter((node) => node.kind === "flow")
      .map((node) => node.id)
      .sort();

    expect(ids).toEqual(names);
  });

  test("has an incoming edge for every flow", () => {
    const flows = graph?.nodes.filter((node) => node.kind === "flow") ?? [];
    const targets = new Set(
      (graph?.edges ?? [])
        .filter((edge) => edge.kind !== "step")
        .map((edge) => edge.to),
    );

    expect(flows.filter((flow) => !targets.has(flow.id))).toEqual([]);
  });

  test("has a node for every flow the console can see running", () => {
    const ids = new Set((graph?.nodes ?? []).map((node) => node.id));

    expect(
      KNOWN_FLOW_PATHS.filter((path) => !ids.has(flowNodeId(path) ?? "")),
    ).toEqual([]);
  });

  test("maps the node of a flow back to its path", () => {
    const flows = (graph?.nodes ?? []).filter((node) => node.kind === "flow");

    expect(
      flows.filter(
        (node) => !KNOWN_FLOW_PATHS.includes(flowPathOfNode(node.id) ?? ""),
      ),
    ).toEqual([]);
  });

  test("names every schedule node after a schedule of the repository", () => {
    const paths = REPO_SCHEDULES.map((schedule) => schedule.path);
    const schedules = (graph?.nodes ?? []).filter(
      (node) => node.kind === "schedule",
    );

    expect(
      schedules.filter(
        (node) =>
          !paths.includes(`f/factory/${node.id.replace(/^schedule:/, "")}`),
      ),
    ).toEqual([]);
  });
});
