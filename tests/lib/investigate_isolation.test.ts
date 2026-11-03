// 調査のClaudeの隔離の定数と、隔離した実行の引数の組み立てを固定する。
// 保護パスに置く。隔離の引数を呼び出し側が変えられるようにする変更や、
// 起動の形の変化を測定の結果に反映させない変更が、このテストを書き換えて通らないようにするため。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReadDenyPaths,
  buildReadDenySettings,
  READ_DENY_BASE_PATHS,
} from "../../f/factory/lib/claude_read_deny.ts";
import {
  ARGV_SHAPE_HOME,
  buildIsolatedRunOptions,
  collectArgvShape,
  computeArgvShapeHash,
  computeIsolationFingerprint,
  hashArgvShape,
  ISOLATION_ARGS,
  ISOLATION_FINGERPRINT,
  type IsolatedRunOptions,
  type IsolatedRunVariable,
  PROBE_FAILURE_CODES,
  PROBE_JOB_TAG,
  PROBE_JUDGE_VERSION,
  PROBE_SCRIPT_PATH,
} from "../../f/factory/lib/investigate_isolation.ts";
import { createFakeCommandRunner } from "./testSupport.ts";

type OkPayload = { readonly ok: boolean };

function isOkPayload(value: unknown): value is OkPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "ok") === "boolean"
  );
}

