// Shared small-test fakes for the lib-exec modules (github.ts, workspace.ts,
// claude.ts). Not part of the deployed Windmill assets — test-only.

import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../../f/factory/lib/workspace.ts";

export type FakeCall = {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
};

export type FakeCommandRunner = {
  readonly run: CommandRunner;
  readonly calls: FakeCall[];
};

/**
 * A `CommandRunner` fake that returns `responses` in order, one per call,
 * and records every call's argv/options for assertions.
 */
export function createFakeCommandRunner(
  responses: readonly CommandResult[],
): FakeCommandRunner {
  const calls: FakeCall[] = [];
  let index = 0;
  const run: CommandRunner = async (argv, options) => {
    calls.push({ argv, options });
    const result = responses[index];
    index += 1;
    if (result === undefined) {
      throw new Error(
        `createFakeCommandRunner: no canned response for call #${index} (${argv.join(" ")})`,
      );
    }
    return result;
  };
  return { run, calls };
}

export function ok(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0, timedOut: false };
}

export function fail(stderr: string, exitCode = 1): CommandResult {
  return { stdout: "", stderr, exitCode, timedOut: false };
}

export function timeout(stderr = ""): CommandResult {
  return { stdout: "", stderr, exitCode: 137, timedOut: true };
}

/**
 * Build a `gh api -i` stdout string (status line + CRLF-terminated headers
 * + blank line + body), matching the real shape captured during the M4
 * contract smoke, for use as a canned `CommandResult.stdout`.
 */
export function ghApiStdout(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): string {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  const headerLines = Object.entries(headers).map(
    ([key, value]) => `${key}: ${value}`,
  );
  return [`HTTP/2.0 ${status} Status`, ...headerLines, "", bodyText].join(
    "\r\n",
  );
}

export function ghApiOk(
  body: unknown,
  headers: Record<string, string> = {},
): CommandResult {
  return ok(ghApiStdout(200, body, headers));
}
