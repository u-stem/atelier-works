import { describe, expect, test } from "bun:test";
import {
  FREEZE_REQUIRED_EXCLUDES,
  parseWmillExcludes,
} from "../../f/factory/lib/freezes.ts";

// `wmill sync push`を呼ぶ経路は、すべて`scripts/freeze.ts`を通る。
// 通らない経路があると、凍結中のスケジュールが再び上書きされる。

const MISE = await Bun.file("mise.toml").text();

/** `[tasks.<name>]`から次の`[`までの本文。 */
function taskBody(name: string): string {
  const header = name.includes(":") ? `[tasks."${name}"]` : `[tasks.${name}]`;
  const start = MISE.indexOf(header);
  if (start < 0) return "";
  const next = MISE.indexOf("\n[", start + header.length);
  return MISE.slice(start, next < 0 ? undefined : next);
}

describe("mise.toml push tasks", () => {
  for (const name of ["push", "push:prune", "push:dry", "deploy"]) {
    test(`${name} does not call wmill sync push directly`, () => {
      expect(taskBody(name)).not.toContain("wmill sync push");
    });
  }

  test("push runs the freeze wrapper", () => {
    expect(taskBody("push")).toContain("scripts/freeze.ts push");
  });

  test("push:prune passes --prune to the wrapper", () => {
    expect(taskBody("push:prune")).toContain("scripts/freeze.ts push --prune");
  });

  test("push:dry passes --dry-run to the wrapper", () => {
    expect(taskBody("push:dry")).toContain("scripts/freeze.ts push --dry-run");
  });

  test("deploy checks the freezes before it pulls", () => {
    const body = taskBody("deploy");

    expect(body.indexOf("scripts/freeze.ts check")).toBeLessThan(
      body.indexOf("git pull"),
    );
  });

  test("deploy pushes through the wrapper", () => {
    expect(taskBody("deploy")).toContain("scripts/freeze.ts push");
  });

  for (const name of [
    "freeze:place",
    "freeze:list",
    "freeze:release",
    "freeze:reset",
  ]) {
    test(`${name} is defined`, () => {
      expect(taskBody(name)).toContain("scripts/freeze.ts");
    });
  }
});

describe("wmill.yaml excludes", () => {
  test("keep every required pattern", async () => {
    const parsed = parseWmillExcludes(await Bun.file("wmill.yaml").text());

    expect(
      parsed.ok &&
        FREEZE_REQUIRED_EXCLUDES.every((p) => parsed.value.includes(p)),
    ).toBe(true);
  });
});

describe("self_update", () => {
  test("builds the push arguments from the freeze plan", async () => {
    const source = await Bun.file("f/factory/self_update.ts").text();

    expect(source).toContain("plan.excludesArg");
  });
});
