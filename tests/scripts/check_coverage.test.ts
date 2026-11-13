import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ChangedLines,
  type CheckCoverageOptions,
  checkCoverage,
  checkDiffCoverage,
  DIFF_COVERAGE_FLOOR_PERCENT,
  DIFF_COVERAGE_PATHS,
  diffArgv,
  isTargetPath,
  judgeCoverage,
  judgeDiffCoverage,
  LAYER_FLOORS,
  type Layer,
  type LayerFloor,
  type ListTargetsOptions,
  layerOf,
  listChangedLines,
  listTargetFiles,
  NOT_LOADABLE_BY_BUN_TEST,
  NOT_LOADABLE_PATH,
  parseDiffAddedLines,
  runCoverageChecks,
  selectTargets,
  summarizeLcov,
  type TargetListing,
  targetListArgv,
} from "../../scripts/check-coverage.ts";

type Hit = readonly [line: number, count: number];

/**
 * 失敗の出力の字数の上限。Factoryの修正のプロンプトには、出力の末尾2000字が載る。
 * 末尾にはmiseのタスク失敗の行が付くので、その分を引く。
 */
const OUTPUT_TAIL_CHARS = 1800;

const ALL_LAYERS: readonly Layer[] = [
  "f/factory/lib",
  "f/factory/steps",
  "f/factory (other)",
  "scripts",
];

function floorsOf(percent: number): readonly LayerFloor[] {
  return ALL_LAYERS.map((layer) => ({ layer, floorPercent: percent }));
}

/** 対象の列挙を差し替える関数を作る。 */
function listing(
  targets: readonly string[],
  malformed: readonly string[] = [],
): () => TargetListing {
  return () => ({ targets, malformed });
}

/** lcovの1レコードを作る。`hits`は`DA:<行>,<回数>`の並びで、`extra`は`SF`の直後に足す行。 */
function record(path: string, hits: readonly Hit[], extra = ""): string {
  const lines = hits.map(([line, count]) => `DA:${line},${count}`);
  return ["TN:", `SF:${path}`, extra, ...lines, "end_of_record"]
    .filter((line) => line !== "")
    .join("\n");
}

/** 行1から並べ、先頭の`executed`行だけを実行済みにするDAを作る。 */
function hitsOf(executable: number, executed: number): Hit[] {
  return Array.from({ length: executable }, (_, index): Hit => {
    return [index + 1, index < executed ? 1 : 0];
  });
}

describe("isTargetPath", () => {
  test("accepts a source file under f/factory", () => {
    expect(isTargetPath("f/factory/lib/foo.ts")).toBe(true);
  });

  test("accepts a source file under scripts", () => {
    expect(isTargetPath("scripts/check-idle.ts")).toBe(true);
  });

  test("rejects a test file", () => {
    expect(isTargetPath("f/factory/lib/foo.test.ts")).toBe(false);
  });

  test("rejects a declaration file", () => {
    expect(isTargetPath("scripts/types.d.ts")).toBe(false);
  });

  test("rejects a test helper under tests", () => {
    expect(isTargetPath("tests/fixtures/helper.ts")).toBe(false);
  });

  test("rejects the console sources", () => {
    expect(isTargetPath("console/src/lib/pipeline.ts")).toBe(false);
  });

  test("rejects a path that leaves the repository", () => {
    expect(isTargetPath("../../tmp/x/f/factory/foo.ts")).toBe(false);
  });

  test("rejects a path that climbs out through a target prefix", () => {
    expect(isTargetPath("f/factory/../../etc/foo.ts")).toBe(false);
  });

  test("rejects a non-TypeScript file", () => {
    expect(isTargetPath("f/factory/lib/foo.script.yaml")).toBe(false);
  });
});

describe("summarizeLcov", () => {
  test("counts executed and executable lines of a target file", () => {
    const text = record("f/factory/lib/a.ts", hitsOf(10, 8));

    expect(summarizeLcov(text)).toMatchObject({ executable: 10, executed: 8 });
  });

  test("leaves files outside the target out of the totals", () => {
    const text = [
      record("f/factory/lib/a.ts", hitsOf(10, 8)),
      record("../../tmp/x/b.ts", hitsOf(100, 0)),
      record("tests/fixtures/c.ts", hitsOf(100, 0)),
      record("console/src/d.ts", hitsOf(100, 0)),
    ].join("\n");

    expect(summarizeLcov(text)).toMatchObject({ executable: 10, executed: 8 });
  });

  test("counts a line once when the same file appears twice", () => {
    const text = [
      record("f/factory/lib/a.ts", [
        [1, 1],
        [2, 0],
        [3, 0],
        [4, 0],
      ]),
      record("f/factory/lib/a.ts", [
        [1, 0],
        [2, 1],
        [3, 0],
        [4, 0],
      ]),
    ].join("\n");

    expect(summarizeLcov(text)).toMatchObject({ executable: 4, executed: 2 });
  });

  test("lists a file that appears twice as one file", () => {
    const text = [
      record("f/factory/lib/a.ts", hitsOf(4, 1)),
      record("f/factory/lib/a.ts", hitsOf(4, 2)),
    ].join("\n");

    expect(summarizeLcov(text).files).toHaveLength(1);
  });

  test("ignores lines it cannot parse", () => {
    const text = record("f/factory/lib/a.ts", hitsOf(4, 2), "DA:oops,x");

    expect(summarizeLcov(text)).toMatchObject({ executable: 4, executed: 2 });
  });
});

describe("judgeCoverage", () => {
  test("passes when the ratio equals the floor", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 8)));

    expect(judgeCoverage(summary, 80).ok).toBe(true);
  });

  test("passes when the ratio is above the floor", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 9)));

    expect(judgeCoverage(summary, 80).ok).toBe(true);
  });

  test("fails when the ratio is below the floor", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 7)));

    expect(judgeCoverage(summary, 80).ok).toBe(false);
  });

  test("states the measured ratio on failure", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 7)));

    expect(judgeCoverage(summary, 80).message).toContain("70.00%");
  });

  test("states the floor on failure", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 7)));

    expect(judgeCoverage(summary, 80).message).toContain("80.00%");
  });

  test("lists the file with the most unexecuted lines first", () => {
    const text = [
      record("f/factory/lib/small.ts", hitsOf(10, 0)),
      record("f/factory/lib/large.ts", hitsOf(100, 10)),
    ].join("\n");

    const message = judgeCoverage(summarizeLcov(text), 80).message;

    expect(message.indexOf("large.ts")).toBeLessThan(
      message.indexOf("small.ts"),
    );
  });

  test("lists at most five files", () => {
    const text = Array.from({ length: 8 }, (_, index) =>
      record(`f/factory/lib/file${index}.ts`, hitsOf(10, 0)),
    ).join("\n");

    const message = judgeCoverage(summarizeLcov(text), 80).message;

    expect(message.match(/f\/factory\/lib\/file\d\.ts/g)).toHaveLength(5);
  });

  test("keeps function names out of the failure output", () => {
    const text = record(
      "f/factory/lib/a.ts",
      hitsOf(10, 0),
      "FN:3,secretFunctionName",
    );

    expect(judgeCoverage(summarizeLcov(text), 80).message).not.toContain(
      "secretFunctionName",
    );
  });

  test("fails when there are no target files", () => {
    const summary = summarizeLcov(
      record("tests/fixtures/c.ts", hitsOf(10, 10)),
    );

    expect(judgeCoverage(summary, 0).ok).toBe(false);
  });

  test("says that no target file was found", () => {
    const summary = summarizeLcov(
      record("tests/fixtures/c.ts", hitsOf(10, 10)),
    );

    expect(judgeCoverage(summary, 0).message).toContain("no target");
  });
});

