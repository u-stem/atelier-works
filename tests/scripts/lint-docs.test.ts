import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blankFrontmatter,
  buildPlan,
  coversTargets,
  createProductionDeps,
  isTargetDoc,
  type LintDeps,
  lintDocText,
  lintWithTools,
  MARKDOWNLINT_BIN,
  type Spawned,
  shardCount,
  splitIntoShards,
  TEXTLINT_BIN,
  toToolPath,
} from "../../scripts/lint-docs.ts";

const NINE_TARGETS = Array.from({ length: 9 }, (_, i) => `docs/f${i}.md`);

describe("isTargetDoc", () => {
  test.each([
    ["README.md", true],
    ["docs/operations.md", true],
    [".claude/skills/factory-fix/SKILL.md", true],
    [".claude/skills/windmill-script/SKILL.md", true],
    [".claude/skills/review-loop/SKILL.md", true],
    [".claude/skills/hold/SKILL.md", true],
    [".claude/agents/implementer.md", true],
    [".claude/agents/notes/draft.md", false],
    [".claude/skills/factory-requirements/template.md", false],
    [".claude/skills/write-script-bun/SKILL.md", false],
    [".claude/skills/yomiyasu/SKILL.md", false],
    [".agents/skills/write-flow/SKILL.md", false],
    ["AGENTS.wmill.md", false],
    ["tests/fixtures/audit/valid.md", false],
    ["docs/notes.txt", false],
  ])("%s -> %p", (path, expected) => {
    expect(isTargetDoc(path)).toBe(expected);
  });
});

describe("blankFrontmatter", () => {
  test("keeps the line count while blanking the frontmatter", () => {
    const result = blankFrontmatter("---\nname: a\n---\n# 本文\n");

    expect(result).toBe("\n\n\n# 本文\n");
  });
});

describe("lintDocText", () => {
  test("reports the path, line, and rule of each issue", () => {
    const problems = lintDocText("docs/a.md", "# 見出し\n\n再実行します。\n");

    expect(problems[0]).toStartWith("docs/a.md:3: [register] ");
  });
});

describe("toToolPath", () => {
  test("prefixes a relative path so that a leading dash is not read as an option", () => {
    expect(toToolPath("--fix.md")).toBe("./--fix.md");
  });

  test("leaves a path that already starts with ./ unchanged", () => {
    expect(toToolPath("./docs/a.md")).toBe("./docs/a.md");
  });

  test("leaves an absolute path unchanged", () => {
    expect(toToolPath("/repo/docs/a.md")).toBe("/repo/docs/a.md");
  });
});

describe("shardCount", () => {
  test("shardCount returns 1 up to the threshold", () => {
    expect([shardCount(8, 4), shardCount(3, 4), shardCount(0, 4)]).toEqual([
      1, 1, 1,
    ]);
  });

  test("shardCount is capped by cpus, 4 and file count", () => {
    expect([shardCount(9, 4), shardCount(9, 2), shardCount(20, 16)]).toEqual([
      4, 2, 4,
    ]);
  });

  test("shardCount falls back to 1 for an invalid cpu count", () => {
    expect([
      shardCount(9, 0),
      shardCount(9, Number.NaN),
      shardCount(9, 2.5),
    ]).toEqual([1, 1, 1]);
  });
});

describe("splitIntoShards", () => {
  test("puts every path in exactly one shard", () => {
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];

    const shards = splitIntoShards(paths, [5, 4, 3, 2, 1], 3);

    expect(shards.flat().sort()).toEqual(paths);
  });

  test("puts the largest file alone when it exceeds the rest", () => {
    const shards = splitIntoShards(
      ["a.md", "b.md", "c.md", "d.md"],
      [100, 30, 30, 30],
      2,
    );

    expect(shards).toEqual([["a.md"], ["b.md", "c.md", "d.md"]]);
  });

  test("never returns an empty shard", () => {
    const shards = splitIntoShards(["a.md", "b.md"], [1, 1], 5);

    expect(shards).toEqual([["a.md"], ["b.md"]]);
  });

  test("throws when count is below 1 or not an integer", () => {
    const split = (count: number) => () =>
      splitIntoShards(["a.md"], [1], count);

    expect(split(0)).toThrow();
    expect(split(-1)).toThrow();
    expect(split(1.5)).toThrow();
    expect(split(Number.NaN)).toThrow();
  });
});

describe("buildPlan", () => {
  test("passes every path through toToolPath", () => {
    const targets = ["--fix.md", "docs/a.md"];

    const plan = buildPlan(targets, [["--fix.md"], ["docs/a.md"]]);

    const args = plan.flatMap((argv) => argv.slice(1));
    expect({
      count: args.length,
      unprefixed: args.filter((arg) => !arg.startsWith("./")),
    }).toEqual({ count: 4, unprefixed: [] });
  });
});

describe("coversTargets", () => {
  const targets = ["a.md", "b.md", "c.md"];
  const full = buildPlan(targets, [["a.md", "b.md"], ["c.md"]]);

  test("coversTargets is false when a path is dropped or duplicated", () => {
    const droppedShard = full.filter((_, i) => i !== 2);
    const droppedFromMarkdownlint = full.map((argv) =>
      argv[0] === MARKDOWNLINT_BIN ? argv.slice(0, -1) : argv,
    );
    const duplicated = [...full, [TEXTLINT_BIN, "./c.md"]];

    expect([
      coversTargets(targets, droppedShard),
      coversTargets(targets, droppedFromMarkdownlint),
      coversTargets(targets, duplicated),
    ]).toEqual([false, false, false]);
  });

  test("coversTargets is true for a plan that covers every target once", () => {
    expect(coversTargets(targets, full)).toBe(true);
  });
});

