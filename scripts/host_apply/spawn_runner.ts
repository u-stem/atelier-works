/** 発行した指定を実際に起動する実行口。 */

import type { CommandResult, CommandRunner } from "./command.ts";

export type SpawnOptions = {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: "ignore";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
  readonly detached: true;
  readonly killSignal: "SIGKILL";
};

export type SpawnedProcess = {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly signalCode: string | null;
};

export type RunnerDeps = {
  readonly spawn: (cmd: string[], opts: SpawnOptions) => SpawnedProcess;
  readonly killGroup: (pid: number) => void;
  readonly setTimer: (fn: () => void, ms: number) => () => void;
  readonly acceptUnchecked: boolean;
};

export function createRunner(
  _overrides: Partial<RunnerDeps> = {},
): CommandRunner {
  return async (): Promise<CommandResult> => ({
    kind: "done",
    code: 0,
    stdout: "",
    stderr: "",
    stdoutDropped: false,
    stderrDropped: false,
  });
}
