// 隔離の観測を行うscriptの手順を固定する。
// 保護パスに置く。観測の結果に秘密を載せる変更や、後始末を省く変更が、このテストを書き換えて通らないようにするため。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  main,
  type ProbeDeps,
  runIsolationProbe,
} from "../../f/factory/investigate_isolation_probe.ts";
import { mainRepoDir } from "../../f/factory/lib/cleanup_support.ts";
import type {
  IsolationProbeClaudeOptions,
  IsolationProbeRunResult,
} from "../../f/factory/lib/investigate_claude.ts";
import {
  computeArgvShapeHash,
  ISOLATION_FINGERPRINT,
  PROBE_JUDGE_VERSION,
} from "../../f/factory/lib/investigate_isolation.ts";
import { judgeProbe } from "../../f/factory/lib/investigate_isolation_judge.ts";
import {
  investigateWorktreeDir,
  PROBE_RESERVED_ID,
} from "../../f/factory/lib/investigate_workspace.ts";
import type { CommandRunner } from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, ok } from "../lib/testSupport.ts";

const GH_TOKEN = "ghp_PROBE_TEST_GITHUB_TOKEN_0123456789";
const OAUTH_TOKEN = "sk-ant-oat-PROBE-TEST-OAUTH-0123456789";
const CLAUDE_VERSION = "2.1.999";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = join(
  import.meta.dir,
  "../../f/factory/investigate_isolation_probe.ts",
);
const YAML = join(
  import.meta.dir,
  "../../f/factory/investigate_isolation_probe.script.yaml",
);

type Line = Record<string, unknown>;

function useLine(id: string, name: string, input: unknown): Line {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function resultLine(id: string, content: string, isError: boolean): Line {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content, is_error: isError },
      ],
    },
  };
}

type Pair = IsolationProbeClaudeOptions["pairs"][number];

const GREP_PATTERN = "FACTORY_PROBE_CANARY_[0-9a-f]{32}";

/** 組と完全に一致する入力。 */
function exactInput(pair: Pair): Record<string, string> {
  if (pair.tool === "Read") return { file_path: pair.path };
  if (pair.tool === "Glob") return { pattern: "*", path: pair.path };
  return { pattern: GREP_PATTERN, path: pair.path, output_mode: "content" };
}

function useOf(id: string, pair: Pair): Line {
  return useLine(id, pair.tool, exactInput(pair));
}

function firstPair(opts: IsolationProbeClaudeOptions): Pair {
  const pair = opts.pairs[0];
  if (pair === undefined) throw new Error("the run has no pair");
  return pair;
}

/** 組が指す目印のファイル。`Glob`と`Grep`の組は、目印のディレクトリを指す。 */
function canaryFileOf(pair: Pair): string {
  return pair.tool === "Read" ? pair.path : join(pair.path, "canary.txt");
}

function canaryDirOf(pair: Pair): string {
  return pair.tool === "Read" ? join(pair.path, "..") : pair.path;
}

function deniedLines(pair: Pair): Line[] {
  return [
    useOf("t1", pair),
    resultLine("t1", "Permission to read the file was denied", true),
    useLine("t2", "StructuredOutput", { attempted: true }),
    resultLine("t2", "accepted", false),
  ];
}

/** 拒否の文言。`--restricted`が、作業ディレクトリの外のパスに返す。 */
function refusalText(path: string): string {
  return `${path} is outside ${investigateWorktreeDir(PROBE_RESERVED_ID)}; --restricted confines the file tools to the working directory.`;
}

/** 作業ディレクトリの中で成功した結果の本文。 */
function successText(pair: Pair, canaryText: string): string {
  if (pair.tool === "Read") return canaryText;
  if (pair.tool === "Glob") return join(pair.path, "canary.txt");
  return `${join(pair.path, "canary.txt")}:${canaryText}`;
}

function sessionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

type Script = {
  readonly result?: Partial<IsolationProbeRunResult>;
  readonly sessions?: readonly {
    readonly id: string;
    readonly lines: readonly Line[] | string;
  }[];
};

type ClaudeCall = {
  readonly opts: IsolationProbeClaudeOptions;
  /** 呼ばれた時点のcanaryのファイルの本文。 */
  readonly canaryText: string | null;
  readonly canaryDirMode: number | null;
  readonly previousTranscriptExists: boolean;
};

