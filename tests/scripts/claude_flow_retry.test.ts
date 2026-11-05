// Claudeを動かすmoduleの、Windmillの再試行の条件のテスト。
// timeout、予算の超過、使用上限では、stepが例外の文の先頭にタグを付ける。
// `retry_if`の式が偽になるので再試行は走らず、flowは失敗のまま`failure_module`へ進む。
// `retry:`の`constant`の書式は`pr_flows.test.ts`の正規表現も読む。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  flowFailureMessage,
  NO_FLOW_RETRY_MARKER,
} from "../../f/factory/lib/claude_flow_failure.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

/** flow.yamlを解析して、`id`のmoduleを返す。無ければ例外を投げる。 */
function moduleOf(flow: string, id: string): unknown {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(
      join(import.meta.dir, `../../f/factory/${flow}__flow/flow.yaml`),
      "utf8",
    ),
  );
  const modules = field(field(parsed, "value"), "modules");
  const found = Array.isArray(modules)
    ? modules.find((item: unknown) => field(item, "id") === id)
    : undefined;
  if (found === undefined) throw new Error(`module ${id} not found in ${flow}`);
  return found;
}

/** moduleの`retry.retry_if.expr`を返す。 */
function retryIfExpr(flow: string, id: string): unknown {
  return field(field(field(moduleOf(flow, id), "retry"), "retry_if"), "expr");
}

/** flowの名前と、Claudeを動かすmoduleの`id`。 */
const CLAUDE_MODULES: [string, string][] = [
  ["pipeline", "generate"],
  ["audit", "audit_generate"],
  ["pr_review", "pr_review_generate"],
  ["pr_fix", "pr_fix_apply"],
];

const RETRY_IF_EXPR =
  '!String(error?.message ?? "").startsWith("[no-flow-retry]")';

/** `retry_if`の式を、Windmillが渡す`error`で評価する。 */
function evaluateRetryIf(error: unknown): unknown {
  const evaluate = new Function("error", `return (${RETRY_IF_EXPR});`);
  return evaluate(error);
}

describe("the retry of the Claude modules", () => {
  test.each(CLAUDE_MODULES)("the %s flow gates the retry of %s", (flow, id) => {
    expect(retryIfExpr(flow, id)).toBe(RETRY_IF_EXPR);
  });

  test.each(CLAUDE_MODULES)("the %s flow keeps the retry of %s", (flow, id) => {
    expect(field(field(moduleOf(flow, id), "retry"), "constant")).toEqual({
      attempts: 2,
      seconds: 60,
    });
  });

  test.each(CLAUDE_MODULES)(
    "the %s flow does not stop after %s by its result",
    (flow, id) => {
      expect(field(moduleOf(flow, id), "stop_after_if")).toBeUndefined();
    },
  );
});

describe("the retry_if expression", () => {
  test("names the marker that the steps put on the message", () => {
    expect(RETRY_IF_EXPR).toContain(`"${NO_FLOW_RETRY_MARKER}"`);
  });

  test("is false for a failure that must not be retried", () => {
    const error = { message: flowFailureMessage("timeout", "step: failed") };

    expect(evaluateRetryIf(error)).toBe(false);
  });

  test("is true for a failure that may be retried", () => {
    const error = {
      message: flowFailureMessage("claude_error", "step: failed"),
    };

    expect(evaluateRetryIf(error)).toBe(true);
  });

  test("is true when the marker is not at the head of the message", () => {
    const error = { message: `step: ${NO_FLOW_RETRY_MARKER} failed` };

    expect(evaluateRetryIf(error)).toBe(true);
  });

  test("is true when the error has no message", () => {
    expect(evaluateRetryIf({})).toBe(true);
  });

  test("is true when there is no error", () => {
    expect(evaluateRetryIf(undefined)).toBe(true);
  });
});
