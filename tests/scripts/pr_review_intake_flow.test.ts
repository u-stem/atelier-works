// PRレビューの投入のフロー(`pr_review_intake__flow/flow.yaml`)の結線のテスト。
// フローは作業項目を持たない段階で動くので、入力は投入するPRだけで、失敗ハンドラは置かない。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../f/factory/lib/types.ts";

const ROOT = join(import.meta.dir, "../..");

function readYaml(path: string): unknown {
  return Bun.YAML.parse(readFileSync(join(ROOT, path), "utf8"));
}

function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new Error(`not a mapping at ${key}`);
  return value[key];
}

const FLOW = readYaml("f/factory/pr_review_intake__flow/flow.yaml");

function modules(): unknown[] {
  const list = field(field(FLOW, "value"), "modules");
  if (!Array.isArray(list)) throw new Error("modules is not a list");
  return list;
}

describe("the flow of the pull request review intake", () => {
  test("has one step", () => {
    expect(modules()).toHaveLength(1);
  });

  test("runs the register step", () => {
    expect(field(field(modules()[0], "value"), "path")).toBe(
      "f/factory/steps/pr_review_intake_register",
    );
  });

  test.each(["owner", "repo", "pr_number"])(
    "hands the flow input %s to the step as it is",
    (name) => {
      const transforms = field(
        field(modules()[0], "value"),
        "input_transforms",
      );
      expect(field(transforms, name)).toEqual({
        type: "javascript",
        expr: `flow_input.${name}`,
      });
    },
  );

  test("hands the step nothing but the pull request", () => {
    const transforms = field(field(modules()[0], "value"), "input_transforms");
    expect(Object.keys(isRecord(transforms) ? transforms : {}).sort()).toEqual([
      "owner",
      "pr_number",
      "repo",
    ]);
  });

  test("takes the pull request as its input", () => {
    const properties = field(field(FLOW, "schema"), "properties");
    expect(Object.keys(isRecord(properties) ? properties : {}).sort()).toEqual([
      "owner",
      "pr_number",
      "repo",
    ]);
  });

  test("declares the pull request number as an integer", () => {
    const properties = field(field(FLOW, "schema"), "properties");
    expect(field(field(properties, "pr_number"), "type")).toBe("integer");
  });

  test("requires all three inputs", () => {
    const required = field(field(FLOW, "schema"), "required");
    expect(Array.isArray(required) ? [...required].sort() : []).toEqual([
      "owner",
      "pr_number",
      "repo",
    ]);
  });

  test("has no failure handler, because no work item exists yet", () => {
    expect(field(field(FLOW, "value"), "failure_module")).toBeUndefined();
  });
});

describe("the register step definition", () => {
  const meta = readYaml(
    "f/factory/steps/pr_review_intake_register.script.yaml",
  );

  test("takes the pull request", () => {
    const properties = field(field(meta, "schema"), "properties");
    expect(Object.keys(isRecord(properties) ? properties : {}).sort()).toEqual([
      "owner",
      "pr_number",
      "repo",
    ]);
  });

  test("runs on a worker that can read GitHub, not on the console worker", () => {
    expect(field(meta, "tag")).toBeUndefined();
  });
});
