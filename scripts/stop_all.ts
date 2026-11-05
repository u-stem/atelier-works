export const STOP_SCRIPT = "";
export const RELEASE_SCRIPT = "";

export type StopCommand =
  | { readonly kind: "place"; readonly reason: string }
  | { readonly kind: "kill_only" }
  | { readonly kind: "release" };

export type StopParse =
  | { readonly ok: true; readonly value: StopCommand }
  | { readonly ok: false; readonly reason: string };

export type ExecResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type JobList =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export type StopDeps = {
  readonly confirm: (message: string) => Promise<boolean>;
  readonly runScript: (
    path: string,
    args: Readonly<Record<string, string>>,
  ) => Promise<ExecResult>;
  readonly listRunningJobs: () => Promise<JobList>;
  readonly cancelJob: (id: string) => Promise<ExecResult>;
  readonly workerExec: (argv: readonly string[]) => Promise<ExecResult>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly print: (line: string) => void;
  readonly checkUids: readonly number[];
};

export function parseStopArgs(_argv: readonly string[]): StopParse {
  return { ok: false, reason: "" };
}

export function signalGroupArgv(
  _signal: "TERM" | "KILL",
  _pid: number,
): string[] {
  return [];
}

export async function runStop(
  _command: StopCommand,
  _deps: StopDeps,
): Promise<number> {
  return 2;
}
