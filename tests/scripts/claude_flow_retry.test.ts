// Claudeを動かすmoduleの、Windmillの再試行の条件のテスト。
// timeout、実行ごとの予算の超過、使用上限、全停止では、stepが例外の文の先頭にタグを付ける。
// `retry_if`の式が偽になるので再試行は走らず、flowは失敗のまま`failure_module`へ進む。
// `retry:`の`constant`の書式は`pr_flows.test.ts`の正規表現も読む。
// 対象は手で並べず、すべてのflow.yamlから、再試行を持ちClaudeを動かすmoduleを探す。
// flowを足したときに`retry_if`を付け忘れても、ここで落ちるようにするためである。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  flowFailureMessage,
  NO_FLOW_RETRY_MARKER,
} from "../../f/factory/lib/flow_retry_marker.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const FACTORY_DIR = join(REPO_ROOT, "f/factory");
const CLAUDE_LIB = join(FACTORY_DIR, "lib/claude.ts");
const FLOW_DIR_SUFFIX = "__flow";

const transpiler = new Bun.Transpiler({ loader: "ts" });

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

/** `value`の中のmoduleを、branchやループの入れ子と`failure_module`も含めて、すべて返す。 */
function modulesIn(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const nested = Object.values(value).flatMap(modulesIn);
  const isModule =
    typeof field(value, "id") === "string" &&
    field(value, "value") !== undefined;
  return isModule ? [value, ...nested] : nested;
}

/** `file`が、相対importをたどって`lib/claude.ts`に届くかを返す。型だけのimportはたどらない。 */
function reachesClaude(file: string, seen: Set<string>): boolean {
  if (file === CLAUDE_LIB) return true;
  if (seen.has(file)) return false;
  seen.add(file);
  return transpiler
    .scanImports(readFileSync(file, "utf8"))
    .filter((entry) => entry.path.startsWith("."))
    .some((entry) => reachesClaude(resolve(dirname(file), entry.path), seen));
}

/** moduleが呼ぶscriptのファイルを返す。パスで呼ばないmoduleはnullを返す。 */
function scriptFileOf(module: unknown): string | null {
  const path = field(field(module, "value"), "path");
  return typeof path === "string" ? join(REPO_ROOT, `${path}.ts`) : null;
}

type FlowModule = { readonly flow: string; readonly module: unknown };

/** すべてのflowの、再試行を持つmodule。 */
const RETRYING_MODULES: FlowModule[] = readdirSync(FACTORY_DIR)
  .filter((name) => name.endsWith(FLOW_DIR_SUFFIX))
  .flatMap((dir) => {
    const parsed: unknown = Bun.YAML.parse(
      readFileSync(join(FACTORY_DIR, dir, "flow.yaml"), "utf8"),
    );
    const flow = dir.slice(0, -FLOW_DIR_SUFFIX.length);
    return modulesIn(parsed).map((module) => ({ flow, module }));
  })
  .filter(({ module }) => field(module, "retry") !== undefined);

/** 再試行を持ち、Claudeを動かすmodule。`[flowの名前, moduleのid, module]`の形にする。 */
const CLAUDE_MODULES: [string, unknown, unknown][] = RETRYING_MODULES.filter(
  ({ module }) => {
    const file = scriptFileOf(module);
    return file !== null && reachesClaude(file, new Set());
  },
).map(({ flow, module }) => [flow, field(module, "id"), module]);

const RETRY_IF_EXPR =
  '!String(error?.message ?? "").startsWith("[no-flow-retry]")';

/** `retry_if`の式を、Windmillが渡す`error`で評価する。 */
function evaluateRetryIf(error: unknown): unknown {
  const evaluate = new Function("error", `return (${RETRY_IF_EXPR});`);
  return evaluate(error);
}

describe("the scan of the flows", () => {
  test.each([
    ["pipeline", "generate"],
    ["audit", "audit_generate"],
    ["pr_review", "pr_review_generate"],
    ["pr_fix", "pr_fix_apply"],
  ])("finds the Claude module of the %s flow", (flow, id) => {
    expect(CLAUDE_MODULES.map(([name, found]) => [name, found])).toContainEqual(
      [flow, id],
    );
  });

  test("does not take a type-only import for a run of Claude", () => {
    expect(
      transpiler
        .scanImports('import type { A } from "./claude.ts";')
        .map((entry) => entry.path),
    ).toEqual([]);
  });
});

describe("the retry of the Claude modules", () => {
  test.each(CLAUDE_MODULES)(
    "the %s flow gates the retry of %s",
    (_f, _i, m) => {
      expect(field(field(m, "retry"), "retry_if")).toEqual({
        expr: RETRY_IF_EXPR,
      });
    },
  );

  test.each(CLAUDE_MODULES)(
    "the %s flow keeps the retry of %s",
    (_f, _i, m) => {
      expect(field(field(m, "retry"), "constant")).toEqual({
        attempts: 2,
        seconds: 60,
      });
    },
  );

  test.each(CLAUDE_MODULES)(
    "the %s flow does not stop after %s by its result",
    (_f, _i, m) => {
      expect(field(m, "stop_after_if")).toBeUndefined();
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
