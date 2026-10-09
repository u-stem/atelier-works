import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 起動スクリプトの契約は終了コードそのものなので、実際のshで実行して確かめる。
const HOOKS = join(import.meta.dir, "../../../scripts/claude-hooks");
const RUN = join(HOOKS, "run.sh");
const PATH_WITH_BUN = `${dirname(process.execPath)}:/usr/bin:/bin`;
const NODE = Bun.which("node");

function launch(args: readonly string[], stdin: string, path: string) {
  return Bun.spawnSync(["/bin/sh", RUN, ...args], {
    stdin: Buffer.from(stdin),
    env: { PATH: path },
  });
}

const DENIED_COMMAND = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git commit --no-verify -m x" },
  cwd: "/repo",
});

/** 使い捨てのディレクトリを作り、`run`に渡して終わったら消す。 */
function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "claude-hooks-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** nodeだけをPATHに置いた状態で`run`を実行する。nodeが無ければnullを返す。 */
function withNodeOnly<T>(run: (path: string) => T): T | null {
  if (NODE === null) return null;
  return withTempDir((directory) => {
    symlinkSync(NODE, join(directory, "node"));
    return run(directory);
  });
}

/** nodeが型を取り除いて`.ts`を実行できる版(24以上)なら真。 */
function nodeRunsTypeScript(): boolean {
  if (NODE === null) return false;
  const version = Bun.spawnSync([NODE, "--version"]).stdout.toString();
  return Number(/^v(\d+)/.exec(version)?.[1] ?? 0) >= 24;
}

describe("run.sh", () => {
  test("allows the tool call when neither bun nor node is on PATH", () => {
    const result = withTempDir((directory) =>
      launch(["bash-guard"], DENIED_COMMAND, directory),
    );
    expect(result.exitCode).toBe(0);
  });

  test("prints nothing to stdout when no runtime is found", () => {
    const result = withTempDir((directory) =>
      launch(["bash-guard"], DENIED_COMMAND, directory),
    );
    expect(result.stdout.toString()).toBe("");
  });

  test("warns that the guard did not run when no runtime is found", () => {
    const result = withTempDir((directory) =>
      launch(["bash-guard"], DENIED_COMMAND, directory),
    );
    expect(result.stderr.toString()).toContain("not checked");
  });

  test("does not fall back to mise", () => {
    const ranMise = withTempDir((directory) => {
      const marker = join(directory, "mise-ran");
      writeFileSync(
        join(directory, "mise"),
        `#!/bin/sh\ntouch "${marker}"\nexit 1\n`,
      );
      chmodSync(join(directory, "mise"), 0o755);
      launch(["bash-guard"], DENIED_COMMAND, directory);
      return existsSync(marker);
    });
    expect(ranMise).toBe(false);
  });

  test("exits with 2 for an invalid hook name", () => {
    expect(launch(["../x"], DENIED_COMMAND, PATH_WITH_BUN).exitCode).toBe(2);
  });

  test("exits with 2 for an unknown hook", () => {
    expect(
      launch(["no-such-hook"], DENIED_COMMAND, PATH_WITH_BUN).exitCode,
    ).toBe(2);
  });

  test("exits with 2 when the hook fails", () => {
    expect(launch(["bash-guard"], "not json", PATH_WITH_BUN).exitCode).toBe(2);
  });

  test("passes the deny decision of a real hook through", () => {
    const result = launch(["bash-guard"], DENIED_COMMAND, PATH_WITH_BUN);
    expect(result.stdout.toString()).toContain('"permissionDecision":"deny"');
  });
});

describe("run.sh with node only", () => {
  test.skipIf(!nodeRunsTypeScript())(
    "runs the guard with node when bun is not on PATH",
    () => {
      const result = withNodeOnly((path) =>
        launch(["bash-guard"], DENIED_COMMAND, path),
      );
      expect(result?.stdout.toString()).toContain(
        '"permissionDecision":"deny"',
      );
    },
  );

  test.skipIf(!nodeRunsTypeScript())(
    "exits with 2 under node when the input is not JSON",
    () => {
      const result = withNodeOnly((path) =>
        launch(["bash-guard"], "not json", path),
      );
      expect(result?.exitCode).toBe(2);
    },
  );
});

describe("the hook entry point under node", () => {
  test.skipIf(!nodeRunsTypeScript())(
    "denies a command when run directly by node",
    () => {
      const result = Bun.spawnSync(
        [NODE ?? "node", join(HOOKS, "bash-guard.ts")],
        { stdin: Buffer.from(DENIED_COMMAND), env: { PATH: "/usr/bin:/bin" } },
      );
      expect(result.stdout.toString()).toContain('"permissionDecision":"deny"');
    },
  );

  test.skipIf(!nodeRunsTypeScript())(
    "allows an ordinary command when run directly by node",
    () => {
      const input = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        cwd: "/repo",
      });
      const result = Bun.spawnSync(
        [NODE ?? "node", join(HOOKS, "bash-guard.ts")],
        { stdin: Buffer.from(input), env: { PATH: "/usr/bin:/bin" } },
      );
      expect(result.stdout.toString()).toBe("");
    },
  );

  test.skipIf(!nodeRunsTypeScript() || Bun.which("git") === null)(
    "reads the current branch through git under node",
    () => {
      const reason = withTempDir((directory) => {
        Bun.spawnSync(["git", "init", "-q", "-b", "main", directory]);
        const input = JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git push" },
          cwd: directory,
        });
        const result = Bun.spawnSync(
          [NODE ?? "node", join(HOOKS, "bash-guard.ts")],
          {
            stdin: Buffer.from(input),
            env: { PATH: `${dirname(Bun.which("git") ?? "")}:/usr/bin:/bin` },
          },
        );
        return result.stdout.toString();
      });
      expect(reason).toContain("Pushing to main");
    },
  );
});
