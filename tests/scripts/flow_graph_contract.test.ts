// 起動関係の図のデータ(console/src/generated/flow-graph.json)が、
// Consoleの検査とdraw.ioのXMLの検査を通ることを確かめる契約テスト。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlowGraph } from "../../console/src/lib/flowGraph.ts";
import { flowGraphToDrawioXml } from "../../console/src/lib/flowGraphXml.ts";
import { validateDrawioXml } from "../../f/factory/lib/drawio.ts";
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

  test("draws as a draw.io document the factory accepts", () => {
    const xml = graph === null ? "" : flowGraphToDrawioXml(graph);

    expect(validateDrawioXml(xml)).toEqual({ valid: true });
  });
});
