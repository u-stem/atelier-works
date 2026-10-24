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
  return MISE.slice(start, next < 0 ? undefined : next)
    .split("\n")
    .filter((line) => !line.startsWith("description"))
    .join("\n");
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

describe("tasks that ask a human to confirm", () => {
  // 端末での確認はstdinとstdoutがTTYのときだけ通る。`raw = true`が無いと、miseが出力をつなぎ替える。
  for (const name of [
    "push:prune",
    "freeze:place",
    "freeze:release",
    "freeze:reset",
  ]) {
    test(`${name} runs in raw mode`, () => {
      expect(taskBody(name)).toContain("raw = true");
    });
  }
});

describe("scripts/bootstrap.sh full mode", () => {
  async function commandLines(): Promise<string[]> {
    const text = await Bun.file("scripts/bootstrap.sh").text();
    return text
      .replaceAll("\\\n", " ")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
  }

  test("does not call wmill sync push directly", async () => {
    const lines = await commandLines();

    expect(lines.some((line) => /wmill\s+sync\s+push/.test(line))).toBe(false);
  });

  test("pushes through the freeze wrapper", async () => {
    const lines = await commandLines();

    expect(
      lines.some((line) => line.includes("./scripts/freeze.ts push")),
    ).toBe(true);
  });

  test("keeps remote-only items by not passing --prune", async () => {
    const lines = await commandLines();

    expect(lines.some((line) => /freeze\.ts push.*--prune/.test(line))).toBe(
      false,
    );
  });
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

describe("self_update reconcile-only run", () => {
  async function source(): Promise<string> {
    return await Bun.file("f/factory/self_update.ts").text();
  }

  test("returns before the migration and the deployed sha update", async () => {
    const text = await source();

    expect(text.indexOf("if (reconcileOnly) {")).toBeLessThan(
      text.indexOf('"datatable"'),
    );
  });

  test("does not record a failed deployment", async () => {
    const text = await source();

    expect(text).toMatch(
      /if \(!reconcileOnly\) \{\s*await recordFailedDeployment\(/,
    );
  });
});

describe("self_update deploy freeze", () => {
  async function source(): Promise<string> {
    return await Bun.file("f/factory/self_update.ts").text();
  }

  /** 見つからない照合を、通ったことにしないために例外にする。 */
  function at(text: string, needle: string): number {
    const index = text.indexOf(needle);
    if (index < 0) throw new Error(`not found in self_update.ts: ${needle}`);
    return index;
  }

  /** 見送りの判定から、見送りの戻りまでの本文。 */
  async function heldBlock(): Promise<string> {
    const text = await source();
    const start = at(text, "shouldHoldDeploy(plan)");
    return text.slice(start, at(text, 'return { outcome: "held"'));
  }

  test("decides to hold before the first wmill call", async () => {
    const text = await source();

    expect(at(text, "shouldHoldDeploy(plan)")).toBeLessThan(
      at(text, "await runWmillCli("),
    );
  });

  test("decides to hold only once", async () => {
    const text = await source();

    expect(text.match(/shouldHoldDeploy\(plan\)/g)?.length).toBe(1);
  });

  test("returns held before the deployed sha update", async () => {
    const text = await source();

    expect(at(text, 'return { outcome: "held"')).toBeLessThan(
      at(text, "await setDeployedSha("),
    );
  });

  test("returns held with the deploy_freeze reason", async () => {
    const text = await source();

    expect(text).toContain('{ outcome: "held", reason: "deploy_freeze" }');
  });

  test("does not record a failed deployment when it holds", async () => {
    expect(await heldBlock()).not.toContain("recordFailedDeployment");
  });

  test("does not throw when it holds", async () => {
    expect(await heldBlock()).not.toContain("throw ");
  });

  test("does not read the reason or the holder of a freeze", async () => {
    expect(await heldBlock()).not.toMatch(/\.(reason|holder)\b/);
  });

  test("logs the id and the expiry of the freezes", async () => {
    expect(await heldBlock()).toContain("plan.deployFreezes");
  });

  test("holds while it reconciles an ended schedule freeze too", async () => {
    const text = await source();

    expect(at(text, "shouldHoldDeploy(plan)")).toBeLessThan(
      at(text, "if (reconcileOnly) {"),
    );
  });
});

describe("poll_issues deploy freeze", () => {
  async function source(): Promise<string> {
    return await Bun.file("f/factory/poll_issues.ts").text();
  }

  test("passes the deploy freeze check to the deployed sha check", async () => {
    expect(await source()).toContain("isDeployHeld:");
  });

  test("reads only the deploy freezes", async () => {
    expect(await source()).toContain("readActiveDeployFreezes(");
  });

  test("bounds the read of the freeze variable", async () => {
    const text = await source();
    const at = text.indexOf("readActiveDeployFreezes(");

    expect(at >= 0 && text.lastIndexOf("withCallTimeout(", at) > 0).toBe(true);
  });
});

describe("self_update", () => {
  test("builds the push arguments from the freeze plan", async () => {
    const source = await Bun.file("f/factory/self_update.ts").text();

    expect(source).toContain("plan.excludesArg");
  });
});
