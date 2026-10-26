// Console用workerが照合に使う定数のファイル(`lib/console_known_paths.ts`)が、リポジトリの定義と一致することを確かめる。
// 定数は`scripts/gen-console-known-paths.ts`が生成してコミットする。定義を変えて作り直し忘れたとき、ここで落ちる。

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import {
  HISTORY_FILTER_PATHS,
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

  // 解除のscriptは、Consoleの履歴の絞り込みに要らない(tag consoleのジョブは既定で一覧に出ない)。
  // 名前を`f/`の他のファイルに持たせない検査(`hold_wiring.test.ts`)を、定数が破らないよう除く。
  const WITHHELD = ["f/factory/hold_release", "f/factory/freeze_release"];

  test("list every script definition outside lib, but the release scripts", async () => {
    const expected = (await glob("f/factory/**/*.script.yaml"))
      .map((file) => file.replace(/\.script\.yaml$/, ""))
      .filter((path) => !path.startsWith("f/factory/lib/"))
      .filter((path) => !WITHHELD.includes(path))
      .sort();
    expect([...KNOWN_SCRIPT_PATHS].sort()).toEqual(expected);
  });

  test("do not list the release scripts", () => {
    expect(
      KNOWN_SCRIPT_PATHS.filter((path) => WITHHELD.includes(path)),
    ).toEqual([]);
  });

  test("are imported by the job and schedule scripts only", async () => {
    const importers: string[] = [];
    for (const file of await glob("f/**/*.ts")) {
      if (file === "f/factory/lib/console_known_paths.ts") continue;
      const source = await Bun.file(file).text();
      if (/from\s+["'][^"']*console_known_paths/.test(source)) {
        importers.push(file);
      }
    }
    expect(importers).toEqual([
      "f/factory/console_jobs.ts",
      "f/factory/console_schedules.ts",
    ]);
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

/** scriptの定義の`tag`。無ければ`null`。 */
async function tagOf(path: string): Promise<string | null> {
  const parsed: unknown = Bun.YAML.parse(
    await Bun.file(`${path}.script.yaml`).text(),
  );
  if (typeof parsed !== "object" || parsed === null || !("tag" in parsed)) {
    return null;
  }
  return typeof parsed.tag === "string" ? parsed.tag : null;
}

// Consoleの履歴の絞り込みに出す一覧。ルートのジョブとして動くscriptとフローだけにする。
// フローのステップ、失敗ハンドラ、tag consoleのscriptは、履歴に出ないので、選ぶと常に0件になる。
describe("the history filter paths", () => {
  test("do not list a step of a flow", () => {
    expect(
      HISTORY_FILTER_PATHS.filter((path) =>
        path.startsWith("f/factory/steps/"),
      ),
    ).toEqual([]);
  });

  test("do not list the error handler", () => {
    expect(HISTORY_FILTER_PATHS).not.toContain("f/factory/on_error_flow");
  });

  test("do not list a script that runs on the Console worker", async () => {
    const onConsole: string[] = [];
    for (const path of KNOWN_SCRIPT_PATHS) {
      if ((await tagOf(path)) === "console") onConsole.push(path);
    }
    expect(
      HISTORY_FILTER_PATHS.filter((path) => onConsole.includes(path)),
    ).toEqual([]);
  });

  test("list every script that runs as a root job", async () => {
    const expected: string[] = [];
    for (const path of KNOWN_SCRIPT_PATHS) {
      if (path.startsWith("f/factory/steps/")) continue;
      if (path === "f/factory/on_error_flow") continue;
      if ((await tagOf(path)) === "console") continue;
      expected.push(path);
    }
    expect(
      HISTORY_FILTER_PATHS.filter((path) => !KNOWN_FLOW_PATHS.includes(path)),
    ).toEqual(expected);
  });

  test("list every flow", () => {
    expect(
      HISTORY_FILTER_PATHS.filter((path) => KNOWN_FLOW_PATHS.includes(path)),
    ).toEqual([...KNOWN_FLOW_PATHS]);
  });

  test("list only known paths", () => {
    expect(
      HISTORY_FILTER_PATHS.filter(
        (path) =>
          !KNOWN_SCRIPT_PATHS.includes(path) &&
          !KNOWN_FLOW_PATHS.includes(path),
      ),
    ).toEqual([]);
  });

  test("are sorted, so the options keep their order", () => {
    expect([...HISTORY_FILTER_PATHS]).toEqual([...HISTORY_FILTER_PATHS].sort());
  });

  test("are not empty", () => {
    expect(HISTORY_FILTER_PATHS.length).toBeGreaterThan(10);
  });
});
