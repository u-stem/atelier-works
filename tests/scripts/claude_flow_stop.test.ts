// Claudeを動かすmoduleが`outcome: "failed"`を返したとき、flowをそこで止める設定のテスト。
// 再試行しないClaudeの失敗では、stepが終端の処理をして値を返すので、下流のstepを走らせない。
// `retry:`の書式は`pr_flows.test.ts`の正規表現も読むので、ここでは残っていることだけを確かめる。
// stepが終端の処理に渡すflowのパスは、`failure_module`が渡すパスと同じでなければならない。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIPELINE_FLOW_PATH } from "../../f/factory/lib/pipeline_lease.ts";
import { AUDIT_FLOW_PATH } from "../../f/factory/steps/audit_generate.ts";

function readFlow(name: string): string {
  return readFileSync(
    join(import.meta.dir, `../../f/factory/${name}__flow/flow.yaml`),
    "utf8",
  );
}

/**
 * 1つのmoduleのテキストを返す。
 * 範囲は`- id:`の行から、次のmoduleか`failure_module`の手前まで。無ければ例外を投げる。
 */
function moduleBlock(flow: string, id: string): string {
  const start = flow.indexOf(`- id: ${id}\n`);
  if (start === -1) throw new Error(`module ${id} not found in flow.yaml`);
  const rest = flow.slice(start + 1);
  const next = rest.search(/\n\s+- id: |\n {2}failure_module:/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** `failure_module`から後ろのテキスト。 */
function failureBlock(flow: string): string {
  return flow.slice(flow.indexOf("  failure_module:\n"));
}

const STOP_ON_FAILED =
  '      stop_after_if:\n        expr: result?.outcome === "failed"\n        skip_if_stopped: false\n';

const RETRY_CONSTANT =
  /^ {6}retry:\n {8}constant:\n {10}attempts: 2\n {10}seconds: 60$/m;

/** flowの名前、Claudeを動かすmoduleの`id`、stepが終端の処理に渡すflowのパス。 */
const CLAUDE_MODULES: [string, string, string][] = [
  ["pipeline", "generate", PIPELINE_FLOW_PATH],
  ["audit", "audit_generate", AUDIT_FLOW_PATH],
];

describe("Claude modules stop the flow on a failed outcome", () => {
  test.each(CLAUDE_MODULES)(
    "the %s flow stops after %s returns failed",
    (flow, id) => {
      expect(moduleBlock(readFlow(flow), id)).toContain(STOP_ON_FAILED);
    },
  );

  test.each(CLAUDE_MODULES)("the %s flow keeps the retry of %s", (flow, id) => {
    expect(moduleBlock(readFlow(flow), id)).toMatch(RETRY_CONSTANT);
  });

  test.each(CLAUDE_MODULES)(
    "the failure module of the %s flow passes the path that %s settles with",
    (flow, _id, path) => {
      expect(failureBlock(readFlow(flow))).toContain(
        `          value: ${path}\n`,
      );
    },
  );
});