describe("layerOf", () => {
  test.each<readonly [string, Layer]>([
    ["f/factory/lib/a.ts", "f/factory/lib"],
    ["f/factory/lib/deep/er/a.ts", "f/factory/lib"],
    ["f/factory/steps/a.ts", "f/factory/steps"],
    ["f/factory/steps/deep/a.ts", "f/factory/steps"],
    ["f/factory/a.ts", "f/factory (other)"],
    ["f/factory/other_dir/a.ts", "f/factory (other)"],
    ["f/factory/library/a.ts", "f/factory (other)"],
    ["scripts/a.ts", "scripts"],
    ["scripts/host_apply/a.ts", "scripts"],
    ["scripts/claude-hooks/a.ts", "scripts"],
  ])("assigns %s to %s", (path, layer) => {
    expect(layerOf(path)).toBe(layer);
  });

  test("assigns no layer to a path outside the target", () => {
    expect(layerOf("console/src/a.ts")).toBeNull();
  });
});

describe("LAYER_FLOORS", () => {
  test("has exactly one floor for each layer", () => {
    expect(LAYER_FLOORS.map(({ layer }) => layer).sort()).toEqual(
      [...ALL_LAYERS].sort(),
    );
  });

  test("keeps every floor between 0 and 100", () => {
    const outside = LAYER_FLOORS.filter(
      ({ floorPercent }) => floorPercent < 0 || floorPercent > 100,
    );

    expect(outside).toEqual([]);
  });
});

describe("NOT_LOADABLE_BY_BUN_TEST", () => {
  test("holds exactly the test-db scripts that bun test cannot load", () => {
    expect([...NOT_LOADABLE_BY_BUN_TEST].sort()).toEqual([
      "scripts/test-db-console-actions.ts",
      "scripts/test-db-deploy-approvals.ts",
      "scripts/test-db-holds.ts",
      "scripts/test-db-queries.ts",
    ]);
  });

  test("holds only paths of the scripts/test-db- form", () => {
    const others = NOT_LOADABLE_BY_BUN_TEST.filter(
      (path) => !NOT_LOADABLE_PATH.test(path),
    );

    expect(others).toEqual([]);
  });
});

describe("targetListArgv", () => {
  test("lists cached and untracked files for the unloaded check", () => {
    expect(targetListArgv({ includeUntracked: true })).toEqual([
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "f/factory",
      "scripts",
    ]);
  });

  test("lists only cached files for the load test", () => {
    expect(targetListArgv({ includeUntracked: false })).toEqual([
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--",
      "f/factory",
      "scripts",
    ]);
  });
});

describe("selectTargets", () => {
  const present = (): boolean => true;

  test("keeps a source file under f/factory and scripts", () => {
    const result = selectTargets(
      ["f/factory/lib/a.ts", "scripts/b.ts"],
      present,
    );

    expect(result.targets).toEqual(["f/factory/lib/a.ts", "scripts/b.ts"]);
  });

  test("leaves out test files, declaration files, and other extensions", () => {
    const result = selectTargets(
      [
        "f/factory/lib/a.test.ts",
        "scripts/types.d.ts",
        "f/factory/lib/a.script.yaml",
        "scripts/run.sh",
      ],
      present,
    );

    expect(result).toEqual({ targets: [], malformed: [] });
  });

  test("lists a path once when git repeats it", () => {
    const result = selectTargets(
      ["f/factory/lib/a.ts", "f/factory/lib/a.ts"],
      present,
    );

    expect(result.targets).toEqual(["f/factory/lib/a.ts"]);
  });

  test("leaves out a file that is not in the working tree", () => {
    const result = selectTargets(
      ["f/factory/lib/gone.ts", "f/factory/lib/a.ts"],
      (path) => path !== "f/factory/lib/gone.ts",
    );

    expect(result.targets).toEqual(["f/factory/lib/a.ts"]);
  });

  test("does not count a malformed name of a file that is gone", () => {
    const result = selectTargets(["f/factory/lib/bad name.ts"], () => false);

    expect(result.malformed).toEqual([]);
  });

  test("reports a name with a character outside the allowed set", () => {
    const result = selectTargets(
      ["f/factory/lib/bad name.ts", "scripts/日本語.ts"],
      present,
    );

    expect(result.malformed).toEqual([
      "f/factory/lib/bad name.ts",
      "scripts/日本語.ts",
    ]);
  });

  test("does not list a malformed name as a target", () => {
    const result = selectTargets(["f/factory/lib/bad name.ts"], present);

    expect(result.targets).toEqual([]);
  });

  test("does not report a malformed name of a test file", () => {
    const result = selectTargets(["f/factory/lib/a b.test.ts"], present);

    expect(result.malformed).toEqual([]);
  });
});

