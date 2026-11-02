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
  runInvestigateClaude,
  runInvestigateClaudeWithDeps,
} from "../../f/factory/lib/investigate_claude.ts";
import {
  computeIsolationFingerprint,
  ISOLATION_ARGS,
  ISOLATION_FINGERPRINT,
} from "../../f/factory/lib/investigate_isolation.ts";
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
      return { ...options(run), proof: Reflect.get({ proof }, "proof") };
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
      "131397caa8b7a15699bc0d9e67b034a69dc04d235b18bb0e7d4b392dcab98d85",
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
