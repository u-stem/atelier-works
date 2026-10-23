import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  compareTaskNames,
  FLOW_GRAPH_FILE,
  flowGraphProblem,
  renderAssets,
  renderFlowGraphFile,
  renderFlows,
  renderSchedules,
  replaceGeneratedBlocks,
  taskNamesInTable,
} from "../../scripts/docs-gen.ts";
import type { LaunchEdge } from "../../scripts/launch-graph.ts";

describe("replaceGeneratedBlocks", () => {
  test("replaces only the content between the markers", () => {
    const markdown =
      "前\n<!-- generated:schedules -->\n古い\n<!-- /generated:schedules -->\n後\n";

    const result = replaceGeneratedBlocks(markdown, () => "新しい");

    expect(result).toBe(
      "前\n<!-- generated:schedules -->\n新しい\n<!-- /generated:schedules -->\n後\n",
    );
  });

  test("throws for an unknown block name", () => {
    const markdown =
      "<!-- generated:unknown -->\n<!-- /generated:unknown -->\n";

    expect(() => replaceGeneratedBlocks(markdown, () => null)).toThrow(
      "unknown generated block: unknown",
    );
  });
});

describe("renderSchedules", () => {
  test("renders one row per schedule with the cron in code", () => {
    const table = renderSchedules([
      {
        name: "poll_issues",
        summary: "[SF-1-1] 巡回",
        cron: "0 */5 * * * *",
        target: "f/factory/poll_issues",
        description: "5分ごとに実行します。",
      },
    ]);

    expect(table.split("\n")[2]).toBe(
      "| poll_issues | `0 */5 * * * *` | `f/factory/poll_issues` | 5分ごとに実行します。 |",
    );
  });
});

describe("renderAssets", () => {
  test("sorts the rows by summary", () => {
    const table = renderAssets([
      { path: "f/factory/b", kind: "script", summary: "[SYS-1] b" },
      { path: "f/factory/a", kind: "flow", summary: "[SF-1-1] a" },
    ]);

    expect(table.split("\n")[2]).toBe("| `f/factory/a` | flow | [SF-1-1] a |");
  });
});

describe("renderFlows", () => {
  const label = (edge: LaunchEdge): string => `\`${edge.from}\``;
  const pipeline = {
    name: "pipeline",
    summary: "[SF-2-1] 要件定義の生成と承認",
  };

  test("renders one row per flow with the summary after its id prefix", () => {
    const edges: LaunchEdge[] = [
      { from: "poll_issues", to: "pipeline", kind: "script" },
    ];

    const table = renderFlows([pipeline], edges, label);

    expect(table.split("\n")[2]).toBe(
      "| `pipeline` | `poll_issues` | 要件定義の生成と承認 |",
    );
  });

  test("lists every origin of a flow in order", () => {
    const edges: LaunchEdge[] = [
      { from: "retry_work_item", to: "pipeline", kind: "script" },
      { from: "poll_issues", to: "pipeline", kind: "script" },
    ];

    const table = renderFlows([pipeline], edges, label);

    expect(table.split("\n")[2]).toBe(
      "| `pipeline` | `poll_issues`、`retry_work_item` | 要件定義の生成と承認 |",
    );
  });

  test("ignores edges that target another flow", () => {
    const edges: LaunchEdge[] = [
      { from: "poll_issues", to: "pipeline", kind: "script" },
      { from: "poll_prs", to: "pr_review", kind: "script" },
    ];

    const table = renderFlows([pipeline], edges, label);

    expect(table.split("\n")[2]).toBe(
      "| `pipeline` | `poll_issues` | 要件定義の生成と承認 |",
    );
  });

  test("shows that a flow has no origin", () => {
    const table = renderFlows([pipeline], [], label);

    expect(table.split("\n")[2]).toBe(
      "| `pipeline` | なし | 要件定義の生成と承認 |",
    );
  });

  test("keeps a summary without an id prefix as it is", () => {
    const table = renderFlows(
      [{ name: "audit", summary: "監査" }],
      [{ from: "audit_kickoff", to: "audit", kind: "script" }],
      label,
    );

    expect(table.split("\n")[2]).toBe("| `audit` | `audit_kickoff` | 監査 |");
  });

  test("sorts the rows by summary", () => {
    const table = renderFlows(
      [
        { name: "pr_fix", summary: "[SF-3-2] 修正" },
        { name: "pipeline", summary: "[SF-2-1] 生成" },
      ],
      [],
      label,
    );

    expect(table.split("\n")[2]).toBe("| `pipeline` | なし | 生成 |");
  });
});

describe("taskNamesInTable", () => {
  test("reads task names from the rows of the task table", () => {
    const names = taskNamesInTable(
      "| タスク | 内容 |\n| --- | --- |\n| `mise run up` | 起動する |\n| `mise run lint:docs` | 文書を検査する |\n",
    );

    expect(names).toEqual(["up", "lint:docs"]);
  });
});

describe("compareTaskNames", () => {
  test("reports tasks missing from the table and rows for unknown tasks", () => {
    const problems = compareTaskNames(["up", "down"], ["up", "gone"]);

    expect(problems).toEqual([
      'README.md: task "down" is missing from the table',
      'README.md: task "gone" is not in mise.toml',
    ]);
  });
});

describe("flowGraphProblem", () => {
  test("reports a missing file", () => {
    expect(flowGraphProblem(null, "{}\n")).toContain("is missing");
  });

  test("reports a file that differs from the expected content", () => {
    expect(flowGraphProblem("{ }\n", "{}\n")).toContain("is stale");
  });

  test("accepts a file that matches the expected content", () => {
    expect(flowGraphProblem("{}\n", "{}\n")).toBeNull();
  });
});

describe("the committed flow graph", () => {
  test("is the same as the one built from the repository", () => {
    expect(readFileSync(FLOW_GRAPH_FILE, "utf8")).toBe(renderFlowGraphFile());
  });
});
