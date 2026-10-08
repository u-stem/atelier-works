// pr_fixとpr_reviewのflow.yamlが各ステップに付けるWindmillのtimeoutのテスト。
// 時間設定に左右されるステップの値は、`pr_workflow_support.ts`の定数と一致することを確かめる。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PR_FIX_APPLY_STEP_TIMEOUT_SEC,
  PR_FIX_VERIFY_STEP_TIMEOUT_SEC,
  PR_REVIEW_GENERATE_STEP_TIMEOUT_SEC,
} from "../../f/factory/steps/pr_workflow_support.ts";

function readFlow(name: string): string {
  return readFileSync(
    join(import.meta.dir, `../../f/factory/${name}__flow/flow.yaml`),
    "utf8",
  );
}

const PR_FIX_FLOW = readFlow("pr_fix");
const PR_REVIEW_FLOW = readFlow("pr_review");

/**
 * 1つのモジュールのテキストを返す。
 * 範囲は`- id:`の行から、次のモジュールか`failure_module`の手前まで。
 * モジュールが無ければ例外を投げる。先頭から切り出して別のモジュールの値を読まないため。
 */
function moduleBlock(flow: string, id: string): string {
  const start = flow.indexOf(`- id: ${id}\n`);
  if (start === -1) throw new Error(`module ${id} not found in flow.yaml`);
  const rest = flow.slice(start + 1);
  const next = rest.search(/\n\s+- id: |\n {2}failure_module:/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** モジュールのstatic timeout(秒)。無ければnull。 */
function moduleTimeoutSec(flow: string, id: string): number | null {
  const match = moduleBlock(flow, id).match(
    /^ {6}timeout:\n {8}type: static\n {8}value: (\d+)$/m,
  );
  return match?.[1] === undefined ? null : Number(match[1]);
}

describe("pr_fix flow.yaml", () => {
  test("bounds the prepare step at 1800 seconds", () => {
    expect(moduleTimeoutSec(PR_FIX_FLOW, "pr_fix_prepare")).toBe(1800);
  });

  test("bounds the collect step at 600 seconds", () => {
    expect(moduleTimeoutSec(PR_FIX_FLOW, "pr_fix_collect")).toBe(600);
  });

  test("bounds the apply step at PR_FIX_APPLY_STEP_TIMEOUT_SEC", () => {
    expect(moduleTimeoutSec(PR_FIX_FLOW, "pr_fix_apply")).toBe(
      PR_FIX_APPLY_STEP_TIMEOUT_SEC,
    );
  });

  test("bounds the verify step at PR_FIX_VERIFY_STEP_TIMEOUT_SEC", () => {
    expect(moduleTimeoutSec(PR_FIX_FLOW, "pr_fix_verify")).toBe(
      PR_FIX_VERIFY_STEP_TIMEOUT_SEC,
    );
  });

  test("bounds the finish step at 5400 seconds", () => {
    expect(moduleTimeoutSec(PR_FIX_FLOW, "pr_fix_finish")).toBe(5400);
  });

  test("puts no timeout on the failure module", () => {
    expect(
      PR_FIX_FLOW.slice(PR_FIX_FLOW.indexOf("failure_module:")),
    ).not.toContain("timeout:");
  });
});

describe("pr_review flow.yaml", () => {
  test("bounds the prepare step at 1800 seconds", () => {
    expect(moduleTimeoutSec(PR_REVIEW_FLOW, "pr_review_prepare")).toBe(1800);
  });

  test("bounds the generate step at PR_REVIEW_GENERATE_STEP_TIMEOUT_SEC", () => {
    expect(moduleTimeoutSec(PR_REVIEW_FLOW, "pr_review_generate")).toBe(
      PR_REVIEW_GENERATE_STEP_TIMEOUT_SEC,
    );
  });

  test("bounds the post step at 5400 seconds", () => {
    expect(moduleTimeoutSec(PR_REVIEW_FLOW, "pr_review_post")).toBe(5400);
  });

  test("puts no timeout on the failure module", () => {
    expect(
      PR_REVIEW_FLOW.slice(PR_REVIEW_FLOW.indexOf("failure_module:")),
    ).not.toContain("timeout:");
  });
});
