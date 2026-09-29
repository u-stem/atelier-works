import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FLOW = readFileSync(
  join(import.meta.dir, "../../f/factory/implement__flow/flow.yaml"),
  "utf8",
);

/** The text of one module, from its `- id:` line to the next module or
 * the failure module. */
function moduleBlock(id: string): string {
  const start = FLOW.indexOf(`- id: ${id}\n`);
  const rest = FLOW.slice(start + 1);
  const next = rest.search(/\n\s+- id: |\n {2}failure_module:/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The input_transforms keys of one module, sorted. */
function inputKeys(id: string): string[] {
  return [...moduleBlock(id).matchAll(/^ {10}(\w+):$/gm)]
    .map((m) => m[1] ?? "")
    .sort();
}

describe("implement flow.yaml", () => {
  test("runs the four steps in order", () => {
    expect(
      [...FLOW.matchAll(/^\s+path: (f\/factory\/steps\/implement_\w+)$/gm)].map(
        (m) => m[1],
      ),
    ).toEqual([
      "f/factory/steps/implement_prepare",
      "f/factory/steps/implement_generate",
      "f/factory/steps/implement_verify",
      "f/factory/steps/implement_finish",
    ]);
  });

  test("records failures under the implement flow path", () => {
    expect(FLOW).toContain("value: f/factory/implement\n");
  });

  test("skips exactly generate and verify when prepare does not proceed", () => {
    expect(
      FLOW.split('expr: results.implement_prepare.outcome !== "proceed"')
        .length - 1,
    ).toBe(2);
  });

  test("never skips the finish step", () => {
    const start = FLOW.indexOf("- id: implement_finish");
    expect(FLOW.slice(start, FLOW.indexOf("failure_module:"))).not.toContain(
      "skip_if",
    );
  });

  test("routes failures to on_error_flow", () => {
    expect(FLOW).toContain("path: f/factory/on_error_flow");
  });

  test("passes the loop result only when prepare proceeded", () => {
    expect(moduleBlock("implement_finish")).toContain(
      "expr: 'results.implement_prepare.outcome === \"proceed\" ? results.implement_verify : null'",
    );
  });

  test("gives the finish step exactly its five inputs", () => {
    expect(inputKeys("implement_finish")).toEqual([
      "context",
      "loop_result",
      "prepare_outcome",
      "prepare_reason",
      "work_item_id",
    ]);
  });

  test("gives the verify step exactly its three inputs", () => {
    expect(inputKeys("implement_verify")).toEqual([
      "context",
      "first_round",
      "work_item_id",
    ]);
  });

  test("has no module-level retry", () => {
    expect(FLOW).not.toContain("retry:");
  });
});