function variable(): IsolatedRunVariable<OkPayload> {
  return {
    run: createFakeCommandRunner([]).run,
    oauthToken: "oauth-token-value",
    model: "claude-sonnet-5-5",
    prompt: "investigate this",
    appendSystemPromptFile: "/run/prompt.md",
    jsonSchema: { type: "object" },
    isStructuredOutput: isOkPayload,
    maxTurns: 10,
    maxBudgetUsd: 2,
    timeoutMs: 60_000,
    cwd: "/var/lib/factory-investigate/7/work",
    workItemId: 7,
    stage: "investigate",
    attempt: 1,
    home: "/home/person",
  };
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe("buildIsolatedRunOptions", () => {
  test("takes the tools from the constant", () => {
    expect(buildIsolatedRunOptions(variable()).tools).toEqual(
      ISOLATION_ARGS.tools,
    );
  });

  test("takes the permission mode from the constant", () => {
    expect(buildIsolatedRunOptions(variable()).permissionMode).toBe(
      ISOLATION_ARGS.permissionMode,
    );
  });

  test("takes the setting sources from the constant", () => {
    expect(buildIsolatedRunOptions(variable()).settingSources).toEqual(
      ISOLATION_ARGS.settingSources,
    );
  });

  test("takes the allowed tools from the constant", () => {
    expect(buildIsolatedRunOptions(variable()).allowedTools).toEqual(
      ISOLATION_ARGS.allowedTools,
    );
  });

  test("takes the added directories from the constant", () => {
    expect(buildIsolatedRunOptions(variable()).addDirs).toEqual(
      ISOLATION_ARGS.addDirs,
    );
  });

  test("follows the constant when it is changed at run time", () => {
    const original = ISOLATION_ARGS.addDirs;
    Reflect.set(ISOLATION_ARGS, "addDirs", ["/srv/extra"]);
    let built: IsolatedRunOptions<OkPayload>;
    try {
      built = buildIsolatedRunOptions(variable());
    } finally {
      Reflect.set(ISOLATION_ARGS, "addDirs", original);
    }
    expect(built.addDirs).toEqual(["/srv/extra"]);
  });

  test("blocks the fixed list and the given home", () => {
    expect(buildIsolatedRunOptions(variable()).readDenyPaths).toEqual(
      buildReadDenyPaths("/home/person"),
    );
  });

  test("passes the variable values on as they are", () => {
    const input = variable();
    expect(buildIsolatedRunOptions(input)).toMatchObject({
      run: input.run,
      oauthToken: "oauth-token-value",
      model: "claude-sonnet-5-5",
      prompt: "investigate this",
      appendSystemPromptFile: "/run/prompt.md",
      jsonSchema: { type: "object" },
      isStructuredOutput: input.isStructuredOutput,
      maxTurns: 10,
      maxBudgetUsd: 2,
      timeoutMs: 60_000,
      cwd: "/var/lib/factory-investigate/7/work",
      workItemId: 7,
      stage: "investigate",
      attempt: 1,
      home: "/home/person",
    });
  });

  test("returns exactly the keys that runClaude takes from it", () => {
    expect(Object.keys(buildIsolatedRunOptions(variable())).sort()).toEqual(
      [
        "addDirs",
        "allowedTools",
        "appendSystemPromptFile",
        "attempt",
        "cwd",
        "home",
        "isStructuredOutput",
        "jsonSchema",
        "maxBudgetUsd",
        "maxTurns",
        "model",
        "oauthToken",
        "permissionMode",
        "prompt",
        "readDenyPaths",
        "run",
        "settingSources",
        "stage",
        "timeoutMs",
        "tools",
        "workItemId",
      ].sort(),
    );
  });

  test("ignores extra properties that try to change the isolation", () => {
    const extra = {
      tools: ["Bash"],
      permissionMode: "acceptEdits",
      settingSources: ["project"],
      allowedTools: ["Bash", "Edit"],
      addDirs: ["/"],
      readDenyPaths: [],
      tmpDir: "/tmp",
      readDenyContext: {},
      claudeConfigDir: "/home/person/.claude",
      path: "/evil",
    };
    const built = buildIsolatedRunOptions({ ...variable(), ...extra });
    expect({
      tools: built.tools,
      permissionMode: built.permissionMode,
      settingSources: built.settingSources,
      allowedTools: built.allowedTools,
      addDirs: built.addDirs,
      readDenyPaths: built.readDenyPaths,
      tmpDir: Reflect.get(built, "tmpDir"),
      readDenyContext: Reflect.get(built, "readDenyContext"),
      claudeConfigDir: Reflect.get(built, "claudeConfigDir"),
      path: Reflect.get(built, "path"),
    }).toEqual({
      tools: ISOLATION_ARGS.tools,
      permissionMode: ISOLATION_ARGS.permissionMode,
      settingSources: ISOLATION_ARGS.settingSources,
      allowedTools: ISOLATION_ARGS.allowedTools,
      addDirs: ISOLATION_ARGS.addDirs,
      readDenyPaths: buildReadDenyPaths("/home/person"),
      tmpDir: undefined,
      readDenyContext: undefined,
      claudeConfigDir: undefined,
      path: undefined,
    });
  });

  test("does not read the home from process.env", () => {
    const saved = process.env.HOME;
    process.env.HOME = "/ambient/home";
    let built: IsolatedRunOptions<OkPayload>;
    try {
      built = buildIsolatedRunOptions(variable());
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = saved;
    }
    expect(built.home).toBe("/home/person");
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

  test("keeps the value it had before the constants moved", () => {
    expect(ISOLATION_FINGERPRINT).toBe(
      "131397caa8b7a15699bc0d9e67b034a69dc04d235b18bb0e7d4b392dcab98d85",
    );
  });
});

describe("the constants of the probe", () => {
  test("names the probe script", () => {
    expect(PROBE_SCRIPT_PATH).toBe("f/factory/investigate_isolation_probe");
  });

  test("expects the default worker tag", () => {
    expect(PROBE_JOB_TAG).toBe("bun");
  });

  // 判定の版を上げるときは、`tests/lib/investigate_isolation_judge.test.ts`のハッシュの表にも行を足す。
  test("sets the judge at version 2", () => {
    expect(PROBE_JUDGE_VERSION).toBe(2);
  });

  test("lists each failure code once", () => {
    expect(new Set(PROBE_FAILURE_CODES).size).toBe(PROBE_FAILURE_CODES.length);
  });
});

describe("collectArgvShape", () => {
  test("starts with the claude command", () => {
    expect(collectArgvShape().argv[0]).toBe("claude");
  });

  test("limits the tools to those of the constant", () => {
    expect(valueAfter(collectArgvShape().argv, "--tools")).toBe(
      ISOLATION_ARGS.tools.join(","),
    );
  });

  test("uses the permission mode of the constant", () => {
    expect(valueAfter(collectArgvShape().argv, "--permission-mode")).toBe(
      ISOLATION_ARGS.permissionMode,
    );
  });

  test("reads the setting sources of the constant", () => {
    expect(valueAfter(collectArgvShape().argv, "--setting-sources")).toBe(
      ISOLATION_ARGS.settingSources.join(","),
    );
  });

  test("restricts the file operations", () => {
    expect(collectArgvShape().argv).toContain("--restricted");
  });

  test("records the fixed environment values and only the keys of the variable ones", () => {
    expect(collectArgvShape().env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: null,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      CLAUDE_CONFIG_DIR: null,
      HOME: null,
      PATH: null,
      TMPDIR: null,
      CLAUDE_CODE_TMPDIR: null,
    });
  });

  test("records the settings written for a fixed home", () => {
    expect(collectArgvShape().settings).toBe(
      buildReadDenySettings(buildReadDenyPaths(ARGV_SHAPE_HOME)),
    );
  });
});

describe("computeArgvShapeHash", () => {
  function withAmbientEnv<T>(fn: () => T): T {
    const keys = [
      "WM_JOB_ID",
      "HOME",
      "PATH",
      "CLAUDE_CONFIG_DIR",
      "TMPDIR",
      "CLAUDE_VERSION",
    ];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    process.env.WM_JOB_ID = "11111111-2222-4333-8444-555555555555";
    process.env.HOME = "/ambient/home";
    process.env.PATH = "/ambient/bin";
    process.env.CLAUDE_CONFIG_DIR = "/ambient/config";
    process.env.TMPDIR = "/ambient/tmp";
    process.env.CLAUDE_VERSION = "0.0.0";
    try {
      return fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  }

  test("is a sha256 hex digest", () => {
    expect(computeArgvShapeHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is the hash of the collected shape", () => {
    expect(computeArgvShapeHash()).toBe(hashArgvShape(collectArgvShape()));
  });

  test("is the same on every call", () => {
    expect(computeArgvShapeHash()).toBe(computeArgvShapeHash());
  });

  test("does not depend on process.env", () => {
    const baseline = computeArgvShapeHash();
    expect(withAmbientEnv(() => computeArgvShapeHash())).toBe(baseline);
  });

  test("changes when a tool is added", () => {
    const baseline = computeArgvShapeHash();
    const original = ISOLATION_ARGS.tools;
    Reflect.set(ISOLATION_ARGS, "tools", [...original, "Bash"]);
    let changed: string;
    try {
      changed = computeArgvShapeHash();
    } finally {
      Reflect.set(ISOLATION_ARGS, "tools", original);
    }
    expect(changed).not.toBe(baseline);
  });

  test("changes when the permission mode changes", () => {
    const baseline = computeArgvShapeHash();
    const original = ISOLATION_ARGS.permissionMode;
    Reflect.set(ISOLATION_ARGS, "permissionMode", "acceptEdits");
    let changed: string;
    try {
      changed = computeArgvShapeHash();
    } finally {
      Reflect.set(ISOLATION_ARGS, "permissionMode", original);
    }
    expect(changed).not.toBe(baseline);
  });
});

describe("hashArgvShape", () => {
  const SHAPE = {
    argv: ["claude", "-p", "--restricted"],
    env: { FIXED: "1", VARIABLE: null },
    settings: '{"permissions":{"deny":[]}}\n',
  };

  test("changes when a flag is added to the argv", () => {
    expect(
      hashArgvShape({ ...SHAPE, argv: [...SHAPE.argv, "--extra"] }),
    ).not.toBe(hashArgvShape(SHAPE));
  });

  test("changes when the order of the argv changes", () => {
    expect(
      hashArgvShape({ ...SHAPE, argv: ["claude", "--restricted", "-p"] }),
    ).not.toBe(hashArgvShape(SHAPE));
  });

  test("changes when an environment key is added", () => {
    expect(
      hashArgvShape({ ...SHAPE, env: { ...SHAPE.env, ADDED: null } }),
    ).not.toBe(hashArgvShape(SHAPE));
  });

  test("changes when an environment key is removed", () => {
    expect(hashArgvShape({ ...SHAPE, env: { FIXED: "1" } })).not.toBe(
      hashArgvShape(SHAPE),
    );
  });

  test("changes when a fixed environment value changes", () => {
    expect(
      hashArgvShape({ ...SHAPE, env: { ...SHAPE.env, FIXED: "0" } }),
    ).not.toBe(hashArgvShape(SHAPE));
  });

  test("changes when the format of the deny rules changes", () => {
    expect(
      hashArgvShape({ ...SHAPE, settings: `${SHAPE.settings} ` }),
    ).not.toBe(hashArgvShape(SHAPE));
  });

  test("does not depend on the order of the environment keys", () => {
    expect(
      hashArgvShape({ ...SHAPE, env: { VARIABLE: null, FIXED: "1" } }),
    ).toBe(hashArgvShape(SHAPE));
  });

  test("tells a fixed value apart from a variable one", () => {
    expect(
      hashArgvShape({ ...SHAPE, env: { FIXED: null, VARIABLE: null } }),
    ).not.toBe(hashArgvShape(SHAPE));
  });
});

// 隔離した実行の引数を組む関数は、本番では調査の入口だけが使う。
// 別の入口が使うと、隔離の組み立てが複数になり、測定の対象と起動の形が食い違う。
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。
// 追えない形がある。識別子を連結や別名で組み立てる参照は数えられない。
describe("the builder of the isolated options", () => {
  const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const NAME = /(?<![\w$])buildIsolatedRunOptions(?![\w$])/g;

  function countIn(code: string): number {
    return [...code.matchAll(NAME)].length;
  }

  function countInFile(path: string): number {
    return countIn(
      transpiler.transformSync(readFileSync(join(FACTORY_DIR, path), "utf8")),
    );
  }

  function productionSources(): string[] {
    return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
      .filter((path) => !path.endsWith(".test.ts"))
      .sort();
  }

  test("is named by no production file other than the investigate entry and the defining file", () => {
    const found = productionSources().filter(
      (path) =>
        path !== "lib/investigate_claude.ts" &&
        path !== "lib/investigate_isolation.ts" &&
        countInFile(path) > 0,
    );
    expect(found).toEqual([]);
  });

  test("is used by the investigate entry", () => {
    expect(countInFile("lib/investigate_claude.ts")).toBe(2);
  });

  test("is named in the defining file by its definition and by the hash of the shape", () => {
    expect(countInFile("lib/investigate_isolation.ts")).toBe(2);
  });

  test("counts an import under another name", () => {
    const code = transpiler.transformSync(
      'import { buildIsolatedRunOptions as build } from "./investigate_isolation.ts"; build();',
    );
    expect(countIn(code)).toBe(1);
  });

  test("does not count a longer name", () => {
    const code = transpiler.transformSync(
      "const x = buildIsolatedRunOptionsX;",
    );
    expect(countIn(code)).toBe(0);
  });
});
