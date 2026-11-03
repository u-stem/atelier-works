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
import { join } from "node:path";
import {
  main,
  type ProbeDeps,
  runIsolationProbe,
} from "../../f/factory/investigate_isolation_probe.ts";
import type {
  IsolationProbeClaudeOptions,
  IsolationProbeRunResult,
} from "../../f/factory/lib/investigate_claude.ts";
import {
  computeArgvShapeHash,
  ISOLATION_FINGERPRINT,
} from "../../f/factory/lib/investigate_isolation.ts";
import {
  investigateWorktreeDir,
  PROBE_RESERVED_ID,
} from "../../f/factory/lib/investigate_workspace.ts";
import type { CommandRunner } from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, ok } from "../lib/testSupport.ts";

const GH_TOKEN = "ghp_PROBE_TEST_GITHUB_TOKEN_0123456789";
const OAUTH_TOKEN = "sk-ant-oat-PROBE-TEST-OAUTH-0123456789";
const CLAUDE_VERSION = "2.1.999";
const PROBE_CWD = investigateWorktreeDir(PROBE_RESERVED_ID);
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

function deniedLines(path: string): Line[] {
  return [
    useLine("t1", "Read", { file_path: path }),
    resultLine("t1", "Permission to read the file was denied", true),
    useLine("t2", "StructuredOutput", { attempted: true }),
    resultLine("t2", "accepted", false),
  ];
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
    for (const name of ["run", "tmp", "home"]) {
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

  /** 3つの親の直下に残っている、probeのcanaryの名前の形の項目。 */
  function probeDirs(): string[] {
    return ["run", "tmp", "home"].flatMap((name) =>
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
      const path = opts.pairs[0]?.path ?? "";
      let canaryText: string | null = null;
      try {
        canaryText = await readFile(path, "utf8");
      } catch {
        canaryText = null;
      }
      let canaryDirMode: number | null = null;
      try {
        canaryDirMode = (await stat(join(path, ".."))).mode & 0o777;
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
        sessions: [{ id: sessionId(index), lines: deniedLines(path) }],
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
          return { dir: PROBE_CWD };
        },
      },
      runClaude: fakeClaude(),
      rm: (path) => rm(path, { recursive: true, force: true }),
      log: (message) => {
        logs.push(message);
      },
      ...overrides,
    };
  }

  describe("the result", () => {
    test("is marked as an observation only", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.observationOnly).toBe(true);
    });

    test("never passes, also when every read was denied", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.passed).toBe(false);
    });

    test("carries the judge version 0, which the gate never accepts", async () => {
      const result = await runIsolationProbe(makeDeps());
      expect(result.probeJudgeVersion).toBe(0);
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
      expect(result.observations.runs.count).toBe(3);
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
    test("starts claude once per pair", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls).toHaveLength(3);
    });

    test("gives each run one pair of the Read tool", async () => {
      await runIsolationProbe(makeDeps());
      expect(
        calls.map((call) => call.opts.pairs.map((pair) => pair.tool)),
      ).toEqual([["Read"], ["Read"], ["Read"]]);
    });

    test("places the canaries under the three prefixes", async () => {
      await runIsolationProbe(makeDeps());
      const prefixes = [
        join(root, "run"),
        join(root, "tmp"),
        join(root, "home"),
      ];
      expect(
        calls.map((call) =>
          prefixes.findIndex((prefix) =>
            (call.opts.pairs[0]?.path ?? "").startsWith(`${prefix}/`),
          ),
        ),
      ).toEqual([0, 1, 2]);
    });

    test("names each canary directory with the form of a probe", async () => {
      await runIsolationProbe(makeDeps());
      expect(
        calls.every((call) =>
          /\/\.factory-probe-[0-9a-f]{32}\/canary\.txt$/.test(
            call.opts.pairs[0]?.path ?? "",
          ),
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
        first?.opts.pairs[0]?.path ?? "",
      )?.[1];
      expect(first?.canaryText).not.toContain(name ?? "missing");
    });

    test("creates each canary directory with mode 0700", async () => {
      await runIsolationProbe(makeDeps());
      expect(calls.map((call) => call.canaryDirMode)).toEqual([
        0o700, 0o700, 0o700,
      ]);
    });

    test("runs in the reserved directory of the probe", async () => {
      await runIsolationProbe(makeDeps());
      expect(new Set(calls.map((call) => call.opts.cwd))).toEqual(
        new Set([PROBE_CWD]),
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
              return { dir: PROBE_CWD };
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
      expect(result.observations.runs.items.map((item) => item.pair)).toEqual([
        "run_factory_tmp",
        "tmp",
        "home",
      ]);
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

    test("runs all three pairs when the output tool has an unusual name", async () => {
      const handler = (
        index: number,
        opts: IsolationProbeClaudeOptions,
      ): Script => ({
        sessions: [
          {
            id: sessionId(index),
            lines: [
              useLine("t1", "Read", { file_path: opts.pairs[0]?.path }),
              resultLine("t1", "denied", true),
              useLine("t2", "emit_result_v2", { attempted: true }),
            ],
          },
        ],
      });
      await runIsolationProbe(makeDeps({ runClaude: fakeClaude(handler) }));
      expect(calls).toHaveLength(3);
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
              useLine("t1", "Read", { file_path: opts.pairs[0]?.path }),
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
        const path = opts.pairs[0]?.path ?? "";
        const value = readFileSync(path, "utf8");
        values.push(value);
        return {
          sessions: [
            {
              id: sessionId(index),
              lines: [
                useLine("t1", "Read", { file_path: path }),
                resultLine("t1", value, false),
              ],
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
      expect(calls.map((call) => call.previousTranscriptExists)).toEqual([
        false,
        false,
        false,
      ]);
    });

    test("removes the whole configuration directory at the end", async () => {
      await runIsolationProbe(makeDeps());
      expect(existsSync(configDir())).toBe(false);
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
          { id: sessionId(11), lines: deniedLines(opts.pairs[0]?.path ?? "") },
        ],
      });
      const result = await runIsolationProbe(
        makeDeps({ runClaude: fakeClaude(handler) }),
      );
      expect(result.observations.stoppedBy).toBe("unexpected_tool_use");
    });

    test("still never passes", async () => {
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
        sessions: [
          { id: sessionId(20), lines: deniedLines(opts.pairs[0]?.path ?? "") },
        ],
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
          deniedLines(opts.pairs[0]?.path ?? "")
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

    test("never passes when the workspace is unavailable", async () => {
      const result = await runIsolationProbe(
        makeDeps({
          workspace: { ...makeDeps().workspace, repoExists: async () => false },
        }),
      );
      expect([result.passed, result.probeJudgeVersion]).toEqual([false, 0]);
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
              return { dir: PROBE_CWD };
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
      expect(result.observations.runs.items).toHaveLength(3);
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

    test("still never passes", async () => {
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

  describe("the source", () => {
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
