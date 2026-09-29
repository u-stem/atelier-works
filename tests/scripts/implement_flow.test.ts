import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FLOW = readFileSync(
  join(import.meta.dir, "../../f/factory/implement__flow/flow.yaml"),
  "utf8",
);

describe("implement flow.yaml", () => {
  test("runs the four steps in order", () => {
    expect(
      [...FLOW.matchAll(/^\s+path: (f\/factory\/steps\/implement_\w+)$/gm)].map(
        (m) => m[1],
      ),
    ).toEqual([
      "f/factory/steps/implement_prepare",
      "f/factory/steps/implement_generate",
      "f/factory/steps/implement_verify",
      "f/factory/steps/implement_finish",
    ]);
  });

  test("records failures under the implement flow path", () => {
    expect(FLOW).toContain("value: f/factory/implement\n");
  });

  test("has no module-level retry", () => {
    expect(FLOW).not.toContain("retry:");
  });
});
