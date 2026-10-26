// Console用workerが照合に使う定数のファイル(`lib/console_known_paths.ts`)が、リポジトリの定義と一致することを確かめる。
// 定数は`scripts/gen-console-known-paths.ts`が生成してコミットする。定義を変えて作り直し忘れたとき、ここで落ちる。

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import {
  KNOWN_FLOW_PATHS,
  KNOWN_SCRIPT_PATHS,
  REPO_SCHEDULES,
} from "../../f/factory/lib/console_known_paths.ts";
import {
  collectKnownPaths,
  renderKnownPaths,
} from "../../scripts/gen-console-known-paths.ts";

const FILE = "f/factory/lib/console_known_paths.ts";

async function glob(pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Glob(pattern).scan(".")) found.push(file);
  return found.sort();
}

describe("the generated known paths", () => {
  test("match what the generator renders from the repository", async () => {
    const rendered = renderKnownPaths(await collectKnownPaths("."));
    expect(await Bun.file(FILE).text()).toBe(rendered);
  });

  test("list every script definition outside lib", async () => {
    const expected = (await glob("f/factory/**/*.script.yaml"))
      .map((file) => file.replace(/\.script\.yaml$/, ""))
      .filter((path) => !path.startsWith("f/factory/lib/"))
      .sort();
    expect([...KNOWN_SCRIPT_PATHS].sort()).toEqual(expected);
  });

  test("do not list a lib module as a script", () => {
    expect(
      KNOWN_SCRIPT_PATHS.filter((path) => path.startsWith("f/factory/lib/")),
    ).toEqual([]);
  });

  test("list every flow by the name of its directory", async () => {
    const expected = (await glob("f/factory/*__flow/flow.yaml"))
      .map((file) =>
        file.replace(/__flow\/flow\.yaml$/, "").replace(/^f\/factory\//, ""),
      )
      .map((name) => `f/factory/${name}`)
      .sort();
    expect([...KNOWN_FLOW_PATHS].sort()).toEqual(expected);
  });

  test("hold one schedule per schedule definition", async () => {
    const expected = (await glob("f/factory/*.schedule.yaml"))
      .map((file) => file.replace(/\.schedule\.yaml$/, ""))
      .sort();
    expect(REPO_SCHEDULES.map((schedule) => schedule.path).sort()).toEqual(
      expected,
    );
  });

  test("point every schedule at a known script or flow", () => {
    const unknown = REPO_SCHEDULES.filter(
      (schedule) =>
        !(schedule.is_flow ? KNOWN_FLOW_PATHS : KNOWN_SCRIPT_PATHS).includes(
          schedule.script_path,
        ),
    ).map((schedule) => schedule.path);
    expect(unknown).toEqual([]);
  });

  test("copy the cron, the time zone and the switches from the definition", async () => {
    const mismatched: string[] = [];
    for (const schedule of REPO_SCHEDULES) {
      const parsed: unknown = Bun.YAML.parse(
        await Bun.file(`${schedule.path}.schedule.yaml`).text(),
      );
      const same =
        typeof parsed === "object" &&
        parsed !== null &&
        "schedule" in parsed &&
        parsed.schedule === schedule.schedule &&
        "timezone" in parsed &&
        parsed.timezone === schedule.timezone &&
        "enabled" in parsed &&
        parsed.enabled === schedule.enabled;
      if (!same) mismatched.push(schedule.path);
    }
    expect(mismatched).toEqual([]);
  });

  test("keep the lists sorted, so a regeneration makes no needless diff", () => {
    expect([...KNOWN_SCRIPT_PATHS]).toEqual([...KNOWN_SCRIPT_PATHS].sort());
  });

  test("know the read scripts of the Console", () => {
    expect(
      ["console_jobs", "console_schedules", "console_config"].filter(
        (name) => !KNOWN_SCRIPT_PATHS.includes(`f/factory/${name}`),
      ),
    ).toEqual([]);
  });

  test("render the same text for the same input", async () => {
    const known = await collectKnownPaths(".");
    expect(renderKnownPaths(known)).toBe(renderKnownPaths(known));
  });
});
