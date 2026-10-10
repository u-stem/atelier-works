// 各工程が、割り当て表(`lib/model_policy.ts`)の工程名でモデルを選ぶことを確かめる。
// 各ステップの`main`はWindmillのAPIを呼ぶため直接は動かさず、ソースの呼び出しを読む。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(relative: string): string {
  return readFileSync(
    join(import.meta.dir, "../../f/factory", relative),
    "utf8",
  );
}

describe("model assignment per stage", () => {
  test("pipeline_generate selects the requirements model", () => {
    expect(source("steps/pipeline_generate.ts")).toContain(
      'model: modelFor(config, "requirements", attempt)',
    );
  });

  test("pr_review_generate selects the pr_review model", () => {
    expect(source("steps/pr_review_generate.ts")).toContain(
      'model: modelFor(config, "pr_review", attempt)',
    );
  });

  test("audit_generate selects the audit model", () => {
    expect(source("steps/audit_generate.ts")).toContain(
      'model: modelFor(config, "audit", 1)',
    );
  });

  test("pr_fix_apply selects the pr_fix model by fix_round", () => {
    expect(source("steps/pr_fix_apply.ts")).toContain(
      'model: modelFor(config, "pr_fix", fix_round)',
    );
  });

  test("pr_fix_verify selects the pr_fix model by fix_round", () => {
    expect(source("steps/pr_fix_verify.ts")).toContain(
      'model: modelFor(config, "pr_fix", fix_round)',
    );
  });

  test("implement_loop selects the implement model by attempt", () => {
    expect(source("lib/implement_loop.ts")).toContain(
      'model: modelFor(input.config, "implement", input.attempt)',
    );
  });

  test("no step passes config.model to the model option directly", () => {
    const steps = [
      "steps/pipeline_generate.ts",
      "steps/pr_review_generate.ts",
      "steps/audit_generate.ts",
      "steps/pr_fix_apply.ts",
      "steps/pr_fix_verify.ts",
      "lib/implement_loop.ts",
    ];
    const direct = steps.filter((path) =>
      /model:\s*(input\.)?config\.model\b/.test(source(path)),
    );
    expect(direct).toEqual([]);
  });
});
