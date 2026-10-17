import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const ENTRY = join(REPO_ROOT, "scripts/host-apply.ts");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 環境を明示して`approve`を起動する。親の環境(Claudeの変数を含む)は引き継がない。
 * 標準入力は端末でないので、端末の門は閉じている。
 */
function approve(options: {
  extraEnv?: Record<string, string>;
  bunFlags?: string[];
  args?: string[];
}) {
  const home = mkdtempSync(join(tmpdir(), "host-apply-cli-"));
  dirs.push(home);
  const stateDir = join(home, "state");
  const result = Bun.spawnSync(
    [
      "bun",
      ...(options.bunFlags ?? ["--no-env-file"]),
      ENTRY,
      ...(options.args ?? [
        "approve",
        SHA,
        "--applied",
        OTHER,
        "--state-dir",
        stateDir,
      ]),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        ...options.extraEnv,
      },
    },
  );
  return {
    code: result.exitCode,
    err: result.stderr.toString(),
    out: result.stdout.toString(),
    recordExists: existsSync(join(stateDir, "approved.json")),
    stateDirExists: existsSync(stateDir),
  };
}

describe("approve at the command line", () => {
  describe("the agent gate", () => {
    test("exits 3 when CLAUDECODE is set", () => {
      expect(approve({ extraEnv: { CLAUDECODE: "1" } }).code).toBe(3);
    });

    test("names the agent as the reason", () => {
      expect(approve({ extraEnv: { CLAUDECODE: "1" } }).err).toContain("agent");
    });

    test("writes no record", () => {
      expect(approve({ extraEnv: { CLAUDECODE: "1" } }).recordExists).toBe(
        false,
      );
    });

    test("does not even create the state directory", () => {
      expect(approve({ extraEnv: { CLAUDECODE: "1" } }).stateDirExists).toBe(
        false,
      );
    });

    test("exits 3 when CLAUDE_CODE_ENTRYPOINT is set", () => {
      expect(
        approve({ extraEnv: { CLAUDE_CODE_ENTRYPOINT: "cli" } }).code,
      ).toBe(3);
    });
  });

  describe("the terminal gate", () => {
    test("exits 3 when stdin and stdout are not a terminal", () => {
      expect(approve({}).code).toBe(3);
    });

    test("names the terminal as the reason", () => {
      expect(approve({}).err).toContain("terminal");
    });

    test("does not name the agent when no Claude variable is set", () => {
      expect(approve({}).err).not.toContain("agent");
    });

    test("writes no record", () => {
      expect(approve({}).recordExists).toBe(false);
    });

    test("is not blocked by CLAUDE_CODE_OAUTH_TOKEN alone", () => {
      const result = approve({ extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } });
      expect(result.err).toContain("terminal");
    });

    test("prints nothing on the standard output", () => {
      expect(approve({}).out).toBe("");
    });
  });

  describe("the entry flag gate", () => {
    test("exits 3 without --no-env-file", () => {
      expect(approve({ bunFlags: [] }).code).toBe(3);
    });

    test("names the flag as the reason", () => {
      expect(approve({ bunFlags: [] }).err).toContain("--no-env-file");
    });

    test("writes no record", () => {
      expect(approve({ bunFlags: [] }).recordExists).toBe(false);
    });
  });

  describe("a bad command line", () => {
    test("exits 2 for a missing sha", () => {
      expect(approve({ args: ["approve"] }).code).toBe(2);
    });

    test("exits 2 for a six digit sha", () => {
      expect(
        approve({ args: ["approve", "abc123", "--applied", OTHER] }).code,
      ).toBe(2);
    });

    test("exits 2 for a missing --applied", () => {
      expect(approve({ args: ["approve", SHA] }).code).toBe(2);
    });

    test("exits 2 for a relative --state-dir", () => {
      expect(
        approve({
          args: ["approve", SHA, "--applied", OTHER, "--state-dir", "state"],
        }).code,
      ).toBe(2);
    });

    test("prints the usage of approve", () => {
      expect(approve({ args: ["approve"] }).err).toContain("approve <sha>");
    });
  });
});
