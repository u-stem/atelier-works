import { afterEach, describe, expect, test } from "bun:test";
import { reportRunScriptTo } from "./connectionReport.ts";
import type { RunResult } from "./errors.ts";
import { runScript, setConnectionReporter } from "./windmill.ts";

afterEach(() => {
  setConnectionReporter(null);
});

describe("reportRunScriptTo", () => {
  test("hands the result of every runScript call to the given function", async () => {
    const results: RunResult[] = [];
    reportRunScriptTo((result) => {
      results.push(result);
    });
    await runScript(
      "console_query",
      {},
      { fetchFn: () => Promise.reject(new TypeError("down")) },
    );
    expect(results).toEqual([{ ok: false, error: { kind: "network" } }]);
  });
});
