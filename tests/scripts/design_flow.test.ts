// 設計フローのflow.yamlの結線のテスト。
// ステップの順と引数、飛ばす条件、`design_generate`に`retry`が無いこと、タグが無いこと、
// 失敗の扱い(`failure_module`のpathが`DESIGN_FLOW_PATH`と一致すること)を確かめる。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { designFlowInput } from "../../f/factory/lib/design_launch_support.ts";
import { DESIGN_FLOW_PATH } from "../../f/factory/lib/pipeline_lease.ts";
import { isRecord } from "../../f/factory/lib/types.ts";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
const FLOW_TEXT = readFileSync(
  join(FACTORY_DIR, "design__flow/flow.yaml"),
  "utf8",
);
const FLOW: unknown = Bun.YAML.parse(FLOW_TEXT);

function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new Error(`not a mapping at ${key}`);
  return value[key];
}

function modules(): unknown[] {
  const list = field(field(FLOW, "value"), "modules");
  if (!Array.isArray(list)) throw new Error("modules is not a list");
  return list;
}

function moduleById(id: string): unknown {
  const found = modules().find((module) => field(module, "id") === id);
  if (found === undefined) throw new Error(`module ${id} not found`);
  return found;
}

function scriptPath(module: unknown): unknown {
  return field(field(module, "value"), "path");
}

/** モジュールの`input_transforms`を、引数名から式(javascript)か値(static)への対応にして返す。 */
function inputs(module: unknown): Record<string, unknown> {
  const transforms = field(field(module, "value"), "input_transforms");
  if (!isRecord(transforms)) throw new Error("input_transforms is not a map");
  const result: Record<string, unknown> = {};
  for (const [name, transform] of Object.entries(transforms)) {
    const type = field(transform, "type");
    result[name] =
      type === "javascript"
        ? field(transform, "expr")
        : field(transform, "value");
  }
  return result;
}

/** ステップのスクリプトのメタデータ(`*.script.yaml`)が宣言する引数の名前を返す。 */
function declaredArguments(path: unknown): string[] {
  if (typeof path !== "string") throw new Error("path is not a string");
  const meta: unknown = Bun.YAML.parse(
    readFileSync(join(FACTORY_DIR, "..", "..", `${path}.script.yaml`), "utf8"),
  );
  const properties = field(field(meta, "schema"), "properties");
  if (!isRecord(properties)) throw new Error("properties is not a map");
  return Object.keys(properties).sort();
}

describe("the design flow", () => {
  test("runs prepare, generate and request_approval in this order", () => {
    expect(modules().map((module) => field(module, "id"))).toEqual([
      "prepare",
      "generate",
      "request_approval",
    ]);
  });

  test("runs the three design steps", () => {
    expect(modules().map(scriptPath)).toEqual([
      "f/factory/steps/design_prepare",
      "f/factory/steps/design_generate",
      "f/factory/steps/design_request_approval",
    ]);
  });

  test("has no retry on any module", () => {
    expect(FLOW_TEXT).not.toContain("retry:");
  });

  test("has no retry on the generate step", () => {
    expect(field(moduleById("generate"), "retry")).toBeUndefined();
  });

  test("puts no tag on the flow", () => {
    expect(field(FLOW, "tag")).toBeUndefined();
  });

  test("puts no tag on any module", () => {
    expect(FLOW_TEXT).not.toMatch(/^\s*tag:/m);
  });

  test("never skips the prepare step", () => {
    expect(field(moduleById("prepare"), "skip_if")).toBeUndefined();
  });

  test("skips the generate step when prepare does not proceed", () => {
    expect(field(field(moduleById("generate"), "skip_if"), "expr")).toBe(
      "results.prepare.skip === true",
    );
  });

  test("skips the approval request unless the draft was saved", () => {
    expect(
      field(field(moduleById("request_approval"), "skip_if"), "expr"),
    ).toBe(
      'results.prepare.skip === true || results.generate == null || results.generate.outcome !== "success"',
    );
  });

  test("passes the work item and the design attempt to prepare", () => {
    expect(inputs(moduleById("prepare"))).toEqual({
      work_item_id: "flow_input.work_item_id",
      design_attempt: "flow_input.design_attempt",
    });
  });

  test("passes the inputs and the prepared worktree to generate", () => {
    expect(inputs(moduleById("generate"))).toEqual({
      work_item_id: "flow_input.work_item_id",
      design_attempt: "flow_input.design_attempt",
      feedback: "flow_input.feedback",
      worktree_dir: "results.prepare.worktree_dir",
      head_sha: "results.prepare.head_sha",
    });
  });

  test("passes the work item and the design attempt to the approval request", () => {
    expect(inputs(moduleById("request_approval"))).toEqual({
      work_item_id: "flow_input.work_item_id",
      design_attempt: "flow_input.design_attempt",
    });
  });

  test.each(["prepare", "generate", "request_approval"])(
    "gives the %s step exactly the arguments that its script declares",
    (id) => {
      const module = moduleById(id);
      expect(Object.keys(inputs(module)).sort()).toEqual(
        declaredArguments(scriptPath(module)),
      );
    },
  );

  test("reports failures to on_error_flow", () => {
    expect(scriptPath(field(field(FLOW, "value"), "failure_module"))).toBe(
      "f/factory/on_error_flow",
    );
  });

  test("reports the design flow path as the failing flow", () => {
    const failure = field(field(FLOW, "value"), "failure_module");
    expect(inputs(failure).path).toBe(DESIGN_FLOW_PATH);
  });

  test("passes the work item to the failure handler", () => {
    const failure = field(field(FLOW, "value"), "failure_module");
    expect(inputs(failure).work_item_id).toBe("flow_input.work_item_id");
  });

  test("passes the error to the failure handler", () => {
    const failure = field(field(FLOW, "value"), "failure_module");
    expect(inputs(failure).error).toBe("error");
  });

  test("takes exactly the inputs that the launcher sends", () => {
    const properties = field(field(FLOW, "schema"), "properties");
    expect(isRecord(properties) ? Object.keys(properties).sort() : []).toEqual(
      Object.keys(designFlowInput({ id: 1, design_attempt: 0 })).sort(),
    );
  });

  test("requires only the work item id", () => {
    expect(field(field(FLOW, "schema"), "required")).toEqual(["work_item_id"]);
  });

  test("starts the design attempts at one", () => {
    const properties = field(field(FLOW, "schema"), "properties");
    expect(field(field(properties, "design_attempt"), "default")).toBe(1);
  });
});
