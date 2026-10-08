import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

// 起動スクリプトの契約は終了コードそのものなので、実際のshで実行して確かめる。
const RUN = join(import.meta.dir, "../../../scripts/claude-hooks/run.sh");
const PATH_WITH_BUN = `${dirname(process.execPath)}:/usr/bin:/bin`;

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

describe("run.sh", () => {
  test("exits with 2 when bun and mise are not on PATH", () => {
    expect(
      launch(["bash-guard"], DENIED_COMMAND, "/nonexistent").exitCode,
    ).toBe(2);
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
