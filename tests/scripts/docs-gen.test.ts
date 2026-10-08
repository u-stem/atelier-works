import { describe, expect, test } from "bun:test";
import {
  compareTaskNames,
  renderAssets,
  renderSchedules,
  replaceGeneratedBlocks,
  taskNamesInTable,
} from "../../scripts/docs-gen.ts";

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