describe("investigate_isolation_probe", () => {
  let root: string;
  let calls: ClaudeCall[];
  let worktree: { created: number; purged: number; shas: string[] };
  let logs: string[];
  let seed: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "isolation-probe-script-"));
    for (const name of ["run", "tmp", "home", "cwd"]) {
      await mkdir(join(root, name), { mode: 0o700 });
    }
    calls = [];
    worktree = { created: 0, purged: 0, shas: [] };
    logs = [];
    seed = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function configDir(): string {
    return join(root, "cfg");
  }

  /** 偽のworktreeの場所。目印はここにも置かれる。 */
  function cwdDir(): string {
    return join(root, "cwd");
  }

  /** 4つの親の直下に残っている、probeのcanaryの名前の形の項目。 */
  function probeDirs(): string[] {
    return ["run", "tmp", "home", "cwd"].flatMap((name) =>
      readdirSync(join(root, name)).filter((entry) =>
        entry.startsWith(".factory-probe-"),
      ),
    );
  }

  function transcriptPath(session: string): string {
    return join(configDir(), "projects", "-project", `${session}.jsonl`);
  }

  /** 各呼び出しで、台本どおりにtranscriptを書いて結果を返す偽の`runClaude`。 */
  function fakeClaude(
    handler?: (index: number, opts: IsolationProbeClaudeOptions) => Script,
  ): ProbeDeps["runClaude"] {
    return async (opts) => {
      const index = calls.length + 1;
      const pair = firstPair(opts);
      let canaryText: string | null = null;
      try {
        canaryText = await readFile(canaryFileOf(pair), "utf8");
      } catch {
        canaryText = null;
      }
      let canaryDirMode: number | null = null;
      try {
        canaryDirMode = (await stat(canaryDirOf(pair))).mode & 0o777;
      } catch {
        canaryDirMode = null;
      }
      const previous = index > 1 ? sessionId(index - 1) : null;
      calls.push({
        opts,
        canaryText,
        canaryDirMode,
        previousTranscriptExists:
          previous !== null && existsSync(transcriptPath(previous)),
      });
      const script: Script = handler?.(index, opts) ?? {
        sessions: [{ id: sessionId(index), lines: deniedLines(pair) }],
      };
      for (const session of script.sessions ?? []) {
        const file = transcriptPath(session.id);
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(
          file,
          typeof session.lines === "string"
            ? session.lines
            : `${session.lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        );
      }
      const ids = (script.sessions ?? []).map((session) => session.id);
      return {
        outcome: "success",
        reason: null,
        retried: false,
        sessionIds: ids.length === 0 ? [null] : ids.slice(-1),
        numTurns: 2,
        durationMs: 100,
        topLevelKeys: ["session_id", "type"],
        ...script.result,
      };
    };
  }

  function makeDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
    const run: CommandRunner = createFakeCommandRunner([
      ok(`${CLAUDE_VERSION} (Claude Code)\n`),
    ]).run;
    return {
      run,
      config: {
        factory_repo: "https://github.com/example-owner/example-repo",
        model: "model-default",
        heavy_model: "model-heavy",
      },
      ghToken: GH_TOKEN,
      oauthToken: OAUTH_TOKEN,
      claudeVersion: CLAUDE_VERSION,
      path: "/usr/bin",
      home: join(root, "home"),
      prefixes: {
        run_factory_tmp: join(root, "run"),
        tmp: join(root, "tmp"),
        home: join(root, "home"),
      },
      claudeConfigDir: configDir(),
      expectedUid: process.getuid?.() ?? 0,
      randomHex: () => {
        seed += 1;
        return seed.toString(16).padStart(32, "0");
      },
      now: () => new Date("2026-11-03T00:00:00.000Z"),
      workspace: {
        ensureRoot: async () => {},
        repoExists: async () => true,
        resolveHeadSha: async () => SHA,
        purge: async () => {
          worktree.purged += 1;
        },
        createWorktree: async (input) => {
          worktree.created += 1;
          worktree.shas.push(input.sha);
          return { dir: cwdDir() };
        },
      },
      hasActiveInvestigation: async () => false,
      runClaude: fakeClaude(),
      rm: (path) => rm(path, { recursive: true, force: true }),
      log: (message) => {
        logs.push(message);
      },
      ...overrides,
    };
  }

  /** 外の置き場の読み出しがすべて拒否され、作業ディレクトリの中では成功する台本。 */
  function passingClaude(): ProbeDeps["runClaude"] {
    return fakeClaude((index, opts) => {
      const pair = firstPair(opts);
      const inside = pair.path.startsWith(cwdDir());
      const canaryText = calls[index - 1]?.canaryText ?? "";
      const body = inside
        ? successText(pair, canaryText)
        : refusalText(pair.path);
      return {
        sessions: [
          {
            id: sessionId(index),
            lines: [
              useOf("t1", pair),
              resultLine("t1", body, !inside),
              useLine("t2", "StructuredOutput", { attempted: true }),
              resultLine("t2", "accepted", false),
            ],
          },
        ],
      };
    });
  }

  describe("the result", () => {
    test("has no field that marks an observation only", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect("observationOnly" in result).toBe(false);
    });

    // 設定の置き場を`/run/factory-tmp`の下にすると、transcriptも同じ場所から読むため、テストでは作れない。
    // そのため、設定の置き場の形の失敗だけが残ることを確かめる。全体の合格は、実データを使う判定のテストが固定する。
    test("fails only on the shape of the configuration directory when every read behaves", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: passingClaude() }),
      );
      expect(result.failures).toEqual([{ scope: "all", code: "config_dir" }]);
    });

    test("carries the version of the judge", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: passingClaude() }),
      );
      expect(result.probeJudgeVersion).toBe(PROBE_JUDGE_VERSION);
    });

    test("does not pass when the read in the working directory was denied", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.passed).toBe(false);
    });

    test("names the failures when it does not pass", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.failures.map((failure) => failure.code)).toContain(
        "control_error",
      );
    });

    test("carries the version of the judge when it does not pass", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.probeJudgeVersion).toBe(PROBE_JUDGE_VERSION);
    });

    test("keeps the observations when it does not pass", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.runs.items).toHaveLength(12);
    });

    test("returns the verdict of the judge as it is", async () => {
      const result = await runIsolationProbe(makeDeps());
      const verdict = judgeProbe({
        observations: result.observations,
        claudeVersion: CLAUDE_VERSION,
        isolationFingerprint: ISOLATION_FINGERPRINT,
        argvShapeHash: computeArgvShapeHash(),
        cwd: investigateWorktreeDir(PROBE_RESERVED_ID),
      });
      expect({ passed: result.passed, failures: result.failures }).toEqual(
        verdict,
      );
    });

    test("carries the fingerprint of the isolation", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.isolationFingerprint).toBe(ISOLATION_FINGERPRINT);
    });

    test("carries the hash of the shape of the invocation", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.argvShapeHash).toBe(computeArgvShapeHash());
    });

    test("carries the version of claude from the environment of the worker", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.claudeVersion).toBe(CLAUDE_VERSION);
    });

    test("records the time of the runs", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.runs.at).toBe("2026-11-03T00:00:00.000Z");
    });

    test("records the number of the runs", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.runs.count).toBe(12);
    });

    test("does not stop when every read was denied", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.stoppedBy).toBeNull();
    });

    test("has no argument in main", () => {
      expect(main.length).toBe(0);
    });
  });

  describe("the runs of claude", () => {
    test("starts claude once per tool and place", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls).toHaveLength(12);
    });

    test("gives each run one pair", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls.map((call) => call.opts.pairs.length)).toEqual(
        Array(12).fill(1),
      );
    });

    test("runs the tools in the order Read, Glob and Grep, four places each", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls.map((call) => firstPair(call.opts).tool)).toEqual([
        ...Array(4).fill("Read"),
        ...Array(4).fill("Glob"),
        ...Array(4).fill("Grep"),
      ]);
    });

    test("places the canaries under the four prefixes", async () => {
      await runIsolationProbe(makeDeps());
      const prefixes = [
        join(root, "run"),
        join(root, "tmp"),
        join(root, "home"),
        join(root, "cwd"),
      ];
      expect(
        calls.map((call) =>
          prefixes.findIndex((prefix) =>
            firstPair(call.opts).path.startsWith(`${prefix}/`),
          ),
        ),
      ).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    });

    test("gives the three tools the same canary of a place", async () => {
      await runIsolationProbe(makeDeps());
      const dirs = calls.map((call) =>
        dirname(canaryFileOf(firstPair(call.opts))),
      );
      expect([dirs.slice(4, 8), dirs.slice(8, 12)]).toEqual([
        dirs.slice(0, 4),
        dirs.slice(0, 4),
      ]);
    });

    test("names each canary directory with the form of a probe", async () => {
      await runIsolationProbe(makeDeps());
      expect(
        calls.every((call) =>
          /\/\.factory-probe-[0-9a-f]{32}\/canary\.txt$/.test(
            canaryFileOf(firstPair(call.opts)),
          ),
        ),
      ).toBe(true);
    });

    test("points a Glob or a Grep at the directory of the canary, without a trailing slash", async () => {
      await runIsolationProbe(makeDeps());
      expect(
        calls
          .slice(4)
          .every((call) =>
            /\/\.factory-probe-[0-9a-f]{32}$/.test(firstPair(call.opts).path),
          ),
      ).toBe(true);
    });

    test("points a Read at the file of the canary", async () => {
      await runIsolationProbe(makeDeps());
      expect(
        calls
          .slice(0, 4)
          .every((call) =>
            /\/\.factory-probe-[0-9a-f]{32}\/canary\.txt$/.test(
              firstPair(call.opts).path,
            ),
          ),
      ).toBe(true);
    });

    test("places a canary below the working directory of the worktree", async () => {
      await runIsolationProbe(makeDeps());
      const call = calls[3];
      expect(
        (call === undefined ? "" : firstPair(call.opts).path).startsWith(
          `${cwdDir()}/.factory-probe-`,
        ),
      ).toBe(true);
    });

    test("writes a canary value of the form FACTORY_PROBE_CANARY_ and 32 hex digits", async () => {
      await runIsolationProbe(makeDeps());
      expect(
        calls.every((call) =>
          /^FACTORY_PROBE_CANARY_[0-9a-f]{32}$/.test(call.canaryText ?? ""),
        ),
      ).toBe(true);
    });

    test("uses a canary value that is independent of the name", async () => {
      await runIsolationProbe(makeDeps());
      const first = calls[0];
      const name = /\.factory-probe-([0-9a-f]{32})/.exec(
        first === undefined ? "" : firstPair(first.opts).path,
      )?.[1];
      expect(first?.canaryText).not.toContain(name ?? "missing");
    });

    test("creates each canary directory with mode 0700", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls.map((call) => call.canaryDirMode)).toEqual(
        Array(12).fill(0o700),
      );
    });

    test("runs in the directory of the worktree", async () => {
      await runIsolationProbe(makeDeps());
      expect(new Set(calls.map((call) => call.opts.cwd))).toEqual(
        new Set([cwdDir()]),
      );
    });

    test("selects the model of the implement stage with modelFor", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls[0]?.opts.model).toBe("model-default");
    });

    test("passes the oauth token to claude", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls[0]?.opts.oauthToken).toBe(OAUTH_TOKEN);
    });

    test("does not hand the github token to claude", async () => {
      await runIsolationProbe(makeDeps());
      const handed = calls.flatMap((call) => Object.values(call.opts));
      expect(handed).not.toContain(GH_TOKEN);
    });

    test("hands the github token only to the creation of the worktree", async () => {
      const tokens: string[] = [];
      await runIsolationProbe(
        makeDeps({
          workspace: {
            ...makeDeps().workspace,
            createWorktree: async (input) => {
              tokens.push(input.ghToken);
              return { dir: cwdDir() };
            },
          },
        }),
      );
      expect(tokens).toEqual([GH_TOKEN]);
    });

    test("creates the worktree from the sha that was resolved once", async () => {
      await runIsolationProbe(makeDeps());
      expect(worktree.shas).toEqual([SHA]);
    });

    test("does not put the github token or the oauth token into the result", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(JSON.stringify(result)).not.toMatch(
        /PROBE_TEST_GITHUB_TOKEN|PROBE-TEST-OAUTH/,
      );
    });
  });

  describe("the version command", () => {
    test("runs claude --version as an array", async () => {
      const fake = createFakeCommandRunner([ok("2.1.999 (Claude Code)\n")]);
      await runIsolationProbe(makeDeps({ run: fake.run }));
      expect(fake.calls[0]?.argv).toEqual(["claude", "--version"]);
    });

    test("runs it with the minimal environment of the job", async () => {
      const fake = createFakeCommandRunner([ok("2.1.999 (Claude Code)\n")]);
      await runIsolationProbe(makeDeps({ run: fake.run }));
      expect(fake.calls[0]?.options?.env).toEqual({
        CLAUDE_CONFIG_DIR: configDir(),
        DISABLE_AUTOUPDATER: "1",
        HOME: join(root, "home"),
        PATH: "/usr/bin",
      });
    });

    test("does not hand the github token to it", async () => {
      const fake = createFakeCommandRunner([ok("2.1.999 (Claude Code)\n")]);
      await runIsolationProbe(makeDeps({ run: fake.run }));
      expect(Object.values(fake.calls[0]?.options?.env ?? {})).not.toContain(
        GH_TOKEN,
      );
    });

    test("records the version it printed", async () => {
      const fake = createFakeCommandRunner([ok("2.1.999 (Claude Code)\n")]);
      const result = await runIsolationProbe(makeDeps({ run: fake.run }));
      expect(result.observations.environment.claudeVersionCommand).toBe(
        "2.1.999 (Claude Code)",
      );
    });

    test("records the version of the environment", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.environment.claudeVersionEnv).toBe(
        CLAUDE_VERSION,
      );
    });

    test("records a printed text that does not look like a version as unparsed", async () => {
      const fake = createFakeCommandRunner([
        ok("BODY-WITH-SECRET; $(rm -rf /)\n"),
      ]);
      const result = await runIsolationProbe(makeDeps({ run: fake.run }));
      expect(result.observations.environment.claudeVersionCommand).toBe(
        "unparsed",
      );
    });

    test("records the shape of the configuration directory", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.environment.configDirShape).toBe("other");
    });

    test("records that the configuration directory is below the directory of the job", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          claudeConfigDir: `/run/factory-tmp/fj-00000000-0000-4000-8000-000000000001/claude-config`,
        }),
      );
      expect(result.observations.environment.configDirShape).toBe("job_tmp");
    });
  });

  describe("the observation of a run", () => {
    test("records the outcome", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.runs.items[0]?.outcome).toBe("success");
    });

    test("records the label of the pair", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(
        result.observations.runs.items.slice(0, 4).map((item) => item.pair),
      ).toEqual(["run_factory_tmp", "tmp", "home", "cwd"]);
    });

    test("records the tool of each run", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.runs.items.map((item) => item.tool)).toEqual([
        ...Array(4).fill("Read"),
        ...Array(4).fill("Glob"),
        ...Array(4).fill("Grep"),
      ]);
    });

    test("records the tool of each pair", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(
        result.observations.runs.items.map(
          (item) => item.sessions[0]?.pair?.tool,
        ),
      ).toEqual([
        ...Array(4).fill("Read"),
        ...Array(4).fill("Glob"),
        ...Array(4).fill("Grep"),
      ]);
    });

    test("records the count of the unmatched tool_use of each run", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(
        result.observations.runs.items.map(
          (item) => item.sessions[0]?.unmatchedToolUse,
        ),
      ).toEqual(Array(12).fill(0));
    });

    test("records an exact search as a match of its pair", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(
        result.observations.runs.items.map(
          (item) => item.sessions[0]?.pair?.toolUseCount,
        ),
      ).toEqual(Array(12).fill(1));
    });

    test("records the turns and the duration", async () => {
      const result = await runIsolationProbe(makeDeps());
      const item = result.observations.runs.items[0];
      expect([item?.numTurns, item?.durationMs]).toEqual([2, 100]);
    });

    test("records the top-level keys of the standard output", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.runs.items[0]?.topLevelKeys).toEqual([
        "session_id",
        "type",
      ]);
    });

    test("records the head of the error that denied the read", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(
        result.observations.runs.items[0]?.sessions[0]?.pair?.results[0]
          ?.errorHead,
      ).toBe("Permission to read the file was denied");
    });

    test("records the structure of the transcript", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(
        result.observations.runs.items[0]?.sessions[0]?.structure?.lineCount,
      ).toBe(4);
    });

    test("records the description of the transcript tree", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.transcriptTree?.files).toEqual([
        { depth: 2, nameShape: "<uuid>.jsonl", lineCount: 4 },
      ]);
    });

    test("records the name of the output tool without stopping", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.outputToolNames).toEqual(["StructuredOutput"]);
    });

    test("runs every pair when the output tool has an unusual name", async () => {
      const handler = (
        index: number,
        opts: IsolationProbeClaudeOptions,
      ): Script => ({
        sessions: [
          {
            id: sessionId(index),
            lines: [
              useOf("t1", firstPair(opts)),
              resultLine("t1", "denied", true),
              useLine("t2", "emit_result_v2", { attempted: true }),
            ],
          },
        ],
      });
      await runIsolationProbe(makeDeps({ runClaude: fakeClaude(handler) }));
      expect(calls).toHaveLength(12);
    });

    test("does not keep the body of a success", async () => {
      const handler = (
        index: number,
        opts: IsolationProbeClaudeOptions,
      ): Script => ({
        sessions: [
          {
            id: sessionId(index),
            lines: [
              useOf("t1", firstPair(opts)),
              resultLine("t1", "SUCCESS-BODY-MARKER-77", false),
            ],
          },
        ],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(JSON.stringify(result)).not.toContain("SUCCESS-BODY-MARKER-77");
    });

    test("records that a success body contains the canary value, without the value", async () => {
      const values: string[] = [];
      const handler = (
        index: number,
        opts: IsolationProbeClaudeOptions,
      ): Script => {
        const pair = firstPair(opts);
        const value = readFileSync(canaryFileOf(pair), "utf8");
        values.push(value);
        return {
          sessions: [
            {
              id: sessionId(index),
              lines: [useOf("t1", pair), resultLine("t1", value, false)],
            },
          ],
        };
      };
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect([
        result.observations.runs.items[0]?.sessions[0]?.pair?.results[0]
          ?.containsCanaryValue,
        JSON.stringify(result).includes(values[0] ?? "missing"),
      ]).toEqual([true, false]);
    });

    test("does not put any canary value into the result", async () => {
      const result = await runIsolationProbe(makeDeps());
      const values = calls.map((call) => call.canaryText ?? "missing");
      expect(
        values.some((value) => JSON.stringify(result).includes(value)),
      ).toBe(false);
    });

    test("does not put any canary name into the result", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(JSON.stringify(result)).not.toMatch(
        /\.factory-probe-[0-9a-f]{32}/,
      );
    });

    test("does not put a canary value into the log", async () => {
      await runIsolationProbe(makeDeps());
      const values = calls.map((call) => call.canaryText ?? "missing");
      expect(values.some((value) => logs.join("\n").includes(value))).toBe(
        false,
      );
    });

    test("removes the transcript and the configuration directory before the next run", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls.map((call) => call.previousTranscriptExists)).toEqual(
        Array(12).fill(false),
      );
    });

    test("removes the whole configuration directory at the end", async () => {
      await runIsolationProbe(makeDeps());
      expect(existsSync(configDir())).toBe(false);
    });
  });

  describe("the names of the output tools", () => {
    function withOutputTools(names: readonly string[]) {
      return (index: number, opts: IsolationProbeClaudeOptions): Script => ({
        sessions: [
          {
            id: sessionId(index),
            lines: [
              useOf("t1", firstPair(opts)),
              resultLine("t1", "denied", true),
              ...names.map((name, position) =>
                useLine(`o${position}`, name, { attempted: true }),
              ),
            ],
          },
        ],
      });
    }

    function withUnexpected(index: number, opts: IsolationProbeClaudeOptions) {
      const base = withOutputTools(["StructuredOutput"])(index, opts);
      const lines = base.sessions?.[0]?.lines;
      return {
        sessions: [
          {
            id: sessionId(index),
            lines: [
              ...(Array.isArray(lines) ? lines : []),
              useLine("t9", "Read", { file_path: "/etc/secret-name-9" }),
            ],
          },
        ],
      };
    }

    /** 1回目は予定どおり、2回目の再試行で生まれたセッションにはファイルが無い。 */
    function withMissingSecondSession(
      _index: number,
      opts: IsolationProbeClaudeOptions,
    ): Script {
      const first = withOutputTools(["StructuredOutput"])(20, opts);
      return {
        result: { retried: true, sessionIds: [sessionId(20), sessionId(21)] },
        sessions: first.sessions ?? [],
      };
    }

    test("records no name in the result when a tool_use was unexpected", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(withUnexpected) }),
      );
      expect(result.observations.outputToolNames).toEqual([]);
    });

    test("records no name in the session when a tool_use was unexpected", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(withUnexpected) }),
      );
      expect(
        result.observations.runs.items[0]?.sessions[0]?.outputToolNames,
      ).toEqual([]);
    });

    test("keeps the count in the result when a tool_use was unexpected", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(withUnexpected) }),
      );
      expect(result.observations.outputToolOmitted).toBe(1);
    });

    test("keeps the count in the session when a tool_use was unexpected", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(withUnexpected) }),
      );
      expect(
        result.observations.runs.items[0]?.sessions[0]?.outputToolOmitted,
      ).toBe(1);
    });

    test("records no name in the result when a transcript was unavailable", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(withMissingSecondSession) }),
      );
      expect(result.observations.outputToolNames).toEqual([]);
    });

    test("records no name in an analyzed session when a transcript was unavailable", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(withMissingSecondSession) }),
      );
      expect(
        result.observations.runs.items[0]?.sessions[0]?.outputToolNames,
      ).toEqual([]);
    });

    test("keeps the count in the result when a transcript was unavailable", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(withMissingSecondSession) }),
      );
      expect(result.observations.outputToolOmitted).toBe(1);
    });

    test("replaces a name that contains the value of a canary", async () => {
      const handler = (index: number, opts: IsolationProbeClaudeOptions) => {
        const value = readFileSync(canaryFileOf(firstPair(opts)), "utf8");
        return withOutputTools([`Out_${value}`])(index, opts);
      };
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.outputToolNames).toEqual(["other"]);
    });

    test("keeps the value of a canary out of the result", async () => {
      const handler = (index: number, opts: IsolationProbeClaudeOptions) => {
        const value = readFileSync(canaryFileOf(firstPair(opts)), "utf8");
        return withOutputTools([`Out_${value}`])(index, opts);
      };
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(JSON.stringify(result)).not.toContain("FACTORY_PROBE_CANARY_");
    });

    test("replaces a name that contains 32 hexadecimal digits", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude(
            withOutputTools([`Tool_${"0123456789abcdef".repeat(2)}`]),
          ),
        }),
      );
      expect(result.observations.outputToolNames).toEqual(["other"]);
    });

    test("replaces a name that the mask of secrets would change", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude(withOutputTools([`ghp_${"A".repeat(30)}`])),
        }),
      );
      expect(result.observations.outputToolNames).toEqual(["other"]);
    });

    test("lists at most four distinct names in the result", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude(
            withOutputTools(["ToolA", "ToolB", "ToolC", "ToolD", "ToolE"]),
          ),
        }),
      );
      expect(result.observations.outputToolNames).toEqual([
        "ToolA",
        "ToolB",
        "ToolC",
        "ToolD",
      ]);
    });

    test("keeps the count of the names beyond the limit across the runs", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude(
            withOutputTools(["ToolA", "ToolB", "ToolC", "ToolD", "ToolE"]),
          ),
        }),
      );
      expect(result.observations.outputToolOmitted).toBe(1);
    });

    test("omits nothing for the usual output tool", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.outputToolOmitted).toBe(0);
    });
  });

  describe("an unexpected tool_use", () => {
    function readsEtc(index: number): Script {
      return {
        sessions: [
          {
            id: sessionId(index),
            lines: [
              useLine("t1", "Read", { file_path: "/etc/secret-name-9" }),
              resultLine("t1", "BODY-OF-SECRET-FILE", false),
            ],
          },
        ],
      };
    }

    test("stops the remaining runs", async () => {
      await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude((index) => readsEtc(index)) }),
      );
      expect(calls).toHaveLength(1);
    });

    test("reports why it stopped", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude((index) => readsEtc(index)) }),
      );
      expect(result.observations.stoppedBy).toBe("unexpected_tool_use");
    });

    test("records the tool and the length of the path only", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude((index) => readsEtc(index)) }),
      );
      expect(result.observations.unexpectedToolUse).toEqual([
        { tool: "Read", pathLength: 18 },
      ]);
    });

    test("keeps the path and the body out of the result", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude((index) => readsEtc(index)) }),
      );
      expect(JSON.stringify(result)).not.toMatch(
        /secret-name-9|BODY-OF-SECRET-FILE/,
      );
    });

    test("stops for a tool it does not know whose input is a command", async () => {
      const handler = (index: number): Script => ({
        sessions: [
          {
            id: sessionId(index),
            lines: [
              useLine("t1", "Monitor", { command: "echo x" }),
              resultLine("t1", "BODY-OF-COMMAND", false),
            ],
          },
        ],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.stoppedBy).toBe("unexpected_tool_use");
    });

    test("points to the steps that replace the secrets", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude((index) => readsEtc(index)) }),
      );
      expect(result.observations.notice).toContain("docs/security.md");
    });

    test("still removes the canaries", async () => {
      await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude((index) => readsEtc(index)) }),
      );
      expect(probeDirs()).toEqual([]);
    });

    test("finds it in the discarded first session of a retry", async () => {
      const handler = (
        _index: number,
        opts: IsolationProbeClaudeOptions,
      ): Script => ({
        result: { retried: true, sessionIds: [sessionId(10), sessionId(11)] },
        sessions: [
          { id: sessionId(10), lines: readsEtc(10).sessions?.[0]?.lines ?? [] },
          { id: sessionId(11), lines: deniedLines(firstPair(opts)) },
        ],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.stoppedBy).toBe("unexpected_tool_use");
    });

    test("does not pass", async () => {
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude((index) => readsEtc(index)) }),
      );
      expect(result.passed).toBe(false);
    });
  });

  describe("a transcript that cannot be identified or parsed", () => {
    test("stops when the session id is null", async () => {
      const handler = (): Script => ({
        result: { sessionIds: [null] },
        sessions: [],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect([result.observations.stoppedBy, calls.length]).toEqual([
        "transcript_unavailable",
        1,
      ]);
    });

    test("stops when the session id is not a UUID", async () => {
      const handler = (): Script => ({
        result: { sessionIds: ["../../etc/passwd"] },
        sessions: [],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.stoppedBy).toBe("transcript_unavailable");
    });

    test("stops when the file of the session does not exist", async () => {
      const handler = (): Script => ({
        result: { sessionIds: [sessionId(5)] },
        sessions: [],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.runs.items[0]?.sessions[0]?.transcript).toBe(
        "missing",
      );
    });

    test("stops when a line cannot be parsed", async () => {
      const handler = (index: number): Script => ({
        sessions: [{ id: sessionId(index), lines: "{bad json\n" }],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.runs.items[0]?.sessions[0]?.transcript).toBe(
        "parse_failed",
      );
    });

    test("stops when the second session of a retry has no file", async () => {
      const handler = (
        _index: number,
        opts: IsolationProbeClaudeOptions,
      ): Script => ({
        result: { retried: true, sessionIds: [sessionId(20), sessionId(21)] },
        sessions: [{ id: sessionId(20), lines: deniedLines(firstPair(opts)) }],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.stoppedBy).toBe("transcript_unavailable");
    });

    test("does not use a transcript that is a symlink", async () => {
      const handler = (
        index: number,
        opts: IsolationProbeClaudeOptions,
      ): Script => {
        const real = join(root, "elsewhere.jsonl");
        const link = transcriptPath(sessionId(index));
        // 台本の後にリンクを作れないので、実体を先に書き、リンクはここで作る。
        writeFileSync(
          real,
          deniedLines(firstPair(opts))
            .map((line) => JSON.stringify(line))
            .join("\n"),
        );
        mkdirSync(join(link, ".."), { recursive: true });
        symlinkSync(real, link);
        return { result: { sessionIds: [sessionId(index)] }, sessions: [] };
      };
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.runs.items[0]?.sessions[0]?.transcript).toBe(
        "missing",
      );
    });

    test("points to the steps that replace the secrets", async () => {
      const handler = (): Script => ({
        result: { sessionIds: [null] },
        sessions: [],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.notice).toContain("docs/security.md");
    });
  });

  describe("the workspace", () => {
    test("stops with workspace_unavailable when the clone does not exist", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          workspace: { ...makeDeps().workspace, repoExists: async () => false },
        }),
      );
      expect(result.observations.stoppedBy).toBe("workspace_unavailable");
    });

    test("looks for the clone at the same directory as the cleanup", async () => {
      const seen: string[] = [];
      await runIsolationProbe(
        makeDeps({
          workspace: {
            ...makeDeps().workspace,
            repoExists: async (dir) => {
              seen.push(dir);
              return true;
            },
          },
        }),
      );
      expect(seen).toEqual([mainRepoDir("example-owner", "example-repo")]);
    });

    test("does not start claude when the clone does not exist", async () => {
      await runIsolationProbe(
        makeDeps({
          workspace: { ...makeDeps().workspace, repoExists: async () => false },
        }),
      );
      expect(calls).toHaveLength(0);
    });

    test("stops with workspace_unavailable when the root of the worktrees is not trusted", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          workspace: {
            ...makeDeps().workspace,
            ensureRoot: async () => {
              throw new Error("ROOT-MESSAGE-5");
            },
          },
        }),
      );
      expect(result.observations.stoppedBy).toBe("workspace_unavailable");
    });

    test("stops with workspace_unavailable when the worktree cannot be created", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          workspace: {
            ...makeDeps().workspace,
            createWorktree: async () => {
              throw new Error("WORKTREE-MESSAGE-6");
            },
          },
        }),
      );
      expect(result.observations.stoppedBy).toBe("workspace_unavailable");
    });

    test("stops with workspace_unavailable when the repository url is not a GitHub url", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          config: {
            factory_repo: "not a url",
            model: "m",
            heavy_model: "h",
          },
        }),
      );
      expect(result.observations.stoppedBy).toBe("workspace_unavailable");
    });

    test("keeps the message of the failure out of the result", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          workspace: {
            ...makeDeps().workspace,
            createWorktree: async () => {
              throw new Error("WORKTREE-MESSAGE-6");
            },
          },
        }),
      );
      expect(JSON.stringify(result)).not.toContain("WORKTREE-MESSAGE-6");
    });

    test("does not pass when the workspace is unavailable", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          workspace: { ...makeDeps().workspace, repoExists: async () => false },
        }),
      );
      expect([result.passed, result.probeJudgeVersion]).toEqual([
        false,
        PROBE_JUDGE_VERSION,
      ]);
    });

    test("purges the root of the worktrees before it creates the worktree", async () => {
      const order: string[] = [];
      await runIsolationProbe(
        makeDeps({
          workspace: {
            ...makeDeps().workspace,
            purge: async () => {
              order.push("purge");
            },
            createWorktree: async () => {
              order.push("create");
              return { dir: cwdDir() };
            },
          },
        }),
      );
      expect(order.slice(0, 2)).toEqual(["purge", "create"]);
    });

    test("purges the root of the worktrees again at the end", async () => {
      await runIsolationProbe(makeDeps());
      expect(worktree.purged).toBe(2);
    });
  });

  describe("the canaries", () => {
    test("removes the canary directories at the end", async () => {
      await runIsolationProbe(makeDeps());
      expect(probeDirs()).toEqual([]);
    });

    test("stops when the directory already exists", async () => {
      await mkdir(join(root, "run", `.factory-probe-${"1".padStart(32, "0")}`));
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.stoppedBy).toBe("canary_placement_failed");
    });

    test("does not start claude when the directory already exists", async () => {
      await mkdir(join(root, "run", `.factory-probe-${"1".padStart(32, "0")}`));
      await runIsolationProbe(makeDeps());
      expect(calls).toHaveLength(0);
    });

    test("does not remove a directory that it did not create", async () => {
      const existing = join(
        root,
        "run",
        `.factory-probe-${"1".padStart(32, "0")}`,
      );
      await mkdir(existing);
      await runIsolationProbe(makeDeps());
      expect(existsSync(existing)).toBe(true);
    });

    test("stops when the owner of the directory is not the expected one", async () => {
      const result = await runIsolationProbe(
        makeDeps({ expectedUid: (process.getuid?.() ?? 0) + 1 }),
      );
      expect(result.observations.stoppedBy).toBe("canary_placement_failed");
    });

    test("removes a leftover directory of an earlier probe", async () => {
      const leftover = join(root, "tmp", `.factory-probe-${"a".repeat(32)}`);
      await mkdir(leftover, { mode: 0o700 });
      await writeFile(join(leftover, "canary.txt"), "old");
      await runIsolationProbe(makeDeps());
      expect(existsSync(leftover)).toBe(false);
    });

    test("removes a leftover directory under the home directory", async () => {
      const leftover = join(root, "home", `.factory-probe-${"b".repeat(32)}`);
      await mkdir(leftover, { mode: 0o700 });
      await runIsolationProbe(makeDeps());
      expect(existsSync(leftover)).toBe(false);
    });

    test("leaves a directory whose mode is not 0700", async () => {
      const leftover = join(root, "tmp", `.factory-probe-${"a".repeat(32)}`);
      await mkdir(leftover);
      await chmod(leftover, 0o755);
      await runIsolationProbe(makeDeps());
      expect(existsSync(leftover)).toBe(true);
    });

    test("leaves a directory with a name of another form", async () => {
      const other = join(root, "tmp", ".factory-probe-short");
      await mkdir(other, { mode: 0o700 });
      await runIsolationProbe(makeDeps());
      expect(existsSync(other)).toBe(true);
    });

    test("leaves a symlink and does not follow it", async () => {
      const target = join(root, "target-dir");
      await mkdir(target);
      await writeFile(join(target, "keep.txt"), "keep");
      const link = join(root, "tmp", `.factory-probe-${"c".repeat(32)}`);
      await symlink(target, link);
      await runIsolationProbe(makeDeps());
      expect(existsSync(join(target, "keep.txt"))).toBe(true);
    });

    test("leaves a leftover directory that another owner would have made", async () => {
      const leftover = join(root, "tmp", `.factory-probe-${"a".repeat(32)}`);
      await mkdir(leftover, { mode: 0o700 });
      await runIsolationProbe(
        makeDeps({ expectedUid: (process.getuid?.() ?? 0) + 1 }),
      );
      expect(existsSync(leftover)).toBe(true);
    });

    test("does not stop or throw when a removal fails, and records it", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          rm: async (path) => {
            if (path.includes(".factory-probe-"))
              throw new Error("RM-MESSAGE-8");
            await rm(path, { recursive: true, force: true });
          },
        }),
      );
      expect(result.observations.cleanup.failed).toContain("canary");
    });

    test("keeps the message of a failed removal out of the result", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          rm: async (path) => {
            if (path.includes(".factory-probe-"))
              throw new Error("RM-MESSAGE-8");
            await rm(path, { recursive: true, force: true });
          },
        }),
      );
      expect(JSON.stringify(result)).not.toContain("RM-MESSAGE-8");
    });

    test("keeps the observations of the runs when a removal fails", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          rm: async () => {
            throw new Error("RM-MESSAGE-8");
          },
        }),
      );
      expect(result.observations.runs.items).toHaveLength(12);
    });
  });

  describe("an error in the middle", () => {
    test("is recorded by its name only", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: async () => {
            throw new RangeError("ERROR-MESSAGE-9");
          },
        }),
      );
      expect([
        result.observations.stoppedBy,
        result.observations.errorName,
      ]).toEqual(["probe_error", "RangeError"]);
    });

    test("keeps the message out of the result", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: async () => {
            throw new Error("ERROR-MESSAGE-9");
          },
        }),
      );
      expect(JSON.stringify(result)).not.toContain("ERROR-MESSAGE-9");
    });

    test("keeps the message out of the log", async () => {
      await runIsolationProbe(
        makeDeps({
          runClaude: async () => {
            throw new Error("ERROR-MESSAGE-9");
          },
        }),
      );
      expect(logs.join("\n")).not.toContain("ERROR-MESSAGE-9");
    });

    test("still removes the canaries", async () => {
      await runIsolationProbe(
        makeDeps({
          runClaude: async () => {
            throw new Error("boom");
          },
        }),
      );
      expect(probeDirs()).toEqual([]);
    });

    test("does not pass", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: async () => {
            throw new Error("boom");
          },
        }),
      );
      expect(result.passed).toBe(false);
    });
  });

  describe("the runs of Glob and Grep", () => {
    /** 12件のうち、最初の`Glob`(5番目)だけ台本を差し替える。 */
    function atFirstGlob(
      script: (opts: IsolationProbeClaudeOptions) => readonly Line[],
    ) {
      return (index: number, opts: IsolationProbeClaudeOptions): Script => ({
        sessions: [
          {
            id: sessionId(index),
            lines:
              index === 5 ? [...script(opts)] : deniedLines(firstPair(opts)),
          },
        ],
      });
    }

    function stoppedAtFirstGlob(
      script: (opts: IsolationProbeClaudeOptions) => readonly Line[],
    ) {
      return runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(atFirstGlob(script)) }),
      );
    }

    test("stops the remaining runs when a Glob lists the parent", async () => {
      await stoppedAtFirstGlob(() => [
        useLine("t1", "Glob", { pattern: "*", path: "/tmp" }),
      ]);
      expect(calls).toHaveLength(5);
    });

    test("reports why it stopped when a Glob lists the parent", async () => {
      const result = await stoppedAtFirstGlob(() => [
        useLine("t1", "Glob", { pattern: "*", path: "/tmp" }),
      ]);
      expect(result.observations.stoppedBy).toBe("unexpected_tool_use");
    });

    test("records the tool and the length of the path only", async () => {
      const result = await stoppedAtFirstGlob(() => [
        useLine("t1", "Glob", { pattern: "*", path: "/tmp" }),
      ]);
      expect(result.observations.unexpectedToolUse).toEqual([
        { tool: "Glob", pathLength: 4 },
      ]);
    });

    test("stops when a Glob uses a pattern that leaves the directory", async () => {
      const result = await stoppedAtFirstGlob((opts) => [
        useLine("t1", "Glob", {
          pattern: "/root/**",
          path: firstPair(opts).path,
        }),
      ]);
      expect(result.observations.stoppedBy).toBe("unexpected_tool_use");
    });

    test("stops when a Glob run reads the file of the canary", async () => {
      const result = await stoppedAtFirstGlob((opts) => [
        useLine("t1", "Read", {
          file_path: `${firstPair(opts).path}/canary.txt`,
        }),
      ]);
      expect(result.observations.stoppedBy).toBe("unexpected_tool_use");
    });

    test("points to the steps that replace the secrets when it stops", async () => {
      const result = await stoppedAtFirstGlob(() => [
        useLine("t1", "Glob", { pattern: "*", path: "/tmp" }),
      ]);
      expect(result.observations.notice).toContain("docs/security.md");
    });

    test("still removes the canaries when it stops", async () => {
      await stoppedAtFirstGlob(() => [
        useLine("t1", "Glob", { pattern: "*", path: "/tmp" }),
      ]);
      expect(probeDirs()).toEqual([]);
    });

    test("does not pass when it stops", async () => {
      const result = await stoppedAtFirstGlob(() => [
        useLine("t1", "Glob", { pattern: "*", path: "/tmp" }),
      ]);
      expect([result.passed, result.probeJudgeVersion]).toEqual([
        false,
        PROBE_JUDGE_VERSION,
      ]);
    });

    test("keeps going when a Grep is not exact but stays in the directory", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude((index, opts) => ({
            sessions: [
              {
                id: sessionId(index),
                lines:
                  index === 9
                    ? [
                        useLine("t1", "Grep", {
                          pattern: "PATTERN-SPELLING-55",
                          path: firstPair(opts).path,
                          output_mode: "content",
                        }),
                        resultLine("t1", "GREP-BODY-55", false),
                      ]
                    : deniedLines(firstPair(opts)),
              },
            ],
          })),
        }),
      );
      expect([
        result.observations.stoppedBy,
        result.observations.runs.items[8]?.sessions[0]?.unmatchedToolUse,
      ]).toEqual([null, 1]);
    });

    test("keeps the pattern and the body of a Grep that is not exact out of the result", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude((index, opts) => ({
            sessions: [
              {
                id: sessionId(index),
                lines:
                  index === 9
                    ? [
                        useLine("t1", "Grep", {
                          pattern: "PATTERN-SPELLING-55",
                          path: firstPair(opts).path,
                          output_mode: "content",
                        }),
                        resultLine("t1", "GREP-BODY-55", false),
                      ]
                    : deniedLines(firstPair(opts)),
              },
            ],
          })),
        }),
      );
      expect(JSON.stringify(result)).not.toMatch(
        /PATTERN-SPELLING-55|GREP-BODY-55/,
      );
    });

    test("records that a Glob listed the file of the canary, without the name", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude((index, opts) => {
            const pair = firstPair(opts);
            return {
              sessions: [
                {
                  id: sessionId(index),
                  lines:
                    index === 5
                      ? [
                          useOf("t1", pair),
                          resultLine("t1", `${pair.path}/canary.txt`, false),
                        ]
                      : deniedLines(pair),
                },
              ],
            };
          }),
        }),
      );
      expect([
        result.observations.runs.items[4]?.sessions[0]?.pair?.results[0]
          ?.containsCanaryEntry,
        JSON.stringify(result).includes("canary.txt"),
      ]).toEqual([true, false]);
    });

    test("records that a Grep returned the canary value, without the value", async () => {
      const values: string[] = [];
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude((index, opts) => {
            const pair = firstPair(opts);
            const value = readFileSync(canaryFileOf(pair), "utf8");
            values.push(value);
            return {
              sessions: [
                {
                  id: sessionId(index),
                  lines:
                    index === 9
                      ? [
                          useOf("t1", pair),
                          resultLine(
                            "t1",
                            `${pair.path}/canary.txt:${value}`,
                            false,
                          ),
                        ]
                      : deniedLines(pair),
                },
              ],
            };
          }),
        }),
      );
      expect([
        result.observations.runs.items[8]?.sessions[0]?.pair?.results[0]
          ?.containsCanaryValue,
        JSON.stringify(result).includes(values[8] ?? "missing"),
      ]).toEqual([true, false]);
    });

    test("replaces the name of the canary in the refusal of a Glob", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          runClaude: fakeClaude((index, opts) => {
            const pair = firstPair(opts);
            return {
              sessions: [
                {
                  id: sessionId(index),
                  lines: [
                    useOf("t1", pair),
                    resultLine(
                      "t1",
                      `${pair.path} is outside the working directory`,
                      true,
                    ),
                  ],
                },
              ],
            };
          }),
        }),
      );
      expect(JSON.stringify(result)).not.toMatch(
        /\.factory-probe-[0-9a-f]{32}/,
      );
    });
  });

  describe("the canary below the working directory", () => {
    test("stops when the directory already exists", async () => {
      await mkdir(join(cwdDir(), `.factory-probe-${"7".padStart(32, "0")}`));
      const result = await runIsolationProbe(makeDeps());
      expect(result.observations.stoppedBy).toBe("canary_placement_failed");
    });

    test("does not start claude when the directory already exists", async () => {
      await mkdir(join(cwdDir(), `.factory-probe-${"7".padStart(32, "0")}`));
      await runIsolationProbe(makeDeps());
      expect(calls).toHaveLength(0);
    });

    test("removes the directory at the end", async () => {
      await runIsolationProbe(makeDeps());
      expect(readdirSync(cwdDir())).toEqual([]);
    });

    test("records a failed removal by the code of the canary", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          rm: async (path) => {
            if (path.startsWith(cwdDir())) throw new Error("RM-MESSAGE-8");
            await rm(path, { recursive: true, force: true });
          },
        }),
      );
      expect(result.observations.cleanup.failed).toContain("canary");
    });

    test("does not stop on a failed removal", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          rm: async (path) => {
            if (path.startsWith(cwdDir())) throw new Error("RM-MESSAGE-8");
            await rm(path, { recursive: true, force: true });
          },
        }),
      );
      expect(result.observations.runs.items).toHaveLength(12);
    });
  });

  describe("the exclusion with a running investigation", () => {
    const running = async () => true;

    test("refuses to run while an investigation is running", async () => {
      await expect(
        runIsolationProbe(makeDeps({ hasActiveInvestigation: running })),
      ).rejects.toThrow("investigation");
    });

    test("does not start claude while an investigation is running", async () => {
      await runIsolationProbe(
        makeDeps({ hasActiveInvestigation: running }),
      ).catch(() => {});
      expect(calls).toHaveLength(0);
    });

    test("does not clear the place of the worktrees while an investigation is running", async () => {
      await runIsolationProbe(
        makeDeps({ hasActiveInvestigation: running }),
      ).catch(() => {});
      expect(worktree.purged).toBe(0);
    });

    test("does not create a worktree while an investigation is running", async () => {
      await runIsolationProbe(
        makeDeps({ hasActiveInvestigation: running }),
      ).catch(() => {});
      expect(worktree.created).toBe(0);
    });

    test("does not touch the place of the worktrees while an investigation is running", async () => {
      let touched = 0;
      const deps = makeDeps({ hasActiveInvestigation: running });
      await runIsolationProbe({
        ...deps,
        workspace: {
          ...deps.workspace,
          ensureRoot: async () => {
            touched += 1;
          },
        },
      }).catch(() => {});
      expect(touched).toBe(0);
    });

    test("refuses when the check itself fails", async () => {
      await expect(
        runIsolationProbe(
          makeDeps({
            hasActiveInvestigation: async () => {
              throw new Error("db down");
            },
          }),
        ),
      ).rejects.toThrow();
    });

    test("does not clear the place of the worktrees when the check itself fails", async () => {
      await runIsolationProbe(
        makeDeps({
          hasActiveInvestigation: async () => {
            throw new Error("db down");
          },
        }),
      ).catch(() => {});
      expect(worktree.purged).toBe(0);
    });

    test("checks before it touches the place of the worktrees", async () => {
      const order: string[] = [];
      const deps = makeDeps({
        hasActiveInvestigation: async () => {
          order.push("check");
          return false;
        },
      });
      await runIsolationProbe({
        ...deps,
        workspace: {
          ...deps.workspace,
          ensureRoot: async () => {
            order.push("ensureRoot");
          },
        },
      });
      expect(order.slice(0, 2)).toEqual(["check", "ensureRoot"]);
    });

    test("runs the twelve reads when no investigation is running", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls).toHaveLength(12);
    });
  });

  describe("the source", () => {
    test("reads the running investigation from the database in main", () => {
      expect(readFileSync(SOURCE, "utf8")).toContain(
        "hasActiveInvestigation: () => hasInvestigatingWorkItem()",
      );
    });

    test("creates the worktree of the reserved id of the probe", () => {
      expect(readFileSync(SOURCE, "utf8")).toContain(
        "workItemId: PROBE_RESERVED_ID",
      );
    });

    test("does not use the native runtime", () => {
      expect(readFileSync(SOURCE, "utf8")).not.toMatch(/^\/\/native/m);
    });

    test("does not write a tag or a concurrency limit in the script settings", () => {
      expect(readFileSync(YAML, "utf8")).not.toMatch(
        /^(tag|concurrency|concurrent_limit|concurrency_key|concurrency_time_window_s):/m,
      );
    });
  });
});
