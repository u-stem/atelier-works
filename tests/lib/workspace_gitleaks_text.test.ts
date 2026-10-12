import { describe, expect, test } from "bun:test";
import {
  type CommandResult,
  type GitleaksConfigDir,
  omittedMarker,
  runGitleaksOnText,
} from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, fail, ok, timeout } from "./testSupport.ts";

const LEAK = JSON.stringify([
  {
    RuleID: "github-pat",
    File: "",
    StartLine: 1,
    Match: "REDACTED",
    Secret: "REDACTED",
  },
]);

const exit = (stdout: string, exitCode: number): CommandResult => ({
  stdout,
  stderr: "",
  exitCode,
  timedOut: false,
});

function configDir(): {
  factory: () => Promise<GitleaksConfigDir>;
  state: { cleaned: number };
} {
  const state = { cleaned: 0 };
  return {
    state,
    factory: async () => ({
      path: "/tmp/fake-gitleaks",
      cleanup: async () => {
        state.cleaned += 1;
      },
    }),
  };
}

const scan = (
  fake: ReturnType<typeof createFakeCommandRunner>,
  text = "some log text",
  dir = configDir(),
) =>
  runGitleaksOnText(
    {
      run: fake.run,
      timeoutMs: 1000,
      createConfigDir: dir.factory,
    },
    text,
  );

describe("runGitleaksOnText", () => {
  test("reports ok on exit 0", async () => {
    const fake = createFakeCommandRunner([ok("[]")]);
    expect((await scan(fake)).ok).toBe(true);
  });

  test("feeds the text itself on stdin", async () => {
    const fake = createFakeCommandRunner([ok("[]")]);
    await scan(fake, "build failed at line 3");
    expect(fake.calls[0]?.options?.stdin).toBe("build failed at line 3");
  });

  test("scans with the forced default config and no repository ignore file", async () => {
    const fake = createFakeCommandRunner([ok("[]")]);
    await scan(fake);
    expect(fake.calls[0]?.argv).toEqual([
      "gitleaks",
      "stdin",
      "--redact",
      "--no-banner",
      "--no-color",
      "--log-level",
      "error",
      "--exit-code",
      "1",
      "--report-format",
      "json",
      "--report-path",
      "-",
      "--config",
      "/tmp/fake-gitleaks/gitleaks.toml",
      "--gitleaks-ignore-path",
      "/tmp/fake-gitleaks",
      "--ignore-gitleaks-allow",
    ]);
  });

  test("runs in the private temp dir", async () => {
    const fake = createFakeCommandRunner([ok("[]")]);
    await scan(fake);
    expect(fake.calls[0]?.options?.cwd).toBe("/tmp/fake-gitleaks");
  });

  test("reports not ok on exit 1 with a report", async () => {
    const fake = createFakeCommandRunner([exit(LEAK, 1)]);
    expect((await scan(fake)).ok).toBe(false);
  });

  test("lists the rule per finding and never the matched text", async () => {
    const fake = createFakeCommandRunner([exit(LEAK, 1)]);
    expect((await scan(fake)).output).toBe("- github-pat");
  });

  test("throws on a timeout", async () => {
    const fake = createFakeCommandRunner([timeout()]);
    await expect(scan(fake)).rejects.toThrow("timed out");
  });

  test("throws on an unexpected exit code", async () => {
    const fake = createFakeCommandRunner([fail("unknown flag", 126)]);
    await expect(scan(fake)).rejects.toThrow("gitleaks failed");
  });

  test("throws on exit 1 without a JSON report", async () => {
    const fake = createFakeCommandRunner([exit("Error: boom", 1)]);
    await expect(scan(fake)).rejects.toThrow("gitleaks failed");
  });

  test("throws when the output reading was abandoned", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: "[]",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        outputAbandoned: true,
      },
    ]);
    await expect(scan(fake)).rejects.toThrow("abandoned");
  });

  test("throws when the report was cut at the output cap", async () => {
    const fake = createFakeCommandRunner([exit(`[${omittedMarker(10)}]`, 1)]);
    await expect(scan(fake)).rejects.toThrow("output cap");
  });

  test("removes the config dir even when the scan throws", async () => {
    const dir = configDir();
    await scan(createFakeCommandRunner([timeout()]), "x", dir).catch(
      () => undefined,
    );
    expect(dir.state.cleaned).toBe(1);
  });

  test("masks a secret that appears in the failure message", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const fake = createFakeCommandRunner([fail(`bad ${secret}`, 126)]);
    const error = await scan(fake).catch((caught: unknown) => caught);
    expect(String(error instanceof Error ? error.message : "")).not.toContain(
      secret,
    );
  });
});