describe("listTargetFiles", () => {
  test("runs the argv without a shell in the root", () => {
    const calls: { argv: readonly string[]; cwd: string }[] = [];

    listTargetFiles("/the/root", { includeUntracked: true }, (argv, cwd) => {
      calls.push({ argv, cwd });
      return "";
    });

    expect(calls).toEqual([
      {
        argv: targetListArgv({ includeUntracked: true }),
        cwd: "/the/root",
      },
    ]);
  });

  describe("with files in a directory", () => {
    let dir = "";

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "check-coverage-files-"));
      mkdirSync(join(dir, "f/factory/lib"), { recursive: true });
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "f/factory/lib/a.ts"), "");
      writeFileSync(join(dir, "scripts/b.ts"), "");
    });

    afterAll(() => {
      if (dir !== "") rmSync(dir, { recursive: true, force: true });
    });

    test("splits the output at NUL", () => {
      const result = listTargetFiles(
        dir,
        { includeUntracked: false },
        () => "f/factory/lib/a.ts\0scripts/b.ts\0",
      );

      expect(result.targets).toEqual(["f/factory/lib/a.ts", "scripts/b.ts"]);
    });

    test("lists the targets in order", () => {
      const result = listTargetFiles(
        dir,
        { includeUntracked: false },
        () => "scripts/b.ts\0f/factory/lib/a.ts\0",
      );

      expect(result.targets).toEqual(["f/factory/lib/a.ts", "scripts/b.ts"]);
    });

    test("leaves out a path that does not exist", () => {
      const result = listTargetFiles(
        dir,
        { includeUntracked: false },
        () => "f/factory/lib/gone.ts\0scripts/b.ts\0",
      );

      expect(result.targets).toEqual(["scripts/b.ts"]);
    });

    test("leaves out a path under a file", () => {
      const result = listTargetFiles(
        dir,
        { includeUntracked: false },
        () => "scripts/b.ts/x.ts\0scripts/b.ts\0",
      );

      expect(result.targets).toEqual(["scripts/b.ts"]);
    });

    test("throws when a path cannot be examined for another reason", () => {
      mkdirSync(join(dir, "f/factory/loop"), { recursive: true });
      symlinkSync("self", join(dir, "f/factory/loop/self"));

      expect(() =>
        listTargetFiles(
          dir,
          { includeUntracked: false },
          () => "f/factory/loop/self/a.ts\0",
        ),
      ).toThrow();
    });
  });

  test("throws when git fails", () => {
    expect(() =>
      listTargetFiles("/the/root", { includeUntracked: true }, () => {
        throw new Error("exit code 128");
      }),
    ).toThrow("exit code 128");
  });
});

