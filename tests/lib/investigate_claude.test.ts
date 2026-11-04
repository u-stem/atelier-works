// 調査のClaudeの隔離の引数と、失敗の記録に出力の本文が残らないことを固定する。
// 保護パスに置く。隔離の引数を緩める変更や、本文を残す変更が、このテストを書き換えて通らないようにするため。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReadDenyPaths,
  READ_DENY_BASE_PATHS,
} from "../../f/factory/lib/claude_read_deny.ts";
import {
  type InvestigateClaudeDeps,
  type InvestigateClaudeOptions,
  type IsolationProbeClaudeOptions,
  runInvestigateClaude,
  runInvestigateClaudeWithDeps,
  runIsolationProbeClaude,
  runIsolationProbeClaudeWithDeps,
} from "../../f/factory/lib/investigate_claude.ts";
import {
  computeIsolationFingerprint,
  ISOLATION_ARGS,
  ISOLATION_FINGERPRINT,
} from "../../f/factory/lib/investigate_isolation.ts";
import {
  INVESTIGATE_ROOT,
  investigateWorktreeDir,
  PROBE_RESERVED_ID,
} from "../../f/factory/lib/investigate_workspace.ts";
import {
  IsolationProofError,
  mintIsolationProof,
} from "../../f/factory/lib/isolation_proof.ts";
import type { AgentRunRecord } from "../../f/factory/lib/types.ts";
import type { CommandRunner } from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, fail, timeout } from "./testSupport.ts";

const JOB_ID = "11111111-2222-4333-8444-555555555555";
/** 秘密値の形をしていないので、`maskSecrets`では消えない。本文が残れば見つかる。 */
const LEAK = "LEAKED-OUTPUT-BODY-9f3a";

type OkPayload = { readonly ok: boolean };

function isOkPayload(value: unknown): value is OkPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof Reflect.get(value, "ok") === "boolean"
  );
}

function claudeJsonStdout(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "sess-1",
    total_cost_usd: 0.01,
    num_turns: 2,
    duration_ms: 100,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    },
    structured_output: { ok: true },
    ...overrides,
  });
}

const OK = {
  stdout: claudeJsonStdout(),
  stderr: "",
  exitCode: 0,
  timedOut: false,
};

