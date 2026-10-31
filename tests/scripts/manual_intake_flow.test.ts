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

describe("the intake key in the manual intake flow", () => {
  test("hands the intake key of the flow input to the create_issue step", () => {
    expect(transformOf(moduleById("create_issue"), "intake_key")).toEqual({
      type: "javascript",
      expr: "flow_input.intake_key",
    });
  });

  test("does not hand the intake key to the register step", () => {
    expect(transformOf(moduleById("register"), "intake_key")).toBeUndefined();
  });

  test("skips the register step for a reused issue", () => {
    expect(field(moduleById("register"), "skip_if")).toEqual({
      expr: "results.create_issue.reused === true",
    });
  });

  test("does not skip the create_issue step", () => {
    expect(field(moduleById("create_issue"), "skip_if")).toBeUndefined();
  });

  test("declares the intake key as a text input", () => {
    expect(
      field(field(field(FLOW, "schema"), "properties"), "intake_key"),
    ).toMatchObject({ type: "string" });
  });

  test("lists the intake key in the order of the inputs", () => {
    expect(field(field(FLOW, "schema"), "order")).toContain("intake_key");
  });

  test("does not require the intake key", () => {
    expect(field(field(FLOW, "schema"), "required")).not.toContain(
      "intake_key",
    );
  });
});

describe("the script definitions that take the intake key", () => {
  test.each([
    "f/factory/manual_intake_submit",
    "f/factory/steps/manual_intake_create_issue",
  ])("%s declares the intake key", (path) => {
    const meta = readYaml(join(ROOT, `${path}.script.yaml`));
    expect(Object.keys(schemaProperties(meta))).toContain("intake_key");
  });

  test.each([
    "f/factory/manual_intake_submit",
    "f/factory/steps/manual_intake_create_issue",
  ])("%s does not require the intake key", (path) => {
    const meta = readYaml(join(ROOT, `${path}.script.yaml`));
    expect(field(field(meta, "schema"), "required")).not.toContain(
      "intake_key",
    );
  });

  test("the register step does not take the intake key", () => {
    const meta = readYaml(
      join(ROOT, "f/factory/steps/manual_intake_register.script.yaml"),
    );
    expect(Object.keys(schemaProperties(meta))).not.toContain("intake_key");
  });
});
