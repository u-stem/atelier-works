// 調査のフロー(`investigate__flow/flow.yaml`)と4つのstepの結線を固定する。
// 保護パスに置く。フローにinline scriptを混ぜたり、生成のstepの実行条件を変えたり、
// stepがClaudeの起動を直接呼んだりする変更が、このテストを書き換えて通らないようにするため。
//
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。
// 追えない形がある。識別子を連結や別名で組み立てる参照は数えられない。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INVESTIGATE_GENERATE_STEP_TIMEOUT_SEC } from "../../f/factory/lib/investigate_flow.ts";
import { isRecord } from "../../f/factory/lib/types.ts";

const ROOT = join(import.meta.dir, "../..");
const transpiler = new Bun.Transpiler({ loader: "ts" });

const STEPS = [
  "investigate_register",
  "investigate_prepare",
  "investigate_generate",
  "investigate_post",
] as const;

function readYaml(path: string): unknown {
  return Bun.YAML.parse(readFileSync(join(ROOT, path), "utf8"));
}

function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new Error(`not a mapping at ${key}`);
  return value[key];
}

function codeOf(path: string): string {
  return transpiler.transformSync(readFileSync(join(ROOT, path), "utf8"));
}

const FLOW = readYaml("f/factory/investigate__flow/flow.yaml");

function modules(): unknown[] {
  const list = field(field(FLOW, "value"), "modules");
  if (!Array.isArray(list)) throw new Error("modules is not a list");
  return list;
}

describe("the modules of the investigate flow", () => {
  test("are the four steps, in order", () => {
    expect(modules().map((m) => field(field(m, "value"), "path"))).toEqual(
      STEPS.map((step) => `f/factory/steps/${step}`),
    );
  });

  test("are all scripts by path, with no inline script", () => {
    for (const module of modules()) {
      const value = field(module, "value");
      expect(field(value, "type")).toBe("script");
      expect(isRecord(value) && "content" in value).toBe(false);
      expect(isRecord(value) && "language" in value).toBe(false);
    }
  });

  test("all have a path under steps/investigate_", () => {
    for (const module of modules()) {
      const path = String(field(field(module, "value"), "path"));
      expect(path.startsWith("f/factory/steps/investigate_")).toBe(true);
    }
  });

  test("retry nowhere, because a retry would clear the place and run again", () => {
    for (const module of modules()) {
      expect(isRecord(module) && "retry" in module).toBe(false);
    }
  });

  test("give the generate step the timeout of the constant", () => {
    const generate = modules()[2];
    expect(field(field(generate, "timeout"), "value")).toBe(
      INVESTIGATE_GENERATE_STEP_TIMEOUT_SEC,
    );
  });

  test("skip the later steps when the register step refused", () => {
    for (const index of [1, 2, 3]) {
      const expr = String(field(field(modules()[index], "skip_if"), "expr"));
      expect(expr).toContain("results.investigate_register.skip === true");
    }
  });

  test("skip the generate step when the prepare step skipped", () => {
    const expr = String(field(field(modules()[2], "skip_if"), "expr"));
    expect(expr).toContain("results.investigate_prepare?.skip === true");
  });

  test("skip the post step when the generate step skipped", () => {
    const expr = String(field(field(modules()[3], "skip_if"), "expr"));
    expect(expr).toContain("results.investigate_prepare?.skip === true");
    expect(expr).toContain("results.investigate_generate?.skip === true");
  });
});

describe("the failure module of the investigate flow", () => {
  const failure = field(field(FLOW, "value"), "failure_module");
  const transforms = field(field(failure, "value"), "input_transforms");

  test("runs the failure handler", () => {
    expect(field(field(failure, "value"), "path")).toBe(
      "f/factory/on_error_flow",
    );
  });

  test("names the flow path", () => {
    expect(field(field(transforms, "path"), "value")).toBe(
      "f/factory/investigate",
    );
  });

  test("hands over the error and the path only, because the flow has no work item id", () => {
    expect(Object.keys(isRecord(transforms) ? transforms : {}).sort()).toEqual([
      "error",
      "path",
    ]);
  });
});

describe("the input of the investigate flow", () => {
  const schema = field(FLOW, "schema");
  const properties = field(schema, "properties");

  test("takes the repository, the issue and the request", () => {
    expect(Object.keys(isRecord(properties) ? properties : {}).sort()).toEqual([
      "issue_number",
      "owner",
      "repo",
      "request",
    ]);
  });

  test("declares the issue number as an integer", () => {
    expect(field(field(properties, "issue_number"), "type")).toBe("integer");
  });

  test("requires all four", () => {
    const required = field(schema, "required");
    expect(Array.isArray(required) ? [...required].sort() : []).toEqual([
      "issue_number",
      "owner",
      "repo",
      "request",
    ]);
  });

  test("hands the flow input to the register step as it is", () => {
    const transforms = field(field(modules()[0], "value"), "input_transforms");
    for (const name of ["owner", "repo", "issue_number", "request"]) {
      expect(field(transforms, name)).toEqual({
        type: "javascript",
        expr: `flow_input.${name}`,
      });
    }
  });
});

describe("the definitions of the steps", () => {
  test.each([...STEPS])(
    "%s has no tag, so the default worker runs it",
    (step) => {
      const yaml = readYaml(`f/factory/steps/${step}.script.yaml`);
      expect(isRecord(yaml) && "tag" in yaml).toBe(false);
    },
  );

  test.each([...STEPS])("%s is not a native script", (step) => {
    const source = readFileSync(
      join(ROOT, `f/factory/steps/${step}.ts`),
      "utf8",
    );
    expect(source.startsWith("//native")).toBe(false);
  });
});

describe("the files of the steps", () => {
  const CALL = /(?<![\w$])runClaude(?![\w$])/g;

  test.each([...STEPS])("%s does not name the plain Claude runner", (step) => {
    expect([
      ...codeOf(`f/factory/steps/${step}.ts`).matchAll(CALL),
    ]).toHaveLength(0);
  });

  test("the library of the flow does not name the plain Claude runner either", () => {
    expect([
      ...codeOf("f/factory/lib/investigate_flow.ts").matchAll(CALL),
    ]).toHaveLength(0);
  });

  test("counts a call of the plain Claude runner", () => {
    const code = transpiler.transformSync(
      'import { runClaude } from "../lib/claude.ts"; await runClaude({});',
    );
    expect([...code.matchAll(CALL)]).toHaveLength(2);
  });

  test("does not count the wrapper that is allowed", () => {
    const code = transpiler.transformSync("const x = runInvestigateClaude;");
    expect([...code.matchAll(CALL)]).toHaveLength(0);
  });
});

describe("the modules that the generate step imports", () => {
  const code = codeOf("f/factory/steps/investigate_generate.ts");
  const imports = transpiler
    .scanImports(code)
    .map((entry) => entry.path)
    .filter((path) => path.startsWith("."))
    .sort();

  test("are the fixed set", () => {
    expect(imports).toEqual([
      "../lib/claude.ts",
      "../lib/config.ts",
      "../lib/db.ts",
      "../lib/discord.ts",
      "../lib/implement_launch_support.ts",
      "../lib/investigate_claude.ts",
      "../lib/investigate_flow.ts",
      "../lib/investigate_isolation_gate.ts",
      "../lib/investigate_workspace.ts",
      "../lib/log.ts",
      "../lib/model_policy.ts",
      "../lib/workspace.ts",
    ]);
  });
});