function wrongShape() {
  return {
    stdout: claudeJsonStdout({ structured_output: { wrong: LEAK } }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

describe("runInvestigateClaude", () => {
  let root: string;
  let tmpDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "investigate-claude-"));
    tmpDir = join(root, `fj-${JOB_ID}`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps() {
    return {
      tmpDir,
      readDenyContext: { env: { WM_JOB_ID: JOB_ID }, root },
    };
  }

  function options(
    run: InvestigateClaudeOptions<OkPayload>["run"],
    overrides: Partial<InvestigateClaudeOptions<OkPayload>> = {},
  ): InvestigateClaudeOptions<OkPayload> {
    return {
      run,
      workItemId: 7,
      stage: "investigate",
      attempt: 1,
      model: "claude-sonnet-5-5",
      prompt: "investigate this",
      appendSystemPromptFile: "/run/prompt.md",
      jsonSchema: { type: "object" },
      isStructuredOutput: isOkPayload,
      maxTurns: 10,
      maxBudgetUsd: 2,
      cwd: "/srv/investigate/7",
      oauthToken: "oauth-token-value",
      timeoutMs: 60_000,
      recording: { mode: "skip" },
      proof: mintIsolationProof(),
      ...overrides,
    };
  }

  function argvOf(fake: ReturnType<typeof createFakeCommandRunner>): string[] {
    return [...(fake.calls[0]?.argv ?? [])];
  }

  function valueAfter(
    argv: readonly string[],
    flag: string,
  ): string | undefined {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  }

  /** 隔離に効く引数を上書きしようとする呼び出し。型の上で受けない項目を、型を通さずに渡す。 */
  async function runHostile() {
    const fake = createFakeCommandRunner([OK]);
    const hostile = {
      ...options(fake.run),
      tools: ["Bash"],
      permissionMode: "acceptEdits",
      settingSources: ["project"],
      allowedTools: ["Bash", "Edit"],
      addDirs: ["/"],
      claudeConfigDir: "/home/person/.claude",
      home: "/home/person",
      path: "/evil",
      tmpDir: "/tmp",
      readDenyPaths: [],
      runAs: { uid: 1, gid: 1 },
      beforeRetry: async () => true,
    };
    await runInvestigateClaudeWithDeps(hostile, deps());
    return fake;
  }

  describe("the options it accepts", () => {
    test("accepts only the prompt, schema, model, budget, timeout, cwd, work item, recording and proof", () => {
      const keys: Record<keyof InvestigateClaudeOptions<unknown>, true> = {
        run: true,
        workItemId: true,
        stage: true,
        attempt: true,
        model: true,
        prompt: true,
        appendSystemPromptFile: true,
        jsonSchema: true,
        isStructuredOutput: true,
        maxTurns: true,
        maxBudgetUsd: true,
        cwd: true,
        oauthToken: true,
        timeoutMs: true,
        recording: true,
        proof: true,
      };
      expect(Object.keys(keys).sort()).toEqual(
        [
          "appendSystemPromptFile",
          "attempt",
          "cwd",
          "isStructuredOutput",
          "jsonSchema",
          "maxBudgetUsd",
          "maxTurns",
          "model",
          "oauthToken",
          "prompt",
          "proof",
          "recording",
          "run",
          "stage",
          "timeoutMs",
          "workItemId",
        ].sort(),
      );
    });
  });

  describe("the public function", () => {
    test("ignores a second argument that points the settings elsewhere", async () => {
      // 第2引数が効くと、ジョブの外でもClaudeが起動する。効かなければ、ジョブの検査で止まる。
      const withExtra: (
        opts: InvestigateClaudeOptions<OkPayload>,
        extra: InvestigateClaudeDeps,
      ) => Promise<unknown> = runInvestigateClaude;
      const savedJobId = process.env.WM_JOB_ID;
      Reflect.deleteProperty(process.env, "WM_JOB_ID");
      const fake = createFakeCommandRunner([OK]);
      try {
        await withExtra(options(fake.run), deps()).catch(() => undefined);
      } finally {
        if (savedJobId !== undefined) process.env.WM_JOB_ID = savedJobId;
      }
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("the arguments that decide the isolation", () => {
    test("hands the allowed tools of the constant to claude", async () => {
      const fake = createFakeCommandRunner([OK]);
      const original = ISOLATION_ARGS.allowedTools;
      Reflect.set(ISOLATION_ARGS, "allowedTools", ["Read"]);
      try {
        await runInvestigateClaudeWithDeps(options(fake.run), deps());
      } finally {
        Reflect.set(ISOLATION_ARGS, "allowedTools", original);
      }
      expect(argvOf(fake)).toContain("--allowedTools");
    });

    test("hands the added directories of the constant to claude", async () => {
      const fake = createFakeCommandRunner([OK]);
      const original = ISOLATION_ARGS.addDirs;
      Reflect.set(ISOLATION_ARGS, "addDirs", ["/srv/extra"]);
      try {
        await runInvestigateClaudeWithDeps(options(fake.run), deps());
      } finally {
        Reflect.set(ISOLATION_ARGS, "addDirs", original);
      }
      expect(argvOf(fake)).toContain("--add-dir");
    });

    test("limits the tools to Read, Glob and Grep", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(valueAfter(argvOf(fake), "--tools")).toBe("Read,Glob,Grep");
    });

    test("uses the dontAsk permission mode", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(valueAfter(argvOf(fake), "--permission-mode")).toBe("dontAsk");
    });

    test("reads only the user setting source", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(valueAfter(argvOf(fake), "--setting-sources")).toBe("user");
    });

    test("restricts the file operations", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(argvOf(fake)).toContain("--restricted");
    });

    test("passes no allowed tools", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(argvOf(fake)).not.toContain("--allowedTools");
    });

    test("adds no directory", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(argvOf(fake)).not.toContain("--add-dir");
    });

    test("runs in the given working directory", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(fake.calls[0]?.options?.cwd).toBe("/srv/investigate/7");
    });

    test("passes the prompt on the standard input", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(fake.calls[0]?.options?.stdin).toBe("investigate this");
    });

    test("gives the process only the minimal environment", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      const allowed = new Set([
        "CLAUDE_CODE_OAUTH_TOKEN",
        "DISABLE_AUTOUPDATER",
        "CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS",
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "PATH",
        "TMPDIR",
        "CLAUDE_CODE_TMPDIR",
      ]);
      const extra = Object.keys(fake.calls[0]?.options?.env ?? {}).filter(
        (key) => !allowed.has(key),
      );
      expect(extra).toEqual([]);
    });

    test("points the configuration at the directory of the job", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(fake.calls[0]?.options?.env?.CLAUDE_CONFIG_DIR).toBe(
        join(tmpDir, "claude-config"),
      );
    });

    test("writes the fixed deny rules to the settings of the job", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      const text = await readFile(
        join(tmpDir, "claude-config", "settings.json"),
        "utf8",
      );
      const parsed: unknown = JSON.parse(text);
      const expected = buildReadDenyPaths(
        process.env.HOME ?? homedir(),
      ).flatMap((path) => [`Read(/${path})`, `Read(/${path}/**)`]);
      expect(parsed).toEqual({ permissions: { deny: expected } });
    });
  });

  describe("the whole call to claude", () => {
    /** 呼び出しごとに変わってよい項目。これ以外のargvの要素は固定である。 */
    const VARIABLE = {
      appendSystemPromptFile: "/run/other-prompt.md",
      jsonSchema: { type: "object", required: ["ok"] },
      maxTurns: 3,
      maxBudgetUsd: 0.5,
      model: "claude-opus-5-5",
    };

    function expectedArgv(v: {
      readonly appendSystemPromptFile: string;
      readonly jsonSchema: Record<string, unknown>;
      readonly maxTurns: number;
      readonly maxBudgetUsd: number;
      readonly model: string;
    }): string[] {
      return [
        "claude",
        "-p",
        "--append-system-prompt-file",
        v.appendSystemPromptFile,
        "--json-schema",
        JSON.stringify(v.jsonSchema),
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "Read,Glob,Grep",
        "--setting-sources",
        "user",
        "--strict-mcp-config",
        "--restricted",
        "--max-turns",
        String(v.maxTurns),
        "--max-budget-usd",
        String(v.maxBudgetUsd),
        "--model",
        v.model,
      ];
    }

    function expectedEnv(): Record<string, string> {
      const path = process.env.PATH;
      return {
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value",
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
        CLAUDE_CONFIG_DIR: join(tmpDir, "claude-config"),
        HOME: process.env.HOME ?? homedir(),
        ...(path === undefined ? {} : { PATH: path }),
        TMPDIR: tmpDir,
        CLAUDE_CODE_TMPDIR: tmpDir,
      };
    }

    function expectedSettings() {
      return {
        permissions: {
          deny: buildReadDenyPaths(process.env.HOME ?? homedir()).flatMap(
            (path) => [`Read(/${path})`, `Read(/${path}/**)`],
          ),
        },
      };
    }

    function argvsOf(fake: ReturnType<typeof createFakeCommandRunner>) {
      return fake.calls.map((call) => [...call.argv]);
    }

    /** 起動の時点の`settings.json`の内容を、呼び出しごとに控える。無ければ`null`。 */
    function runnerThatReadsSettings(
      responses: Parameters<typeof createFakeCommandRunner>[0],
    ) {
      const fake = createFakeCommandRunner(responses);
      const seen: unknown[] = [];
      const run: CommandRunner = async (argv, runOptions) => {
        const text = await readFile(
          join(tmpDir, "claude-config", "settings.json"),
          "utf8",
        ).catch(() => null);
        seen.push(text === null ? null : JSON.parse(text));
        return fake.run(argv, runOptions);
      };
      return { run, fake, seen };
    }

    test("starts claude once on a success", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(fake.calls).toHaveLength(1);
    });

    test("passes exactly the fixed arguments and the variable ones", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run, VARIABLE), deps());
      expect(argvsOf(fake)).toEqual([expectedArgv(VARIABLE)]);
    });

    test("passes the same arguments to the retry", async () => {
      const fake = createFakeCommandRunner([wrongShape(), OK]);
      await runInvestigateClaudeWithDeps(options(fake.run, VARIABLE), deps());
      expect(argvsOf(fake)).toEqual([
        expectedArgv(VARIABLE),
        expectedArgv(VARIABLE),
      ]);
    });

    test("passes exactly the working directory, environment, prompt and timeout", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(fake.calls[0]?.options).toEqual({
        cwd: "/srv/investigate/7",
        env: expectedEnv(),
        stdin: "investigate this",
        timeoutMs: 60_000,
      });
    });

    test("passes the same working directory, environment and timeout to the retry", async () => {
      const fake = createFakeCommandRunner([wrongShape(), OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(fake.calls[1]?.options).toEqual({
        cwd: "/srv/investigate/7",
        env: expectedEnv(),
        stdin: expect.stringContaining("investigate this"),
        timeoutMs: 60_000,
      });
    });

    test("has the deny rules in the settings when claude starts", async () => {
      const { run, seen } = runnerThatReadsSettings([OK]);
      await runInvestigateClaudeWithDeps(options(run), deps());
      expect(seen).toEqual([expectedSettings()]);
    });

    test("has the deny rules in the settings when claude starts again for the retry", async () => {
      const { run, seen } = runnerThatReadsSettings([wrongShape(), OK]);
      await runInvestigateClaudeWithDeps(options(run), deps());
      expect(seen).toEqual([expectedSettings(), expectedSettings()]);
    });
  });

  describe("an attempt to change the isolation through extra properties", () => {
    test("keeps the whole argv", async () => {
      const fake = await runHostile();
      expect(fake.calls.map((call) => [...call.argv])).toEqual([
        [
          "claude",
          "-p",
          "--append-system-prompt-file",
          "/run/prompt.md",
          "--json-schema",
          JSON.stringify({ type: "object" }),
          "--output-format",
          "json",
          "--permission-mode",
          "dontAsk",
          "--tools",
          "Read,Glob,Grep",
          "--setting-sources",
          "user",
          "--strict-mcp-config",
          "--restricted",
          "--max-turns",
          "10",
          "--max-budget-usd",
          "2",
          "--model",
          "claude-sonnet-5-5",
        ],
      ]);
    });

    test("keeps the tools", async () => {
      const fake = await runHostile();
      expect(valueAfter(argvOf(fake), "--tools")).toBe("Read,Glob,Grep");
    });

    test("keeps the permission mode", async () => {
      const fake = await runHostile();
      expect(valueAfter(argvOf(fake), "--permission-mode")).toBe("dontAsk");
    });

    test("keeps the setting sources", async () => {
      const fake = await runHostile();
      expect(valueAfter(argvOf(fake), "--setting-sources")).toBe("user");
    });

    test("passes no allowed tools", async () => {
      const fake = await runHostile();
      expect(argvOf(fake)).not.toContain("--allowedTools");
    });

    test("adds no directory", async () => {
      const fake = await runHostile();
      expect(argvOf(fake)).not.toContain("--add-dir");
    });

    test("keeps the configuration directory of the job", async () => {
      const fake = await runHostile();
      expect(fake.calls[0]?.options?.env?.CLAUDE_CONFIG_DIR).toBe(
        join(tmpDir, "claude-config"),
      );
    });

    test("keeps the PATH of the worker", async () => {
      const fake = await runHostile();
      expect(fake.calls[0]?.options?.env?.PATH).toBe(process.env.PATH);
    });

    test("keeps the deny rules in the settings", async () => {
      await runHostile();
      const text = await readFile(
        join(tmpDir, "claude-config", "settings.json"),
        "utf8",
      );
      expect(text).toContain("Read(//workspaces/**)");
    });
  });

  describe("before it starts claude", () => {
    test("throws when the working directory is below a denied path", async () => {
      const fake = createFakeCommandRunner([OK]);
      await expect(
        runInvestigateClaudeWithDeps(
          options(fake.run, { cwd: "/workspaces/repo/investigate-7" }),
          deps(),
        ),
      ).rejects.toThrow();
    });

    test("does not start claude when the working directory is below a denied path", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(
        options(fake.run, { cwd: "/workspaces/repo/investigate-7" }),
        deps(),
      ).catch(() => undefined);
      expect(fake.calls).toHaveLength(0);
    });

    test("throws when the working directory is below the temporary directory", async () => {
      const fake = createFakeCommandRunner([OK]);
      await expect(
        runInvestigateClaudeWithDeps(
          options(fake.run, { cwd: "/tmp/work" }),
          deps(),
        ),
      ).rejects.toThrow();
    });

    test("throws when the job directory is not the one of this job", async () => {
      const fake = createFakeCommandRunner([OK]);
      await expect(
        runInvestigateClaudeWithDeps(options(fake.run), {
          ...deps(),
          tmpDir: join(root, "fj-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        }),
      ).rejects.toThrow();
    });

    test("does not start claude outside a job", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), {
        ...deps(),
        readDenyContext: { env: {}, root },
      }).catch(() => undefined);
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("the proof of the isolation", () => {
    /** 型を通さずに、証拠の位置へ偽物を渡す。`Reflect.get`は`any`を返す。 */
    function withProof(
      run: InvestigateClaudeOptions<OkPayload>["run"],
      proof: unknown,
    ): InvestigateClaudeOptions<OkPayload> {
      const holder: object = { proof };
      return { ...options(run), proof: Reflect.get(holder, "proof") };
    }

    test("does not start claude without a proof", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(
        withProof(fake.run, undefined),
        deps(),
      ).catch(() => undefined);
      expect(fake.calls).toHaveLength(0);
    });

    test("rejects an object that only has the shape of a proof", async () => {
      const fake = createFakeCommandRunner([OK]);
      await expect(
        runInvestigateClaudeWithDeps(withProof(fake.run, {}), deps()),
      ).rejects.toBeInstanceOf(IsolationProofError);
    });

    test("rejects a proof that went through JSON", async () => {
      const fake = createFakeCommandRunner([OK]);
      const copy: unknown = JSON.parse(JSON.stringify(mintIsolationProof()));
      await expect(
        runInvestigateClaudeWithDeps(withProof(fake.run, copy), deps()),
      ).rejects.toBeInstanceOf(IsolationProofError);
    });

    test("checks the proof before the working directory", async () => {
      const fake = createFakeCommandRunner([OK]);
      await expect(
        runInvestigateClaudeWithDeps(
          {
            ...withProof(fake.run, undefined),
            cwd: "/workspaces/repo/investigate-7",
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(IsolationProofError);
    });

    test("checks the proof in the public function too", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaude(withProof(fake.run, undefined)).catch(
        () => undefined,
      );
      expect(fake.calls).toHaveLength(0);
    });

    test("rejects in the public function with the error of the proof", async () => {
      const fake = createFakeCommandRunner([OK]);
      await expect(
        runInvestigateClaude(withProof(fake.run, undefined)),
      ).rejects.toBeInstanceOf(IsolationProofError);
    });

    test("starts claude with a proof that was minted", async () => {
      const fake = createFakeCommandRunner([OK]);
      await runInvestigateClaudeWithDeps(options(fake.run), deps());
      expect(fake.calls).toHaveLength(1);
    });
  });

  describe("the result of a success", () => {
    test("returns the structured output", async () => {
      const fake = createFakeCommandRunner([OK]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result).toMatchObject({
        outcome: "success",
        structuredOutput: { ok: true },
        retried: false,
      });
    });

    test("does not return the raw output of claude", async () => {
      const fake = createFakeCommandRunner([OK]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect("raw" in result).toBe(false);
    });
  });

  describe("the failure details", () => {
    test("replaces the standard error of a non-zero exit with its code and length", async () => {
      const fake = createFakeCommandRunner([fail(`password=${LEAK}`)]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result).toMatchObject({
        outcome: "failure",
        reason: "non_zero_exit",
        detail: expect.stringMatching(
          /^non_zero_exit \(\d+ characters withheld\)$/,
        ),
      });
    });

    test("keeps the standard error of a non-zero exit out of the result", async () => {
      const fake = createFakeCommandRunner([fail(`password=${LEAK}`)]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(JSON.stringify(result)).not.toContain(LEAK);
    });

    test("keeps the text of an error that claude reported out of the result", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout({ is_error: true, result: LEAK }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(JSON.stringify(result)).not.toContain(LEAK);
    });

    test("names claude_error by its code", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout({ is_error: true, result: LEAK }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result).toMatchObject({
        detail: expect.stringMatching(
          /^claude_error \(\d+ characters withheld\)$/,
        ),
      });
    });

    test("keeps a structured output that fails the schema out of the result, also after a retry", async () => {
      const fake = createFakeCommandRunner([wrongShape(), wrongShape()]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(JSON.stringify(result)).not.toContain(LEAK);
    });

    test("names invalid_structured_output by its code", async () => {
      const fake = createFakeCommandRunner([wrongShape(), wrongShape()]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result).toMatchObject({
        detail: expect.stringMatching(
          /^invalid_structured_output \(\d+ characters withheld\)$/,
        ),
      });
    });

    test("keeps the parse error of an invalid JSON out of the result", async () => {
      const bad = {
        stdout: `${LEAK} not json`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
      const fake = createFakeCommandRunner([bad, bad]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(JSON.stringify(result)).not.toContain(LEAK);
    });

    test("names invalid_json by its code", async () => {
      const bad = {
        stdout: `${LEAK} not json`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
      const fake = createFakeCommandRunner([bad, bad]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result).toMatchObject({
        detail: expect.stringMatching(
          /^invalid_json \(\d+ characters withheld\)$/,
        ),
      });
    });

    test("names a timeout by its code", async () => {
      const fake = createFakeCommandRunner([timeout(LEAK)]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result).toMatchObject({
        detail: expect.stringMatching(/^timeout \(\d+ characters withheld\)$/),
      });
    });

    test("replaces the error of the record of the last attempt", async () => {
      const fake = createFakeCommandRunner([fail(`password=${LEAK}`)]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result.agentRun.error).toMatch(
        /^non_zero_exit \(\d+ characters withheld\)$/,
      );
    });

    test("replaces the error of the record of the discarded first attempt", async () => {
      const fake = createFakeCommandRunner([wrongShape(), wrongShape()]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result.discardedAgentRun?.error).toMatch(
        /^discarded_attempt \(\d+ characters withheld\)$/,
      );
    });
  });

  describe("a success after a discarded first attempt", () => {
    test("keeps the output of the discarded attempt out of the result", async () => {
      const fake = createFakeCommandRunner([wrongShape(), OK]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(JSON.stringify(result)).not.toContain(LEAK);
    });

    test("replaces the error of the discarded attempt with its code and length", async () => {
      const fake = createFakeCommandRunner([wrongShape(), OK]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result.discardedAgentRun?.error).toMatch(
        /^discarded_attempt \(\d+ characters withheld\)$/,
      );
    });

    test("reports that it retried", async () => {
      const fake = createFakeCommandRunner([wrongShape(), OK]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result.retried).toBe(true);
    });
  });

  describe("the recording", () => {
    test("records the discarded attempt and the last attempt, both without the output", async () => {
      const fake = createFakeCommandRunner([wrongShape(), OK]);
      const records: AgentRunRecord[] = [];
      await runInvestigateClaudeWithDeps(
        options(fake.run, {
          recording: {
            mode: "record",
            record: async (agentRun) => {
              records.push(agentRun);
              return records.length;
            },
          },
        }),
        deps(),
      );
      expect(JSON.stringify(records)).not.toContain(LEAK);
    });

    test("records two rows after a retry", async () => {
      const fake = createFakeCommandRunner([wrongShape(), OK]);
      const records: AgentRunRecord[] = [];
      await runInvestigateClaudeWithDeps(
        options(fake.run, {
          recording: {
            mode: "record",
            record: async (agentRun) => {
              records.push(agentRun);
              return records.length;
            },
          },
        }),
        deps(),
      );
      expect(records).toHaveLength(2);
    });

    test("returns the id of the row of the last attempt", async () => {
      const fake = createFakeCommandRunner([wrongShape(), OK]);
      let next = 100;
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run, {
          recording: {
            mode: "record",
            record: async () => {
              next += 1;
              return next;
            },
          },
        }),
        deps(),
      );
      expect(result.agentRunId).toBe(102);
    });

    test("records nothing when it is told to skip", async () => {
      const fake = createFakeCommandRunner([OK]);
      const result = await runInvestigateClaudeWithDeps(
        options(fake.run),
        deps(),
      );
      expect(result.agentRunId).toBeNull();
    });
  });
});

describe("ISOLATION_FINGERPRINT", () => {
  test("is a sha256 hex digest", () => {
    expect(ISOLATION_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is the digest of the fixed arguments and the fixed deny list", () => {
    expect(ISOLATION_FINGERPRINT).toBe(
      computeIsolationFingerprint(ISOLATION_ARGS, READ_DENY_BASE_PATHS),
    );
  });

  test("is pinned, so that a change of the isolation shows up in this test", () => {
    expect(ISOLATION_FINGERPRINT).toBe(
      "7de0320254175148f5f0bf00dda725612d11052ba3489404d2f60f29a76a9db1",
    );
  });

  test("changes when a tool is added", () => {
    expect(
      computeIsolationFingerprint(
        { ...ISOLATION_ARGS, tools: [...ISOLATION_ARGS.tools, "Bash"] },
        READ_DENY_BASE_PATHS,
      ),
    ).not.toBe(ISOLATION_FINGERPRINT);
  });

  test("changes when a denied path is removed", () => {
    expect(
      computeIsolationFingerprint(
        ISOLATION_ARGS,
        READ_DENY_BASE_PATHS.slice(1),
      ),
    ).not.toBe(ISOLATION_FINGERPRINT);
  });

  test("changes when the restriction is switched off", () => {
    expect(
      computeIsolationFingerprint(
        { ...ISOLATION_ARGS, restricted: false },
        READ_DENY_BASE_PATHS,
      ),
    ).not.toBe(ISOLATION_FINGERPRINT);
  });
});

// 差し替え口つきの入口は、テスト専用である。
// 本番のファイルが参照すると、第2引数でジョブ専用の置き場の検査を迂回できる。
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。
// 追えない形がある。識別子を連結や別名で組み立てる参照は数えられない。
describe("the entry that takes injected dependencies", () => {
  const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const DEFINING_FILE = "lib/investigate_claude.ts";
  const ENTRY = /(?<![\w$])runInvestigateClaudeWithDeps(?![\w$])/g;

  function countIn(code: string): number {
    return [...code.matchAll(ENTRY)].length;
  }

  function countInFile(path: string): number {
    return countIn(
      transpiler.transformSync(readFileSync(join(FACTORY_DIR, path), "utf8")),
    );
  }

  /** `f/factory`の下の、テストを除くすべての`.ts`の相対パス。 */
  function productionSources(): string[] {
    return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
      .filter((path) => !path.endsWith(".test.ts"))
      .sort();
  }

  test("is named by no production file other than the one that defines it", () => {
    const found = productionSources().filter(
      (path) => path !== DEFINING_FILE && countInFile(path) > 0,
    );
    expect(found).toEqual([]);
  });

  test("is named in the defining file by its definition and by the public function only", () => {
    expect(countInFile(DEFINING_FILE)).toBe(2);
  });

  test("counts an import under another name", () => {
    const code = transpiler.transformSync(
      'import { runInvestigateClaudeWithDeps as run } from "./investigate_claude.ts"; run();',
    );
    expect(countIn(code)).toBe(1);
  });

  test("does not count a longer name", () => {
    const code = transpiler.transformSync(
      "const x = runInvestigateClaudeWithDepsX;",
    );
    expect(countIn(code)).toBe(0);
  });
});

// 公開の入口`runInvestigateClaude`は、定義元と、調査の生成のstepの他のどの本番のファイルも参照しない。
// 参照が増えると、調査の入口が`investigate_enabled`を通らずに調査のClaudeを起動できる。
// 生成のstepは、設定の再確認と排他の確認と関門の後でだけ呼ぶ。その順序は、`tests/scripts/investigate_generate.test.ts`が固定する。
// 入口を繋ぐ変更は、この許可を直すので、必ず保護パスに触れる。
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。
// 追えない形がある。識別子を連結や別名で組み立てる参照は数えられない。
describe("the public entry of the investigation", () => {
  const F_DIR = join(import.meta.dir, "../../f");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const DEFINING_FILE = "factory/lib/investigate_claude.ts";
  /** 入口を呼んでよい本番のファイル。 */
  const ALLOWED_CALLERS = ["factory/steps/investigate_generate.ts"];
  const ENTRY = /(?<![\w$])runInvestigateClaude(?![\w$])/g;

  function countIn(code: string): number {
    return [...code.matchAll(ENTRY)].length;
  }

  function countInFile(path: string): number {
    return countIn(
      transpiler.transformSync(readFileSync(join(F_DIR, path), "utf8")),
    );
  }

  /** `f`の下の、テストを除くすべての`.ts`の相対パス。 */
  function productionSources(): string[] {
    return [...new Bun.Glob("**/*.ts").scanSync(F_DIR)]
      .filter((path) => !path.endsWith(".test.ts"))
      .sort();
  }

  test("is named by no production file other than the one that defines it and the generate step", () => {
    const found = productionSources().filter(
      (path) => path !== DEFINING_FILE && countInFile(path) > 0,
    );
    expect(found).toEqual(ALLOWED_CALLERS);
  });

  test("is named in the defining file by its definition only", () => {
    expect(countInFile(DEFINING_FILE)).toBe(1);
  });

  test("is named in the generate step by its import and by the one place that hands it over", () => {
    expect(countInFile("factory/steps/investigate_generate.ts")).toBe(2);
  });

  test("counts an import and a call in a new script", () => {
    const code = transpiler.transformSync(
      'import { runInvestigateClaude } from "./lib/investigate_claude.ts"; await runInvestigateClaude({});',
    );
    expect(countIn(code)).toBe(2);
  });

  test("counts an import under another name", () => {
    const code = transpiler.transformSync(
      'import { runInvestigateClaude as run } from "./lib/investigate_claude.ts"; run();',
    );
    expect(countIn(code)).toBe(1);
  });

  test("does not count the entry that takes injected dependencies", () => {
    const code = transpiler.transformSync(
      "const x = runInvestigateClaudeWithDeps;",
    );
    expect(countIn(code)).toBe(0);
  });
});

// 隔離の測定が使う入口は、証拠を要らない代わりに、固定の作業ディレクトリと固定の形の組だけを受ける。
describe("runIsolationProbeClaude", () => {
  const HEX = "0123456789abcdef0123456789abcdef";
  const PROBE_CWD = investigateWorktreeDir(PROBE_RESERVED_ID);
  const PROBE_OK = {
    stdout: claudeJsonStdout({ structured_output: { attempted: true } }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
  const FIRST_SESSION = "11111111-1111-4111-8111-111111111111";
  const LAST_SESSION = "22222222-2222-4222-8222-222222222222";

  let root: string;
  let tmpDir: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "isolation-probe-"));
    tmpDir = join(root, `fj-${JOB_ID}`);
    home = join(root, "home");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps() {
    return {
      tmpDir,
      home,
      readDenyContext: { env: { WM_JOB_ID: JOB_ID }, root },
    };
  }

  function tmpPath(file = "canary.txt"): string {
    return `/tmp/.factory-probe-${HEX}/${file}`;
  }

  function probeOptions(
    run: IsolationProbeClaudeOptions["run"],
    overrides: Partial<IsolationProbeClaudeOptions> = {},
  ): IsolationProbeClaudeOptions {
    return {
      run,
      oauthToken: "oauth-token-value",
      model: "claude-sonnet-5-5",
      cwd: PROBE_CWD,
      pairs: [{ tool: "Read", path: tmpPath() }],
      ...overrides,
    };
  }

  /** 型の上で受けない値を、型を通さずに渡す。 */
  function pairWith(
    tool: string,
    path: string,
  ): IsolationProbeClaudeOptions["pairs"] {
    return JSON.parse(JSON.stringify([{ tool, path }]));
  }

  function argvOf(fake: ReturnType<typeof createFakeCommandRunner>): string[] {
    return [...(fake.calls[0]?.argv ?? [])];
  }

  /** 呼び出しごとに変わってよい値を伏せる。 */
  function maskVariable(argv: readonly string[]): string[] {
    const variable = new Set([
      "--append-system-prompt-file",
      "--json-schema",
      "--max-turns",
      "--max-budget-usd",
      "--model",
    ]);
    return argv.map((value, index) =>
      variable.has(argv[index - 1] ?? "") ? "<variable>" : value,
    );
  }

  /** 調査の入口で、同じ形の呼び出しを1回行う。 */
  async function runProduction() {
    const production = createFakeCommandRunner([OK]);
    await runInvestigateClaudeWithDeps(
      {
        run: production.run,
        workItemId: 7,
        stage: "investigate",
        attempt: 1,
        model: "claude-sonnet-5-5",
        prompt: "p",
        appendSystemPromptFile: "/run/prompt.md",
        jsonSchema: { type: "object" },
        isStructuredOutput: isOkPayload,
        maxTurns: 10,
        maxBudgetUsd: 2,
        cwd: "/srv/investigate/7",
        oauthToken: "oauth-token-value",
        timeoutMs: 60_000,
        recording: { mode: "skip" },
        proof: mintIsolationProof(),
      },
      deps(),
    );
    return production;
  }

  describe("the options it accepts", () => {
    test("accepts only the runner, token, model, working directory and pairs", () => {
      const keys: Record<keyof IsolationProbeClaudeOptions, true> = {
        run: true,
        oauthToken: true,
        model: true,
        cwd: true,
        pairs: true,
      };
      expect(Object.keys(keys).sort()).toEqual([
        "cwd",
        "model",
        "oauthToken",
        "pairs",
        "run",
      ]);
    });
  });

  describe("the public function", () => {
    test("ignores a second argument that points the settings elsewhere", async () => {
      const withExtra: (
        opts: IsolationProbeClaudeOptions,
        extra: InvestigateClaudeDeps,
      ) => Promise<unknown> = runIsolationProbeClaude;
      const savedJobId = process.env.WM_JOB_ID;
      Reflect.deleteProperty(process.env, "WM_JOB_ID");
      const fake = createFakeCommandRunner([PROBE_OK]);
      try {
        await withExtra(probeOptions(fake.run), deps()).catch(() => undefined);
      } finally {
        if (savedJobId !== undefined) process.env.WM_JOB_ID = savedJobId;
      }
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("the working directory", () => {
    test("starts claude in the reserved directory of the probe", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(probeOptions(fake.run), deps());
      expect(fake.calls[0]?.options?.cwd).toBe(
        `${INVESTIGATE_ROOT}/${PROBE_RESERVED_ID}`,
      );
    });

    test("rejects the directory of a work item", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await expect(
        runIsolationProbeClaudeWithDeps(
          probeOptions(fake.run, { cwd: investigateWorktreeDir(7) }),
          deps(),
        ),
      ).rejects.toThrow("working directory");
    });

    test("does not start claude in the directory of a work item", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run, { cwd: investigateWorktreeDir(7) }),
        deps(),
      ).catch(() => undefined);
      expect(fake.calls).toHaveLength(0);
    });

    test("rejects a directory below the reserved one", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await expect(
        runIsolationProbeClaudeWithDeps(
          probeOptions(fake.run, { cwd: `${PROBE_CWD}/sub` }),
          deps(),
        ),
      ).rejects.toThrow("working directory");
    });
  });

  describe("the pairs", () => {
    test("accepts a canary under /tmp", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(probeOptions(fake.run), deps());
      expect(fake.calls).toHaveLength(1);
    });

    test("accepts a canary under /run/factory-tmp", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run, {
          pairs: [
            {
              tool: "Read",
              path: `/run/factory-tmp/fj-${JOB_ID}/.factory-probe-${HEX}/canary.txt`,
            },
          ],
        }),
        deps(),
      );
      expect(fake.calls).toHaveLength(1);
    });

    test("accepts a canary under the home directory", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run, {
          pairs: [
            { tool: "Read", path: `${home}/.factory-probe-${HEX}/canary.txt` },
          ],
        }),
        deps(),
      );
      expect(fake.calls).toHaveLength(1);
    });

    test("accepts three pairs", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run, {
          pairs: [
            { tool: "Read", path: tmpPath("a.txt") },
            { tool: "Read", path: tmpPath("b.txt") },
            { tool: "Read", path: tmpPath("c.txt") },
          ],
        }),
        deps(),
      );
      expect(fake.calls).toHaveLength(1);
    });

    test("accepts a Read of a canary below the working directory", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run, {
          pairs: [
            {
              tool: "Read",
              path: `${PROBE_CWD}/.factory-probe-${HEX}/canary.txt`,
            },
          ],
        }),
        deps(),
      );
      expect(fake.calls).toHaveLength(1);
    });

    function directoryPlaces(): [string, string][] {
      return [
        ["/tmp", `/tmp/.factory-probe-${HEX}`],
        [
          "/run/factory-tmp",
          `/run/factory-tmp/fj-${JOB_ID}/.factory-probe-${HEX}`,
        ],
        ["the home directory", `${home}/.factory-probe-${HEX}`],
        ["the working directory", `${PROBE_CWD}/.factory-probe-${HEX}`],
      ];
    }

    test.each(["Glob", "Grep"])(
      "accepts a %s of a canary directory in every place",
      async (tool) => {
        const results: number[] = [];
        for (const [, path] of directoryPlaces()) {
          const fake = createFakeCommandRunner([PROBE_OK]);
          await runIsolationProbeClaudeWithDeps(
            probeOptions(fake.run, { pairs: pairWith(tool, path) }),
            deps(),
          );
          results.push(fake.calls.length);
        }
        expect(results).toEqual([1, 1, 1, 1]);
      },
    );

    const REJECTED: [string, IsolationProbeClaudeOptions["pairs"]][] = [
      ["no pair", []],
      [
        "four pairs",
        [
          { tool: "Read", path: tmpPath("a.txt") },
          { tool: "Read", path: tmpPath("b.txt") },
          { tool: "Read", path: tmpPath("c.txt") },
          { tool: "Read", path: tmpPath("d.txt") },
        ],
      ],
      ["a tool other than Read", pairWith("Bash", tmpPath())],
      ["a path outside the canary form", pairWith("Read", "/etc/passwd")],
      ["a relative path", pairWith("Read", `.factory-probe-${HEX}/canary.txt`)],
      [
        "a parent segment",
        pairWith("Read", `/tmp/.factory-probe-${HEX}/../../etc/passwd`),
      ],
      [
        "a name of the wrong form",
        pairWith("Read", "/tmp/.factory-probe-xyz/canary.txt"),
      ],
      [
        "an uppercase hex name",
        pairWith("Read", `/tmp/.factory-probe-${HEX.toUpperCase()}/canary.txt`),
      ],
      [
        "a prefix that is not allowed",
        pairWith("Read", `/var/tmp/.factory-probe-${HEX}/canary.txt`),
      ],
      [
        "a file below another directory",
        pairWith("Read", `/tmp/.factory-probe-${HEX}/sub/canary.txt`),
      ],
      ["a file named with two dots", pairWith("Read", tmpPath(".."))],
      [
        "a job directory that is not a job id",
        pairWith(
          "Read",
          `/run/factory-tmp/fj-x/.factory-probe-${HEX}/canary.txt`,
        ),
      ],
      [
        "a trailing slash",
        pairWith("Read", `/tmp/.factory-probe-${HEX}/canary.txt/`),
      ],
      ["a Read of a directory", pairWith("Read", `/tmp/.factory-probe-${HEX}`)],
      [
        "a Read of a directory below the working directory",
        pairWith("Read", `${PROBE_CWD}/.factory-probe-${HEX}`),
      ],
      [
        "a Read of a file below another directory of the working directory",
        pairWith("Read", `${PROBE_CWD}/src/.factory-probe-${HEX}/canary.txt`),
      ],
      ["a Glob of a file", pairWith("Glob", tmpPath())],
      ["a Grep of a file", pairWith("Grep", tmpPath())],
      ["a Glob of /tmp", pairWith("Glob", "/tmp")],
      ["a Grep of /root", pairWith("Grep", "/root")],
      [
        "a Glob of the job directory",
        pairWith("Glob", `/run/factory-tmp/fj-${JOB_ID}`),
      ],
      [
        "a Glob of a directory with a trailing slash",
        pairWith("Glob", `/tmp/.factory-probe-${HEX}/`),
      ],
      [
        "a Grep of a directory with a trailing slash",
        pairWith("Grep", `/tmp/.factory-probe-${HEX}/`),
      ],
      [
        "a Glob of a directory with a parent segment",
        pairWith("Glob", `/tmp/.factory-probe-${HEX}/..`),
      ],
      [
        "a Glob of a directory reached through a parent segment",
        pairWith("Glob", `/tmp/x/../.factory-probe-${HEX}`),
      ],
      [
        "a Glob of a directory of another prefix",
        pairWith("Glob", `/var/tmp/.factory-probe-${HEX}`),
      ],
      [
        "a Grep of a directory with a name of the wrong form",
        pairWith("Grep", "/tmp/.factory-probe-xyz"),
      ],
      [
        "a Glob of a directory below the canary directory",
        pairWith("Glob", `/tmp/.factory-probe-${HEX}/sub`),
      ],
      [
        "a Glob of a canary directory in a job directory that is not a job id",
        pairWith("Glob", `/run/factory-tmp/fj-x/.factory-probe-${HEX}`),
      ],
      [
        "a Glob of a relative directory",
        pairWith("Glob", `.factory-probe-${HEX}`),
      ],
      [
        "two Glob pairs",
        JSON.parse(
          JSON.stringify([
            { tool: "Glob", path: `/tmp/.factory-probe-${HEX}` },
            { tool: "Glob", path: `${home}/.factory-probe-${HEX}` },
          ]),
        ),
      ],
      [
        "two Grep pairs",
        JSON.parse(
          JSON.stringify([
            { tool: "Grep", path: `/tmp/.factory-probe-${HEX}` },
            { tool: "Grep", path: `${home}/.factory-probe-${HEX}` },
          ]),
        ),
      ],
      [
        "a Read and a Glob together",
        JSON.parse(
          JSON.stringify([
            { tool: "Read", path: tmpPath() },
            { tool: "Glob", path: `/tmp/.factory-probe-${HEX}` },
          ]),
        ),
      ],
      [
        "a Glob and a Grep together",
        JSON.parse(
          JSON.stringify([
            { tool: "Glob", path: `/tmp/.factory-probe-${HEX}` },
            { tool: "Grep", path: `/tmp/.factory-probe-${HEX}` },
          ]),
        ),
      ],
    ];

    test.each(REJECTED)("rejects %s", async (_name, pairs) => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await expect(
        runIsolationProbeClaudeWithDeps(
          probeOptions(fake.run, { pairs }),
          deps(),
        ),
      ).rejects.toThrow();
    });

    test.each(REJECTED)(
      "does not start claude for %s",
      async (_name, pairs) => {
        const fake = createFakeCommandRunner([PROBE_OK]);
        await runIsolationProbeClaudeWithDeps(
          probeOptions(fake.run, { pairs }),
          deps(),
        ).catch(() => undefined);
        expect(fake.calls).toHaveLength(0);
      },
    );
  });

  describe("the call to claude", () => {
    test("passes the same argv as the entry of an investigation, except the variable values", async () => {
      const probe = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(probeOptions(probe.run), deps());
      const production = await runProduction();
      expect(maskVariable(argvOf(probe))).toEqual(
        maskVariable(argvOf(production)),
      );
    });

    test("passes the same environment keys as the entry of an investigation", async () => {
      const probe = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(probeOptions(probe.run), deps());
      const production = await runProduction();
      expect(Object.keys(probe.calls[0]?.options?.env ?? {}).sort()).toEqual(
        Object.keys(production.calls[0]?.options?.env ?? {}).sort(),
      );
    });

    test("passes the given model", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run, { model: "claude-test-model" }),
        deps(),
      );
      const argv = argvOf(fake);
      expect(argv[argv.indexOf("--model") + 1]).toBe("claude-test-model");
    });

    test("allows two turns per pair and ten more", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(probeOptions(fake.run), deps());
      const argv = argvOf(fake);
      expect(argv[argv.indexOf("--max-turns") + 1]).toBe("12");
    });

    test("names every pair in the prompt on the standard input", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(probeOptions(fake.run), deps());
      expect(fake.calls[0]?.options?.stdin).toContain(tmpPath());
    });

    describe("the prompt and the turns of a search", () => {
      const DIR = `/tmp/.factory-probe-${HEX}`;
      const GLOB_PROMPT = [
        "This is a read-only check of file access.",
        "Call the Glob tool once, with exactly two parameters: pattern set to * and path set to the directory below. Pass no other parameter.",
        "Do not use any other tool.",
        "The call may be refused. That is expected, so do not retry it.",
        "After you have tried the call, return the structured output with attempted set to true.",
        "",
        `Directory: ${DIR}`,
      ].join("\n");
      const GREP_PROMPT = [
        "This is a read-only check of file access.",
        "Call the Grep tool once, with exactly three parameters: pattern set to FACTORY_PROBE_CANARY_[0-9a-f]{32}, path set to the directory below, and output_mode set to content. Pass no other parameter.",
        "Do not use any other tool.",
        "The call may be refused. That is expected, so do not retry it.",
        "After you have tried the call, return the structured output with attempted set to true.",
        "",
        `Directory: ${DIR}`,
      ].join("\n");

      async function runSearch(tool: string) {
        const fake = createFakeCommandRunner([PROBE_OK]);
        await runIsolationProbeClaudeWithDeps(
          probeOptions(fake.run, { pairs: pairWith(tool, DIR) }),
          deps(),
        );
        return fake;
      }

      test("fixes the prompt of a Glob", async () => {
        const fake = await runSearch("Glob");
        expect(fake.calls[0]?.options?.stdin).toBe(GLOB_PROMPT);
      });

      test("fixes the prompt of a Grep", async () => {
        const fake = await runSearch("Grep");
        expect(fake.calls[0]?.options?.stdin).toBe(GREP_PROMPT);
      });

      test.each(["Glob", "Grep"])(
        "does not put a canary value into the prompt of a %s",
        async (tool) => {
          const fake = await runSearch(tool);
          expect(fake.calls[0]?.options?.stdin).not.toMatch(
            /FACTORY_PROBE_CANARY_[0-9a-f]{32}/,
          );
        },
      );

      test.each(["Glob", "Grep"])(
        "does not ask for a retry in the prompt of a %s",
        async (tool) => {
          const fake = await runSearch(tool);
          expect(fake.calls[0]?.options?.stdin).toContain("do not retry it");
        },
      );

      test.each(["Glob", "Grep"])(
        "allows five turns for a %s",
        async (tool) => {
          const fake = await runSearch(tool);
          const argv = argvOf(fake);
          expect(argv[argv.indexOf("--max-turns") + 1]).toBe("5");
        },
      );
    });

    test("passes the oauth token as the token of the environment", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(probeOptions(fake.run), deps());
      expect(fake.calls[0]?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
        "oauth-token-value",
      );
    });

    test("writes the fixed deny rules to the settings of the job", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      await runIsolationProbeClaudeWithDeps(probeOptions(fake.run), deps());
      const text = await readFile(
        join(tmpDir, "claude-config", "settings.json"),
        "utf8",
      );
      const parsed: unknown = JSON.parse(text);
      const expected = buildReadDenyPaths(home).flatMap((path) => [
        `Read(/${path})`,
        `Read(/${path}/**)`,
      ]);
      expect(parsed).toEqual({ permissions: { deny: expected } });
    });
  });

  describe("the result", () => {
    test("has only the outcome, reason, retry flag, sessions, turns, duration and top-level keys", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(Object.keys(result).sort()).toEqual([
        "durationMs",
        "numTurns",
        "outcome",
        "reason",
        "retried",
        "sessionIds",
        "topLevelKeys",
      ]);
    });

    test("reports a success", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(result.outcome).toBe("success");
    });

    test("returns the session id of the run", async () => {
      const fake = createFakeCommandRunner([
        {
          ...PROBE_OK,
          stdout: claudeJsonStdout({
            structured_output: { attempted: true },
            session_id: LAST_SESSION,
          }),
        },
      ]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(result.sessionIds).toEqual([LAST_SESSION]);
    });

    test("returns the turns and the duration", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect([result.numTurns, result.durationMs]).toEqual([2, 100]);
    });

    test("returns the top-level keys of the standard output", async () => {
      const fake = createFakeCommandRunner([PROBE_OK]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(result.topLevelKeys).toEqual([
        "duration_ms",
        "is_error",
        "num_turns",
        "result",
        "session_id",
        "structured_output",
        "subtype",
        "total_cost_usd",
        "type",
        "usage",
      ]);
    });

    test("does not return the structured output or the text of the result", async () => {
      const fake = createFakeCommandRunner([
        {
          ...PROBE_OK,
          stdout: claudeJsonStdout({
            structured_output: { attempted: true },
            result: LEAK,
          }),
        },
      ]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(JSON.stringify(result)).not.toContain(LEAK);
    });

    test("returns both sessions after a retry, the discarded one first", async () => {
      const fake = createFakeCommandRunner([
        {
          ...PROBE_OK,
          stdout: claudeJsonStdout({
            structured_output: { wrong: LEAK },
            session_id: FIRST_SESSION,
          }),
        },
        {
          ...PROBE_OK,
          stdout: claudeJsonStdout({
            structured_output: { attempted: true },
            session_id: LAST_SESSION,
          }),
        },
      ]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(result.sessionIds).toEqual([FIRST_SESSION, LAST_SESSION]);
    });

    test("reports a retry", async () => {
      const fake = createFakeCommandRunner([
        {
          ...PROBE_OK,
          stdout: claudeJsonStdout({ structured_output: { wrong: LEAK } }),
        },
        PROBE_OK,
      ]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(result.retried).toBe(true);
    });

    test("names a failure by its code", async () => {
      const fake = createFakeCommandRunner([fail(LEAK)]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(result.reason).toBe("non_zero_exit");
    });

    test("keeps the standard error of a failure out of the result", async () => {
      const fake = createFakeCommandRunner([fail(LEAK)]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(JSON.stringify(result)).not.toContain(LEAK);
    });

    test("returns a null session id for a run that produced none", async () => {
      const fake = createFakeCommandRunner([fail("boom")]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(result.sessionIds).toEqual([null]);
    });

    test("returns null top-level keys for a failure", async () => {
      const fake = createFakeCommandRunner([fail("boom")]);
      const result = await runIsolationProbeClaudeWithDeps(
        probeOptions(fake.run),
        deps(),
      );
      expect(result.topLevelKeys).toBeNull();
    });
  });
});

// 証拠の要らない入口と、その差し替え口は、隔離の測定だけが使う。
// 調査の入口がこれを呼ぶと、証拠なしに調査のClaudeが起動する。
describe("the entries of the isolation probe", () => {
  const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const DEFINING_FILE = "lib/investigate_claude.ts";
  const PROBE_FILE = "investigate_isolation_probe.ts";

  function nameRegex(name: string): RegExp {
    return new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g");
  }

  function countInFile(path: string, name: string): number {
    const code = transpiler.transformSync(
      readFileSync(join(FACTORY_DIR, path), "utf8"),
    );
    return [...code.matchAll(nameRegex(name))].length;
  }

  function productionSources(): string[] {
    return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
      .filter((path) => !path.endsWith(".test.ts"))
      .sort();
  }

  test("runIsolationProbeClaude is named by no file other than the defining file and the probe", () => {
    const found = productionSources().filter(
      (path) =>
        path !== DEFINING_FILE &&
        path !== PROBE_FILE &&
        countInFile(path, "runIsolationProbeClaude") > 0,
    );
    expect(found).toEqual([]);
  });

  test("runIsolationProbeClaudeWithDeps is named by no file other than the defining file", () => {
    const found = productionSources().filter(
      (path) =>
        path !== DEFINING_FILE &&
        countInFile(path, "runIsolationProbeClaudeWithDeps") > 0,
    );
    expect(found).toEqual([]);
  });

  test("runIsolationProbeClaudeWithDeps is named in the defining file by its definition and by the public function only", () => {
    expect(countInFile(DEFINING_FILE, "runIsolationProbeClaudeWithDeps")).toBe(
      2,
    );
  });

  test("the probe names runIsolationProbeClaude", () => {
    expect(countInFile(PROBE_FILE, "runIsolationProbeClaude")).toBeGreaterThan(
      0,
    );
  });
});