type ChildSpec = {
  stdout?: string;
  exitCode?: number | null;
  signalCode?: string | null;
  gate?: Promise<void>;
  stdoutStream?: ReadableStream<Uint8Array>;
  throws?: boolean;
};

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function brokenStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("read failed"));
    },
  });
}

function fakeChild(spec: ChildSpec, onKill: () => void): Spawned {
  const { exitCode = 0, signalCode = null } = spec;
  return {
    stdout: spec.stdoutStream ?? textStream(spec.stdout ?? ""),
    stderr: textStream(""),
    exited: (spec.gate ?? Promise.resolve()).then(() => exitCode ?? 137),
    exitCode,
    signalCode,
    kill: onKill,
  };
}

function recorder(
  specFor: (index: number, argv: readonly string[]) => ChildSpec = () => ({}),
  overrides: Partial<LintDeps> = {},
) {
  const spawned: string[][] = [];
  const written: string[] = [];
  const killed: number[] = [];
  const deps: LintDeps = {
    spawn(argv) {
      const index = spawned.length;
      spawned.push([...argv]);
      const spec = specFor(index, argv);
      if (spec.throws === true) throw new Error("spawn failed");
      return fakeChild(spec, () => {
        killed.push(index);
      });
    },
    cpuCount: 4,
    sizeOf: () => 1,
    write: (text) => {
      written.push(text);
    },
    ...overrides,
  };
  return { deps, spawned, written, killed };
}

describe("lintWithTools", () => {
  test("fails before spawning when the plan does not cover the targets", async () => {
    const { deps, spawned } = recorder(undefined, {
      buildPlan: (targets, shards) =>
        buildPlan(targets, shards).filter((_, i) => i !== 1),
    });

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect({ ok, spawned: spawned.length }).toEqual({ ok: false, spawned: 0 });
  });

  test("starts no tool and succeeds when there are no targets", async () => {
    const { deps, spawned } = recorder();

    const ok = await lintWithTools([], deps);

    expect({ ok, spawned: spawned.length }).toEqual({ ok: true, spawned: 0 });
  });

  test("runs textlint once with every path when there are 8 or fewer targets", async () => {
    const targets = NINE_TARGETS.slice(0, 8);
    const { deps, spawned } = recorder();

    await lintWithTools(targets, deps);

    expect(spawned.filter((argv) => argv[0] === TEXTLINT_BIN)).toEqual([
      [TEXTLINT_BIN, ...targets.map(toToolPath)],
    ]);
  });

  test("starts markdownlint once with every path", async () => {
    const { deps, spawned } = recorder();

    await lintWithTools(NINE_TARGETS, deps);

    expect(spawned.filter((argv) => argv[0] === MARKDOWNLINT_BIN)).toEqual([
      [MARKDOWNLINT_BIN, ...NINE_TARGETS.map(toToolPath)],
    ]);
  });

  test("succeeds when every shard exits with code 0", async () => {
    const { deps } = recorder();

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect(ok).toBe(true);
  });

  test("fails when one shard exits with a non-zero code", async () => {
    const { deps } = recorder((index) => (index === 2 ? { exitCode: 1 } : {}));

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect(ok).toBe(false);
  });

  test("fails when a shard is killed by a signal", async () => {
    const { deps } = recorder((index) =>
      index === 3 ? { exitCode: null, signalCode: "SIGKILL" } : {},
    );

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect(ok).toBe(false);
  });

  test("fails when reading a shard output rejects", async () => {
    const { deps } = recorder((index) =>
      index === 1 ? { stdoutStream: brokenStream() } : {},
    );

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect(ok).toBe(false);
  });

  test("fails and stops started children when spawn throws", async () => {
    const { deps, killed } = recorder((index) =>
      index === 2 ? { throws: true } : {},
    );

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect({ ok, killed }).toEqual({ ok: false, killed: [0, 1] });
  });

  test("writes shard outputs in plan order as they finish", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, written } = recorder((index) => ({
      stdout: `out${index};`,
      ...(index === 1 ? { gate } : {}),
    }));

    const running = lintWithTools(NINE_TARGETS, deps);
    await Bun.sleep(20);
    const beforeRelease = [...written];
    release();
    await running;

    expect({ beforeRelease, written }).toEqual({
      beforeRelease: ["out0;"],
      written: ["out0;", "out1;", "out2;", "out3;", "out4;"],
    });
  });
});

describe("lintWithTools with the real textlint", () => {
  test("inspects every file when sharded", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "lint-docs-"));
    try {
      const paths = NINE_TARGETS.map((_, i) => join(dir, `f${i}.md`));
      for (const path of paths) {
        writeFileSync(path, "# 見出し\n\n再実行します。\n");
      }
      const output: string[] = [];
      const deps: LintDeps = {
        ...createProductionDeps(),
        cpuCount: 4,
        write: (text) => {
          output.push(text);
        },
      };

      const ok = await lintWithTools(paths, deps);

      const text = output.join("");
      expect({
        ok,
        missing: paths.filter((path) => !text.includes(path)),
      }).toEqual({ ok: false, missing: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
