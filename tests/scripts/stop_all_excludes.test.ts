import { describe, expect, test } from "bun:test";
import { parseWmillExcludes } from "../../f/factory/lib/freezes.ts";

describe("wmill.yaml", () => {
  test("keeps the stop-all variable out of the sync", async () => {
    const parsed = parseWmillExcludes(await Bun.file("wmill.yaml").text());
    expect(parsed.ok ? parsed.value : []).toContain(
      "f/factory/stop_all.variable.yaml",
    );
  });
});
