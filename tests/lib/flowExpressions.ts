// flow.yamlの式を、YAMLを読んで取り出し、与えた値で評価する。
// 体裁(字下げ、折り返し)に依らず、式が何を渡すかを確かめるために使う。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function modulesIn(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const nested = Object.values(value).flatMap(modulesIn);
  const isModule =
    typeof field(value, "id") === "string" &&
    field(value, "value") !== undefined;
  return isModule ? [value, ...nested] : nested;
}

/** flowの`input_transforms`の式を返す。無ければ例外を投げる。 */
export function transformExpression(
  flow: string,
  stepId: string,
  arg: string,
): string {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(join(FACTORY_DIR, `${flow}__flow`, "flow.yaml"), "utf8"),
  );
  const module = modulesIn(parsed).find(
    (candidate) => field(candidate, "id") === stepId,
  );
  const expr = field(
    field(field(field(module, "value"), "input_transforms"), arg),
    "expr",
  );
  if (typeof expr !== "string") {
    throw new Error(`no expression for ${flow}/${stepId}/${arg}`);
  }
  return expr;
}

/** 式を、`results`と`flow_input`を与えて評価する。 */
export function evaluateTransform(
  flow: string,
  stepId: string,
  arg: string,
  scope: { readonly results?: unknown; readonly flow_input?: unknown } = {},
): unknown {
  const run = new Function(
    "results",
    "flow_input",
    `return (${transformExpression(flow, stepId, arg)});`,
  );
  return run(scope.results ?? {}, scope.flow_input ?? {});
}

/** 包んだ引数を評価して、JSONとして戻す。 */
export function evaluateSealed(
  flow: string,
  stepId: string,
  scope: { readonly results?: unknown; readonly flow_input?: unknown } = {},
  arg = "untrusted",
): unknown {
  const text = evaluateTransform(flow, stepId, arg, scope);
  if (typeof text !== "string") throw new Error("the sealed value is not text");
  return JSON.parse(text);
}
