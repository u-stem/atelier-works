// 手動投入のフロー(`manual_intake__flow/flow.yaml`)が、進め方(profile)を2つのステップへ渡す結線のテスト。
// 進め方の検査は、Issueを作るステップと登録のステップの両方が持つ。どちらも入力を受け取れなければ検査できない。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../f/factory/lib/types.ts";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
const ROOT = join(import.meta.dir, "../..");

function readYaml(path: string): unknown {
  return Bun.YAML.parse(readFileSync(path, "utf8"));
}

function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new Error(`not a mapping at ${key}`);
  return value[key];
}

const FLOW = readYaml(join(FACTORY_DIR, "manual_intake__flow/flow.yaml"));

function moduleById(id: string): unknown {
  const list = field(field(FLOW, "value"), "modules");
  if (!Array.isArray(list)) throw new Error("modules is not a list");
  const found = list.find((module) => field(module, "id") === id);
  if (found === undefined) throw new Error(`module ${id} not found`);
  return found;
}

function transformOf(module: unknown, name: string): unknown {
  return field(field(field(module, "value"), "input_transforms"), name);
}

function schemaProperties(meta: unknown): Record<string, unknown> {
  const properties = field(field(meta, "schema"), "properties");
  if (!isRecord(properties)) throw new Error("properties is not a mapping");
  return properties;
}

describe("the profile in the manual intake flow", () => {
  test.each(["create_issue", "register"])(
    "hands the profile of the flow input to the %s step",
    (id) => {
      expect(transformOf(moduleById(id), "profile")).toEqual({
        type: "javascript",
        expr: "flow_input.profile",
      });
    },
  );

  test("declares the profile as an input that defaults to standard", () => {
    expect(
      field(field(field(FLOW, "schema"), "properties"), "profile"),
    ).toMatchObject({ default: "standard" });
  });

  test("does not require the profile", () => {
    expect(field(field(FLOW, "schema"), "required")).not.toContain("profile");
  });
});

describe("the script definitions that take the profile", () => {
  test.each([
    "f/factory/manual_intake_submit",
    "f/factory/steps/manual_intake_create_issue",
    "f/factory/steps/manual_intake_register",
  ])("%s declares the profile", (path) => {
    const meta = readYaml(join(ROOT, `${path}.script.yaml`));
    expect(Object.keys(schemaProperties(meta))).toContain("profile");
  });

  test.each([
    "f/factory/manual_intake_submit",
    "f/factory/steps/manual_intake_create_issue",
    "f/factory/steps/manual_intake_register",
  ])("%s does not require the profile", (path) => {
    const meta = readYaml(join(ROOT, `${path}.script.yaml`));
    expect(field(field(meta, "schema"), "required")).not.toContain("profile");
  });
});
