import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/check-commit-msg.sh");
const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-commit-msg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// テストを動かす環境のCLAUDECODEに左右されないよう、envは明示的に組み立てる。
function run(message: string, claudecode: boolean) {
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (claudecode) {
    env.CLAUDECODE = "1";
  }
  const result = Bun.spawnSync(["bash", SCRIPT, file], { env });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe("check-commit-msg.sh without CLAUDECODE", () => {
  test("accepts a message without a trailer", () => {
    const { exitCode } = run("feat: 機能を追加\n", false);
    expect(exitCode).toBe(0);
  });

  test("rejects a first line that breaks the convention", () => {
    const { exitCode } = run("機能を追加\n", false);
    expect(exitCode).toBe(1);
  });
});

describe("check-commit-msg.sh with CLAUDECODE=1", () => {
  test("accepts the plain trailer", () => {
    const { exitCode } = run(`feat: 機能を追加\n\n本文\n\n${TRAILER}\n`, true);
    expect(exitCode).toBe(0);
  });

  test("accepts a trailer with a model name", () => {
    const { exitCode } = run(
      "feat: 機能を追加\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n",
      true,
    );
    expect(exitCode).toBe(0);
  });

  test("accepts a lowercase trailer key", () => {
    const { exitCode } = run(
      "feat: 機能を追加\n\nco-authored-by: Claude <noreply@anthropic.com>\n",
      true,
    );
    expect(exitCode).toBe(0);
  });

  test("accepts a trailer followed by other trailers", () => {
    const { exitCode } = run(
      `feat: 機能を追加\n\n${TRAILER}\nClaude-Session: https://example.com/s\n`,
      true,
    );
    expect(exitCode).toBe(0);
  });

  test("accepts a trailer in a CRLF message", () => {
    const { exitCode } = run(`feat: 機能を追加\r\n\r\n${TRAILER}\r\n`, true);
    expect(exitCode).toBe(0);
  });

  test("rejects a message without a trailer", () => {
    const { exitCode } = run("feat: 機能を追加\n\n本文\n", true);
    expect(exitCode).toBe(1);
  });

  test("explains the missing trailer in Japanese", () => {
    const { stderr } = run("feat: 機能を追加\n", true);
    expect(stderr).toContain("Co-Authored-By: Claude");
  });

  test("rejects a trailer that only appears in a comment line", () => {
    const { exitCode } = run(`feat: 機能を追加\n\n# ${TRAILER}\n`, true);
    expect(exitCode).toBe(1);
  });

  test("rejects a trailer that does not start the line", () => {
    const { exitCode } = run(`feat: 機能を追加\n\n本文 ${TRAILER}\n`, true);
    expect(exitCode).toBe(1);
  });

  test("rejects a trailer for another author", () => {
    const { exitCode } = run(
      "feat: 機能を追加\n\nCo-Authored-By: Someone <someone@example.com>\n",
      true,
    );
    expect(exitCode).toBe(1);
  });

  test("rejects a trailer with another address", () => {
    const { exitCode } = run(
      "feat: 機能を追加\n\nCo-Authored-By: Claude <claude@example.com>\n",
      true,
    );
    expect(exitCode).toBe(1);
  });

  test("accepts a trailer followed by git's comment lines", () => {
    const { exitCode } = run(
      `feat: 機能を追加\n\n${TRAILER}\n\n# Please enter the commit message\n# Lines starting with '#' are ignored\n`,
      true,
    );
    expect(exitCode).toBe(0);
  });

  test("accepts a trailer after trailing blank lines", () => {
    const { exitCode } = run(`feat: 機能を追加\n\n${TRAILER}\n\n\n`, true);
    expect(exitCode).toBe(0);
  });

  test("rejects a trailer that is not in the last paragraph", () => {
    const { exitCode } = run(
      `feat: 機能を追加\n\n${TRAILER}\n\n後から足した本文\n`,
      true,
    );
    expect(exitCode).toBe(1);
  });

  test("rejects a trailer that directly follows the subject", () => {
    const { exitCode } = run(`feat: 機能を追加\n${TRAILER}\n`, true);
    expect(exitCode).toBe(1);
  });

  test("rejects a trailer separated from the body by a comment-only paragraph", () => {
    const { exitCode } = run(
      `feat: 機能を追加\n\n${TRAILER}\n\n# メモ\n\n本文\n`,
      true,
    );
    expect(exitCode).toBe(1);
  });

  test("accepts a trailer in a paragraph whose lines are all trailers", () => {
    const { exitCode } = run(
      `feat: 機能を追加\n\n本文\n\nSigned-off-by: A <a@example.com>\n${TRAILER}\n`,
      true,
    );
    expect(exitCode).toBe(0);
  });

  test("skips the trailer check for a merge commit", () => {
    const { exitCode } = run("Merge branch 'main' into feature\n", true);
    expect(exitCode).toBe(0);
  });

  test("skips the trailer check for a revert commit", () => {
    const { exitCode } = run('Revert "feat: 機能を追加"\n', true);
    expect(exitCode).toBe(0);
  });

  test("skips the trailer check for a fixup commit", () => {
    const { exitCode } = run("fixup! feat: 機能を追加\n", true);
    expect(exitCode).toBe(0);
  });

  test("skips the trailer check for a squash commit", () => {
    const { exitCode } = run("squash! feat: 機能を追加\n", true);
    expect(exitCode).toBe(0);
  });

  test("rejects a first line that breaks the convention even with a trailer", () => {
    const { exitCode } = run(`機能を追加\n\n${TRAILER}\n`, true);
    expect(exitCode).toBe(1);
  });
});