describe("listTargetFiles in a temporary repository", () => {
  let repo = "";

  // gitのフックの中で走ると、親のリポジトリを指す`GIT_*`が環境に残る。一時リポジトリには引き継がない。
  function git(cwd: string, args: readonly string[]): string {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed`);
    }
    return result.stdout.toString();
  }

  function write(path: string): void {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), "export const x = 1;\n");
  }

  const run = (argv: readonly string[], cwd: string): string =>
    git(cwd, argv.slice(1));

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "check-coverage-repo-"));
    git(repo, ["init", "-q"]);
    write("f/factory/lib/staged.ts");
    write("f/factory/lib/removed.ts");
    write("f/factory/lib/staged.test.ts");
    git(repo, ["add", "-A"]);
    unlinkSync(join(repo, "f/factory/lib/removed.ts"));
    write("scripts/untracked.ts");
  });

  afterAll(() => {
    if (repo !== "") rmSync(repo, { recursive: true, force: true });
  });

  test("lists a staged source file", () => {
    const result = listTargetFiles(repo, { includeUntracked: false }, run);

    expect(result.targets).toContain("f/factory/lib/staged.ts");
  });

  test("leaves out an untracked file for the load test", () => {
    const result = listTargetFiles(repo, { includeUntracked: false }, run);

    expect(result.targets).not.toContain("scripts/untracked.ts");
  });

  test("lists an untracked file for the unloaded check", () => {
    const result = listTargetFiles(repo, { includeUntracked: true }, run);

    expect(result.targets).toContain("scripts/untracked.ts");
  });

  test("leaves out a tracked file deleted from the working tree", () => {
    const result = listTargetFiles(repo, { includeUntracked: true }, run);

    expect(result.targets).not.toContain("f/factory/lib/removed.ts");
  });

  test("leaves out a staged test file", () => {
    const result = listTargetFiles(repo, { includeUntracked: true }, run);

    expect(result.targets).not.toContain("f/factory/lib/staged.test.ts");
  });
});

describe("judgeCoverage with layers", () => {
  const lib = (executable: number, executed: number): string =>
    record("f/factory/lib/a.ts", hitsOf(executable, executed));
  const steps = (executable: number, executed: number): string =>
    record("f/factory/steps/b.ts", hitsOf(executable, executed));

  test("fails when a layer is below its floor although the total meets the floor", () => {
    const summary = summarizeLcov([lib(1000, 1000), steps(10, 0)].join("\n"));

    const verdict = judgeCoverage(summary, 80, {
      layerFloors: [
        { layer: "f/factory/lib", floorPercent: 90 },
        { layer: "f/factory/steps", floorPercent: 50 },
      ],
    });

    expect(verdict.ok).toBe(false);
  });

  test("names the layer that is below its floor", () => {
    const summary = summarizeLcov([lib(1000, 1000), steps(10, 0)].join("\n"));

    const verdict = judgeCoverage(summary, 80, {
      layerFloors: [
        { layer: "f/factory/lib", floorPercent: 90 },
        { layer: "f/factory/steps", floorPercent: 50 },
      ],
    });

    expect(verdict.message).toContain("f/factory/steps is below its floor");
  });

  test("does not name a layer that meets its floor", () => {
    const summary = summarizeLcov([lib(1000, 1000), steps(10, 0)].join("\n"));

    const verdict = judgeCoverage(summary, 80, {
      layerFloors: [
        { layer: "f/factory/lib", floorPercent: 90 },
        { layer: "f/factory/steps", floorPercent: 50 },
      ],
    });

    expect(verdict.message).not.toContain("f/factory/lib is below its floor");
  });

  test("passes when every layer and the total meet their floors", () => {
    const summary = summarizeLcov([lib(10, 10), steps(10, 6)].join("\n"));

    const verdict = judgeCoverage(summary, 80, {
      layerFloors: [
        { layer: "f/factory/lib", floorPercent: 90 },
        { layer: "f/factory/steps", floorPercent: 50 },
      ],
    });

    expect(verdict.ok).toBe(true);
  });

  test("states the ratio and floor of every layer on success", () => {
    const summary = summarizeLcov([lib(10, 10), steps(10, 6)].join("\n"));

    const verdict = judgeCoverage(summary, 80, {
      layerFloors: [
        { layer: "f/factory/lib", floorPercent: 90 },
        { layer: "f/factory/steps", floorPercent: 50 },
      ],
    });

    expect(verdict.message).toContain(
      "f/factory/lib: 100.00% (10 of 10 lines in 1 files), floor 90.00%",
    );
    expect(verdict.message).toContain(
      "f/factory/steps: 60.00% (6 of 10 lines in 1 files), floor 50.00%",
    );
  });

  test("fails when a layer with a floor has no target", () => {
    const summary = summarizeLcov(lib(10, 10));

    const verdict = judgeCoverage(summary, 0, {
      layerFloors: [{ layer: "scripts", floorPercent: 0 }],
    });

    expect(verdict.message).toContain("no target file in layer scripts");
  });

  test("names the unloaded targets when a layer has no target", () => {
    const summary = summarizeLcov(lib(10, 10));

    const verdict = judgeCoverage(summary, 0, {
      layerFloors: [{ layer: "scripts", floorPercent: 0 }],
      unloaded: ["scripts/unloaded.ts"],
    });

    expect(verdict.message).toContain("scripts/unloaded.ts");
  });

  test("states the unloaded total when a layer has no target", () => {
    const summary = summarizeLcov(lib(10, 10));

    const verdict = judgeCoverage(summary, 0, {
      layerFloors: [{ layer: "scripts", floorPercent: 0 }],
      unloaded: ["scripts/a.ts", "scripts/b.ts"],
    });

    expect(verdict.message).toContain("2 target files were not loaded");
  });

  test("ends with the reason when only the total is below its floor", () => {
    const summary = summarizeLcov(lib(10, 9));

    const verdict = judgeCoverage(summary, 99, {
      layerFloors: [{ layer: "f/factory/lib", floorPercent: 50 }],
    });

    expect(verdict.message.split("\n").at(-1)).toContain(
      "total is below its floor: 90.00% < 99.00%",
    );
  });

  test("names the total after the layers that are below their floors", () => {
    const summary = summarizeLcov([lib(10, 0), steps(10, 0)].join("\n"));

    const verdict = judgeCoverage(summary, 99, {
      layerFloors: [
        { layer: "f/factory/lib", floorPercent: 50 },
        { layer: "f/factory/steps", floorPercent: 50 },
      ],
    });

    expect(verdict.message.indexOf("total is below its floor")).toBeGreaterThan(
      verdict.message.indexOf("f/factory/steps is below its floor"),
    );
  });

  test("lists the worst files only for a layer below its floor", () => {
    const summary = summarizeLcov(
      [
        record("f/factory/lib/healthy_but_untested.ts", hitsOf(100, 90)),
        steps(10, 0),
      ].join("\n"),
    );

    const verdict = judgeCoverage(summary, 0, {
      layerFloors: [
        { layer: "f/factory/lib", floorPercent: 50 },
        { layer: "f/factory/steps", floorPercent: 50 },
      ],
    });

    expect(verdict.message).not.toContain("healthy_but_untested");
  });
});

describe("judgeCoverage with unloaded targets", () => {
  const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 10)));
  const unloaded = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `scripts/unloaded${index}.ts`);

  test("fails when a target is unloaded although the ratio is high", () => {
    const verdict = judgeCoverage(summary, 0, { unloaded: unloaded(1) });

    expect(verdict.ok).toBe(false);
  });

  test("names an unloaded path", () => {
    const verdict = judgeCoverage(summary, 0, { unloaded: unloaded(1) });

    expect(verdict.message).toContain("scripts/unloaded0.ts");
  });

  test("states the total of unloaded targets", () => {
    const verdict = judgeCoverage(summary, 0, { unloaded: unloaded(8) });

    expect(verdict.message).toContain("8 target files were not loaded");
  });

  test("lists at most five unloaded paths", () => {
    const verdict = judgeCoverage(summary, 0, { unloaded: unloaded(8) });

    expect(verdict.message.match(/scripts\/unloaded\d\.ts/g)).toHaveLength(5);
  });
});

describe("judgeCoverage when lcov has no target", () => {
  const empty = summarizeLcov(record("tests/fixtures/c.ts", hitsOf(10, 10)));
  const unloaded = (count: number): string[] =>
    Array.from(
      { length: count },
      (_, index) => `scripts/unloaded_module_with_a_long_name_${index}.ts`,
    );

  test("names an unloaded path", () => {
    const verdict = judgeCoverage(empty, 0, { unloaded: unloaded(2) });

    expect(verdict.message).toContain(
      "scripts/unloaded_module_with_a_long_name_0.ts",
    );
  });

  test("states the unloaded total", () => {
    const verdict = judgeCoverage(empty, 0, { unloaded: unloaded(60) });

    expect(verdict.message).toContain("60 target files were not loaded");
  });

  test("fits in the tail the repair prompt keeps", () => {
    const verdict = judgeCoverage(empty, 0, { unloaded: unloaded(60) });

    expect(verdict.message.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
  });

  test("keeps the message when nothing is unloaded", () => {
    const verdict = judgeCoverage(empty, 0, { unloaded: [] });

    expect(verdict.message).toBe(
      "coverage check failed: no target file found in coverage/lcov.info",
    );
  });
});

describe("judgeCoverage output size", () => {
  const manyPoorFiles = (prefix: string): string[] =>
    Array.from({ length: 12 }, (_, index) =>
      record(`${prefix}/some_long_module_name_${index}.ts`, hitsOf(50, 0)),
    );
  const summary = summarizeLcov(
    [
      ...manyPoorFiles("f/factory/lib"),
      ...manyPoorFiles("f/factory/steps"),
      ...manyPoorFiles("f/factory"),
      ...manyPoorFiles("scripts"),
    ].join("\n"),
  );
  const unloaded = Array.from(
    { length: 60 },
    (_, index) => `scripts/unloaded_module_with_a_long_name_${index}.ts`,
  );
  const verdict = judgeCoverage(summary, 99, {
    layerFloors: floorsOf(99),
    unloaded,
  });

  test("fits in the tail the repair prompt keeps", () => {
    expect(verdict.message.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
  });

  test("puts the reasons after the file rows", () => {
    expect(
      verdict.message.indexOf("files with the most unexecuted"),
    ).toBeLessThan(verdict.message.indexOf("is below its floor"));
  });

  test("keeps the unloaded total when the paths are cut", () => {
    expect(verdict.message).toContain("60 target files were not loaded");
  });

  test("keeps the name of every layer below its floor", () => {
    expect(
      ALL_LAYERS.filter(
        (layer) => !verdict.message.includes(`${layer} is below its floor`),
      ),
    ).toEqual([]);
  });
});

describe("checkCoverage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-coverage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeLcov(text: string): void {
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(join(root, "coverage", "lcov.info"), text);
  }

  const untracked = (): readonly string[] => [];

  /** 下限の検査以外を通す共通の設定。a.tsだけが対象で、層の下限は置かない。 */
  const base: Omit<CheckCoverageOptions, "root"> = {
    listTracked: untracked,
    listTargets: listing(["f/factory/lib/a.ts"]),
    layerFloors: [],
    notLoadable: [],
  };

  test("passes with a readable lcov at or above the floor", () => {
    writeLcov(record("f/factory/lib/a.ts", hitsOf(10, 8)));

    const result = checkCoverage({ root, ...base, floorPercent: 80 });

    expect(result.ok).toBe(true);
  });

  test("fails with a readable lcov below the floor", () => {
    writeLcov(record("f/factory/lib/a.ts", hitsOf(10, 7)));

    const result = checkCoverage({ root, ...base, floorPercent: 80 });

    expect(result.message).toContain("70.00%");
  });

  test("fails when coverage/lcov.info is missing", () => {
    const result = checkCoverage({ root, ...base });

    expect(result.message).toContain("lcov.info");
  });

  test("fails when coverage/lcov.info is empty", () => {
    writeLcov("");

    const result = checkCoverage({ root, ...base });

    expect(result.message).toContain("empty");
  });

  test("fails when coverage/lcov.info is a directory", () => {
    mkdirSync(join(root, "coverage", "lcov.info"), { recursive: true });

    const result = checkCoverage({ root, ...base });

    expect(result.message).toContain("regular file");
  });

  test("fails when lcov.info is a symlink", () => {
    mkdirSync(join(root, "coverage"));
    writeFileSync(
      join(root, "real.info"),
      record("f/factory/a.ts", hitsOf(1, 1)),
    );
    symlinkSync(join(root, "real.info"), join(root, "coverage", "lcov.info"));

    const result = checkCoverage({ root, ...base });

    expect(result.message).toContain("symlink");
  });

  test("fails when the lcov has no target file", () => {
    writeLcov(record("tests/fixtures/c.ts", hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([]),
    });

    expect(result.message).toContain("no target");
  });

  test("fails when coverage is a symlink to a directory", () => {
    const real = join(root, "elsewhere");
    mkdirSync(real);
    writeFileSync(
      join(real, "lcov.info"),
      record("f/factory/lib/a.ts", hitsOf(10, 10)),
    );
    symlinkSync(real, join(root, "coverage"));

    const result = checkCoverage({ root, ...base });

    expect(result.message).toContain("symlink");
  });

  test("fails when coverage holds files tracked by git", () => {
    writeLcov(record("f/factory/lib/a.ts", hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTracked: () => ["coverage/lcov.info"],
    });

    expect(result.message).toContain("tracked");
  });

  test("fails when git cannot list the tracked files", () => {
    writeLcov(record("f/factory/lib/a.ts", hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTracked: () => {
        throw new Error("git failed");
      },
    });

    expect(result.message).toContain("git ls-files");
  });
});

describe("checkCoverage with the target listing", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-coverage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeLcov(text: string): void {
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(join(root, "coverage", "lcov.info"), text);
  }

  const base: Omit<CheckCoverageOptions, "root"> = {
    listTracked: () => [],
    layerFloors: [],
    notLoadable: [],
  };
  const A = "f/factory/lib/a.ts";

  test("fails when a target has no record in lcov", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A, "scripts/never_loaded.ts"]),
      floorPercent: 0,
    });

    expect(result.ok).toBe(false);
  });

  test("names the target that has no record in lcov", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A, "scripts/never_loaded.ts"]),
      floorPercent: 0,
    });

    expect(result.message).toContain("scripts/never_loaded.ts");
  });

  test("counts a loaded target that has no executable line as loaded", () => {
    writeLcov(
      [record(A, hitsOf(10, 10)), record("scripts/types.ts", [])].join("\n"),
    );

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A, "scripts/types.ts"]),
      floorPercent: 0,
    });

    expect(result.ok).toBe(true);
  });

  test("asks for the listing with untracked files", () => {
    writeLcov(record(A, hitsOf(10, 10)));
    const seen: boolean[] = [];

    checkCoverage({
      root,
      ...base,
      listTargets: (_root, options) => {
        seen.push(options.includeUntracked);
        return { targets: [A], malformed: [] };
      },
      floorPercent: 0,
    });

    expect(seen).toEqual([true]);
  });

  test("leaves a file that lcov has but the listing lacks out of the totals", () => {
    writeLcov(
      [
        record(A, hitsOf(10, 10)),
        record("f/factory/lib/ignored.ts", hitsOf(1000, 0)),
      ].join("\n"),
    );

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A]),
      floorPercent: 100,
    });

    expect(result.ok).toBe(true);
  });

  test("fails when no target is listed", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([]),
      floorPercent: 0,
    });

    expect(result.message).toContain("no target");
  });

  test("fails when the listing fails", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: () => {
        throw new Error("fatal: secret stderr text");
      },
    });

    expect(result.message).toContain("git ls-files");
  });

  test("keeps the standard error of git out of the failure", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: () => {
        throw new Error("fatal: secret stderr text");
      },
    });

    expect(result.message).not.toContain("secret");
  });

  describe("when a target path cannot be examined", () => {
    function loopListing(): (
      root: string,
      options: ListTargetsOptions,
    ) => TargetListing {
      mkdirSync(join(root, "f/factory/loop"), { recursive: true });
      symlinkSync("self", join(root, "f/factory/loop/self"));
      return (dir, options) =>
        listTargetFiles(dir, options, () => "f/factory/loop/self/a.ts\0");
    }

    test("names the error code", () => {
      writeLcov(record(A, hitsOf(10, 10)));

      const result = checkCoverage({
        root,
        ...base,
        listTargets: loopListing(),
      });

      expect(result.message).toContain("(ELOOP)");
    });

    test("keeps the path out of the failure", () => {
      writeLcov(record(A, hitsOf(10, 10)));

      const result = checkCoverage({
        root,
        ...base,
        listTargets: loopListing(),
      });

      expect(result.message).not.toContain("loop");
    });

    test("does not call it a failure of git", () => {
      writeLcov(record(A, hitsOf(10, 10)));

      const result = checkCoverage({
        root,
        ...base,
        listTargets: loopListing(),
      });

      expect(result.message).not.toContain("git ls-files");
    });
  });

  test("does not call a failure of git a failure of a target path", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: () => {
        throw new Error("git exited with code 128");
      },
    });

    expect(result.message).not.toContain("target path");
  });

  test("escapes characters outside ASCII in a malformed name", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A], ["scripts/\u0085\u202e\u2028\u007f\u65e5.ts"]),
      floorPercent: 0,
    });

    expect(/[^\x20-\x7e\n]/.test(result.message)).toBe(false);
  });

  test("shows a malformed name with its characters escaped as code units", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A], ["scripts/\u202ex.ts"]),
      floorPercent: 0,
    });

    expect(result.message).toContain('"scripts/\\u202ex.ts"');
  });

  test("fails when a tracked name uses a character outside the allowed set", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A], ["scripts/bad name.ts"]),
      floorPercent: 0,
    });

    expect(result.message).toContain("1 target file names");
  });

  test("escapes control characters in a malformed name", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A], ["scripts/\u001b[2Jx.ts"]),
      floorPercent: 0,
    });

    expect(result.message).not.toContain("\u001b");
  });

  test("shows the escaped malformed name", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A], ["scripts/\u001b[2Jx.ts"]),
      floorPercent: 0,
    });

    expect(result.message).toContain(JSON.stringify("scripts/\u001b[2Jx.ts"));
  });

  test("shows at most five malformed names", () => {
    writeLcov(record(A, hitsOf(10, 10)));
    const malformed = Array.from(
      { length: 8 },
      (_, i) => `scripts/bad ${i}.ts`,
    );

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A], malformed),
      floorPercent: 0,
    });

    expect(result.message.match(/scripts\/bad \d\.ts/g)).toHaveLength(5);
  });

  test("keeps a malformed-name failure inside the tail the repair prompt keeps", () => {
    writeLcov(record(A, hitsOf(10, 10)));
    const malformed = Array.from(
      { length: 8 },
      (_, i) => `scripts/${"long ".repeat(120)}${i}.ts`,
    );

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A], malformed),
      floorPercent: 0,
    });

    expect(result.message.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
  });

  test("fails when a layer is below its floor although the total meets it", () => {
    writeLcov(
      [
        record(A, hitsOf(1000, 1000)),
        record("scripts/s.ts", hitsOf(10, 0)),
      ].join("\n"),
    );

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A, "scripts/s.ts"]),
      layerFloors: [
        { layer: "f/factory/lib", floorPercent: 90 },
        { layer: "scripts", floorPercent: 50 },
      ],
      floorPercent: 80,
    });

    expect(result.message).toContain("scripts is below its floor");
  });

  test("applies the layer floors of the repository by default", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      listTracked: () => [],
      listTargets: listing([A]),
      notLoadable: [],
      floorPercent: 0,
    });

    expect(result.message).toContain("no target file in layer scripts");
  });

  test("states the ratio and floor of every layer on success", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A]),
      layerFloors: [{ layer: "f/factory/lib", floorPercent: 90 }],
      floorPercent: 80,
    });

    expect(result.message).toContain("f/factory/lib: 100.00%");
  });
});

describe("checkCoverage with the not loadable list", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-coverage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeLcov(text: string): void {
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(join(root, "coverage", "lcov.info"), text);
  }

  const base: Omit<CheckCoverageOptions, "root"> = {
    listTracked: () => [],
    layerFloors: [],
    floorPercent: 0,
  };
  const A = "f/factory/lib/a.ts";
  const DB = "scripts/test-db-x.ts";

  test("does not flag a listed file as unloaded", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A, DB]),
      notLoadable: [DB],
    });

    expect(result.ok).toBe(true);
  });

  test("fails when a listed path is not among the targets", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A]),
      notLoadable: [DB],
    });

    expect(result.message).toContain("not among the target files");
  });

  test("fails when a listed path appears in lcov", () => {
    writeLcov([record(A, hitsOf(10, 10)), record(DB, hitsOf(5, 5))].join("\n"));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A, DB]),
      notLoadable: [DB],
    });

    expect(result.message).toContain("is in lcov");
  });

  test("fails when a listed path is not of the scripts/test-db- form", () => {
    writeLcov(record(A, hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      ...base,
      listTargets: listing([A, "f/factory/lib/b.ts"]),
      notLoadable: ["f/factory/lib/b.ts"],
    });

    expect(result.message).toContain("allowed form");
  });
});

/** 変更した行を作る。`lines`はパスごとの行番号の並びで、`wholeFiles`は追跡していない新しいファイル。 */
function changedOf(
  lines: Readonly<Record<string, readonly number[]>>,
  wholeFiles: readonly string[] = [],
): ChangedLines {
  return {
    lines: new Map(
      Object.entries(lines).map(([path, numbers]) => [path, new Set(numbers)]),
    ),
    wholeFiles,
  };
}

describe("parseDiffAddedLines", () => {
  test("reads the new lines of a hunk", () => {
    const diff = [
      "diff --git a/f/factory/lib/a.ts b/f/factory/lib/a.ts",
      "--- a/f/factory/lib/a.ts",
      "+++ b/f/factory/lib/a.ts",
      "@@ -3,0 +4,2 @@",
      "+const a = 1;",
      "+const b = 2;",
    ].join("\n");

    const result = parseDiffAddedLines(diff);

    expect([...(result.get("f/factory/lib/a.ts") ?? [])]).toEqual([4, 5]);
  });

  test("reads a hunk whose new side has no count as one line", () => {
    const diff = [
      "--- a/f/factory/lib/a.ts",
      "+++ b/f/factory/lib/a.ts",
      "@@ -7 +7 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");

    const result = parseDiffAddedLines(diff);

    expect([...(result.get("f/factory/lib/a.ts") ?? [])]).toEqual([7]);
  });

  test("adds no line for a hunk that only deletes", () => {
    const diff = [
      "--- a/f/factory/lib/a.ts",
      "+++ b/f/factory/lib/a.ts",
      "@@ -7,2 +6,0 @@",
      "-const a = 1;",
      "-const b = 2;",
    ].join("\n");

    const result = parseDiffAddedLines(diff);

    expect(result.get("f/factory/lib/a.ts")?.size ?? 0).toBe(0);
  });

  test("leaves out a deleted file", () => {
    const diff = [
      "--- a/f/factory/lib/a.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-const a = 1;",
    ].join("\n");

    const result = parseDiffAddedLines(diff);

    expect(result.has("f/factory/lib/a.ts")).toBe(false);
  });

  test("reads the hunks of several files", () => {
    const diff = [
      "--- a/f/factory/lib/a.ts",
      "+++ b/f/factory/lib/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "--- a/f/factory/lib/b.ts",
      "+++ b/f/factory/lib/b.ts",
      "@@ -2,0 +3 @@",
      "+z",
    ].join("\n");

    const result = parseDiffAddedLines(diff);

    expect([...result.keys()]).toEqual([
      "f/factory/lib/a.ts",
      "f/factory/lib/b.ts",
    ]);
  });

  test("does not take an added line that looks like a file header for a header", () => {
    const diff = [
      "--- a/f/factory/lib/a.ts",
      "+++ b/f/factory/lib/a.ts",
      "@@ -1,0 +2,2 @@",
      "+++ b/f/factory/lib/other.ts",
      "+@@ -1 +1,5 @@",
    ].join("\n");

    const result = parseDiffAddedLines(diff);

    expect([...result.keys()]).toEqual(["f/factory/lib/a.ts"]);
  });

  test("throws on a file header it does not know", () => {
    const diff = ["--- a/f/factory/lib/a.ts", "+++ c/f/factory/lib/a.ts"].join(
      "\n",
    );

    expect(() => parseDiffAddedLines(diff)).toThrow();
  });

  test("throws on a line in a hunk that is not an added, removed, or context line", () => {
    const diff = [
      "--- a/f/factory/lib/a.ts",
      "+++ b/f/factory/lib/a.ts",
      "@@ -1 +1 @@",
      "?const a = 1;",
    ].join("\n");

    expect(() => parseDiffAddedLines(diff)).toThrow();
  });

  test("counts only the added lines of a hunk with context lines", () => {
    const diff = [
      "--- a/f/factory/lib/a.ts",
      "+++ b/f/factory/lib/a.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
    ].join("\n");

    const result = parseDiffAddedLines(diff);

    expect([...(result.get("f/factory/lib/a.ts") ?? [])]).toEqual([2]);
  });

  test("skips the no-newline marker in a hunk", () => {
    const diff = [
      "--- a/f/factory/lib/a.ts",
      "+++ b/f/factory/lib/a.ts",
      "@@ -2 +2,2 @@",
      "-a2",
      "\\ No newline at end of file",
      "+b2",
      "+b3",
    ].join("\n");

    const result = parseDiffAddedLines(diff);

    expect([...(result.get("f/factory/lib/a.ts") ?? [])]).toEqual([2, 3]);
  });
});

describe("judgeDiffCoverage", () => {
  const A = "f/factory/lib/a.ts";
  const B = "f/factory/lib/b.ts";

  test("passes when no changed line is executable", () => {
    const lcov = record(A, [[10, 0]]);

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [1, 2] }));

    expect(result.ok).toBe(true);
  });

  test("says that no changed line is executable", () => {
    const lcov = record(A, [[10, 0]]);

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [1, 2] }));

    expect(result.message).toContain("no changed executable line");
  });

  test("passes when the changed lines meet the floor exactly", () => {
    const lcov = record(A, hitsOf(10, 9));

    const result = judgeDiffCoverage(
      lcov,
      changedOf({ [A]: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }),
    );

    expect(result.ok).toBe(true);
  });

  test("fails when the changed lines are below the floor", () => {
    const lcov = record(A, hitsOf(10, 9));

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [9, 10] }));

    expect(result.ok).toBe(false);
  });

  test("states the ratio and floor of the changed lines", () => {
    const lcov = record(A, hitsOf(10, 9));

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [9, 10] }));

    expect(result.message).toContain(
      "50.00% (1 of 2 changed lines in 1 files), floor 90.00%",
    );
  });

  test("counts only the changed lines, not the whole file", () => {
    const lcov = record(A, hitsOf(10, 2));

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [1, 2] }));

    expect(result.ok).toBe(true);
  });

  test("leaves a path outside the diff layers out", () => {
    const lcov = record("f/factory/steps/s.ts", hitsOf(10, 0));

    const result = judgeDiffCoverage(
      lcov,
      changedOf({ "f/factory/steps/s.ts": [1, 2, 3] }),
    );

    expect(result.ok).toBe(true);
  });

  test("leaves a test file out", () => {
    const lcov = record("f/factory/lib/a.test.ts", hitsOf(10, 0));

    const result = judgeDiffCoverage(
      lcov,
      changedOf({ "f/factory/lib/a.test.ts": [1, 2, 3] }),
    );

    expect(result.ok).toBe(true);
  });

  test("counts every executable line of an untracked file", () => {
    const lcov = record(A, hitsOf(10, 5));

    const result = judgeDiffCoverage(lcov, changedOf({}, [A]));

    expect(result.message).toContain("5 of 10 changed lines");
  });

  test("counts a line once when the same file appears twice in lcov", () => {
    const lcov = [
      record(A, [
        [1, 0],
        [2, 1],
      ]),
      record(A, [
        [1, 1],
        [2, 0],
      ]),
    ].join("\n");

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [1, 2] }));

    expect(result.message).toContain("2 of 2 changed lines");
  });

  test("names the unexecuted changed lines as ranges", () => {
    const lcov = record(A, hitsOf(10, 0));

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [2, 3, 4, 7] }));

    expect(result.message).toContain(`${A}: lines 2-4, 7`);
  });

  test("lists the file with the most unexecuted changed lines first", () => {
    const lcov = [record(A, hitsOf(10, 0)), record(B, hitsOf(10, 0))].join(
      "\n",
    );

    const result = judgeDiffCoverage(
      lcov,
      changedOf({ [A]: [1], [B]: [1, 2] }),
    );

    expect(result.message.indexOf(B)).toBeLessThan(result.message.indexOf(A));
  });

  test("ends with the reason", () => {
    const lcov = record(A, hitsOf(10, 0));

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [1] }));

    expect(result.message.split("\n").at(-1)).toContain(
      "changed lines are below the floor",
    );
  });

  /** 長い名前の40ファイルで、奇数の行を変えて実行しなかった、出力の長い入力。 */
  function manyUnexecutedFiles(): {
    readonly lcov: string;
    readonly changed: ChangedLines;
  } {
    const paths = Array.from(
      { length: 40 },
      (_, index) => `f/factory/lib/${"x".repeat(60)}${index}.ts`,
    );
    const odd = Array.from({ length: 200 }, (_, index) => index * 2 + 1);
    return {
      lcov: paths.map((path) => record(path, hitsOf(400, 0))).join("\n"),
      changed: changedOf(Object.fromEntries(paths.map((path) => [path, odd]))),
    };
  }

  test("fits in the tail the repair prompt keeps", () => {
    const { lcov, changed } = manyUnexecutedFiles();

    const result = judgeDiffCoverage(lcov, changed);

    expect(result.message.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
  });

  test("keeps the reason when the rows are cut", () => {
    const { lcov, changed } = manyUnexecutedFiles();

    const result = judgeDiffCoverage(lcov, changed);

    expect(result.message).toContain("changed lines are below the floor");
  });

  test("uses the floor that is given", () => {
    const lcov = record(A, hitsOf(10, 0));

    const result = judgeDiffCoverage(lcov, changedOf({ [A]: [1] }), {
      floorPercent: 0,
    });

    expect(result.ok).toBe(true);
  });
});

describe("DIFF_COVERAGE_PATHS", () => {
  test("holds the decision layer", () => {
    expect(DIFF_COVERAGE_PATHS).toEqual(["f/factory/lib"]);
  });
});

describe("DIFF_COVERAGE_FLOOR_PERCENT", () => {
  test("is 90", () => {
    expect(DIFF_COVERAGE_FLOOR_PERCENT).toBe(90);
  });
});

describe("diffArgv", () => {
  test("diffs the working tree against the base without renames, colors, or external tools", () => {
    expect(diffArgv("0123abcd", ["f/factory/lib"])).toEqual([
      "git",
      "diff",
      "-U0",
      "--text",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--inter-hunk-context=0",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "0123abcd",
      "--",
      "f/factory/lib",
    ]);
  });
});

describe("checkDiffCoverage", () => {
  const A = "f/factory/lib/a.ts";

  test("passes when the changed lines meet the floor", () => {
    const result = checkDiffCoverage({
      root: "/unused",
      lcovText: record(A, hitsOf(10, 10)),
      listChanged: () => changedOf({ [A]: [1, 2] }),
    });

    expect(result.ok).toBe(true);
  });

  test("fails when the changed lines are below the floor", () => {
    const result = checkDiffCoverage({
      root: "/unused",
      lcovText: record(A, hitsOf(10, 0)),
      listChanged: () => changedOf({ [A]: [1, 2] }),
    });

    expect(result.ok).toBe(false);
  });

  test("fails when the changed lines cannot be listed", () => {
    const result = checkDiffCoverage({
      root: "/unused",
      lcovText: record(A, hitsOf(10, 10)),
      listChanged: () => {
        throw new Error("fatal: Not a valid object name origin/main");
      },
    });

    expect(result.ok).toBe(false);
  });

  test("keeps the standard error of git out of the failure", () => {
    const result = checkDiffCoverage({
      root: "/unused",
      lcovText: record(A, hitsOf(10, 10)),
      listChanged: () => {
        throw new Error("fatal: Not a valid object name origin/main");
      },
    });

    expect(result.message).not.toContain("fatal");
  });

  test("tells how to fetch origin/main again on failure", () => {
    const result = checkDiffCoverage({
      root: "/unused",
      lcovText: record(A, hitsOf(10, 10)),
      listChanged: () => {
        throw new Error("fatal: Not a valid object name origin/main");
      },
    });

    expect(result.message).toContain("git fetch --unshallow origin main");
  });
});

describe("runCoverageChecks", () => {
  const A = "f/factory/lib/a.ts";
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-coverage-main-"));
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "lcov.info"),
      record(A, hitsOf(10, 5)),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const total: Omit<CheckCoverageOptions, "root"> = {
    listTracked: () => [],
    listTargets: listing([A]),
    layerFloors: [],
    notLoadable: [],
  };

  test("exits with 1 and writes the diff failure to stderr when only the diff check fails", () => {
    const result = runCoverageChecks({
      root,
      ...total,
      floorPercent: 0,
      listChanged: () => changedOf({ [A]: [9, 10] }),
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: [expect.stringContaining("line coverage 50.00%")],
      stderr: [expect.stringContaining("diff coverage check failed")],
    });
  });

  test("does not list the changed lines when the total check fails", () => {
    let listed = false;

    const result = runCoverageChecks({
      root,
      ...total,
      floorPercent: 90,
      listChanged: () => {
        listed = true;
        return changedOf({});
      },
    });

    expect({ exitCode: result.exitCode, listed }).toEqual({
      exitCode: 1,
      listed: false,
    });
  });

  test("exits with 0 and writes both results to stdout when both checks pass", () => {
    const result = runCoverageChecks({
      root,
      ...total,
      floorPercent: 0,
      listChanged: () => changedOf({ [A]: [1, 2] }),
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        expect.stringContaining("line coverage 50.00%"),
        expect.stringContaining("diff line coverage of f/factory/lib: 100.00%"),
      ],
      stderr: [],
    });
  });
});

describe("listChangedLines in a temporary repository", () => {
  let repo = "";
  // origin/mainを持たないリポジトリ。
  let bare = "";
  // `origin/main`という名前のタグが、追跡refと別のcommitを指すリポジトリ。
  let tagged = "";

  // gitのフックの中で走ると、親のリポジトリを指す`GIT_*`が環境に残る。一時リポジトリには引き継がない。
  function git(cwd: string, args: readonly string[]): string {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: { ...env, HOME: cwd },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed`);
    }
    return result.stdout.toString();
  }

  function writeIn(dir: string, path: string, text: string): void {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  function write(path: string, text: string): void {
    writeIn(repo, path, text);
  }

  function commit(dir: string): void {
    git(dir, ["add", "-A"]);
    git(dir, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "-m",
      "c",
    ]);
  }

  const run = (argv: readonly string[], cwd: string): string =>
    git(cwd, argv.slice(1));

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "check-diff-coverage-repo-"));
    git(repo, ["init", "-q"]);
    write("f/factory/lib/a.ts", "a1\na2\na3\n");
    write("f/factory/steps/s.ts", "s1\n");
    write("f/factory/lib/bin.ts", "b1\0\nb2\n");
    write("f/factory/lib/nonl.ts", "n1\nn2");
    commit(repo);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    write("f/factory/lib/a.ts", "a1\nchanged\na3\nadded\n");
    write("f/factory/steps/s.ts", "s1\nchanged\n");
    write("f/factory/lib/new.ts", "n1\n");
    write("f/factory/lib/bin.ts", "b1\0\nchanged\n");
    write("f/factory/lib/nonl.ts", "n1\nchanged");
    bare = mkdtempSync(join(tmpdir(), "check-diff-coverage-bare-"));
    git(bare, ["init", "-q"]);

    tagged = mkdtempSync(join(tmpdir(), "check-diff-coverage-tagged-"));
    git(tagged, ["init", "-q"]);
    writeIn(tagged, "f/factory/lib/a.ts", "a1\na2\n");
    commit(tagged);
    git(tagged, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    writeIn(tagged, "f/factory/lib/a.ts", "a1\nchanged\n");
    commit(tagged);
    git(tagged, ["tag", "origin/main", "HEAD"]);
  });

  afterAll(() => {
    if (repo !== "") rmSync(repo, { recursive: true, force: true });
    if (bare !== "") rmSync(bare, { recursive: true, force: true });
    if (tagged !== "") rmSync(tagged, { recursive: true, force: true });
  });

  test("counts the changed lines of a file that git takes for binary", () => {
    const result = listChangedLines(repo, DIFF_COVERAGE_PATHS, run);

    expect([...(result.lines.get("f/factory/lib/bin.ts") ?? [])]).toEqual([2]);
  });

  test("counts the changed last line of a file without a final newline", () => {
    const result = listChangedLines(repo, DIFF_COVERAGE_PATHS, run);

    expect([...(result.lines.get("f/factory/lib/nonl.ts") ?? [])]).toEqual([2]);
  });

  test("takes the base from the tracking ref, not from a tag of the same name", () => {
    const result = listChangedLines(tagged, DIFF_COVERAGE_PATHS, run);

    expect([...(result.lines.get("f/factory/lib/a.ts") ?? [])]).toEqual([2]);
  });

  test("lists the lines changed in the working tree since origin/main", () => {
    const result = listChangedLines(repo, DIFF_COVERAGE_PATHS, run);

    expect([...(result.lines.get("f/factory/lib/a.ts") ?? [])]).toEqual([2, 4]);
  });

  test("leaves out a path outside the diff layers", () => {
    const result = listChangedLines(repo, DIFF_COVERAGE_PATHS, run);

    expect(result.lines.has("f/factory/steps/s.ts")).toBe(false);
  });

  test("lists an untracked file as a whole file", () => {
    const result = listChangedLines(repo, DIFF_COVERAGE_PATHS, run);

    expect(result.wholeFiles).toEqual(["f/factory/lib/new.ts"]);
  });

  test("throws when origin/main does not exist", () => {
    expect(() => listChangedLines(bare, DIFF_COVERAGE_PATHS, run)).toThrow();
  });
});
