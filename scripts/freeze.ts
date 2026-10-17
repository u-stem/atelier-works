#!/usr/bin/env bun
// スケジュールの凍結の、人の端末用のCLI。

import type {
  FreezeInputs,
  FreezePorts,
} from "../f/factory/lib/freeze_apply.ts";
import type { FreezeActor, Outcome } from "../f/factory/lib/freezes.ts";

export type Command =
  | {
      readonly kind: "place";
      readonly target: string;
      readonly minutes: number;
      readonly reason: string;
    }
  | { readonly kind: "list" }
  | { readonly kind: "release"; readonly id: string }
  | { readonly kind: "check" }
  | { readonly kind: "reset" }
  | {
      readonly kind: "push";
      readonly prune: boolean;
      readonly dryRun: boolean;
    };

export function parseArgs(_argv: readonly string[]): Outcome<Command> {
  return { ok: false, reason: "not implemented" };
}

export function deriveActor(
  _env: Readonly<Record<string, string | undefined>>,
  _branch: string,
): FreezeActor {
  return { kind: "session", holder: "" };
}

export function buildPushArgv(
  _excludesArg: string,
  _flags: { readonly prune: boolean; readonly dryRun: boolean },
): string[] {
  return [];
}

export type CaptureResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export function wmillCliPorts(
  _capture: (argv: readonly string[]) => Promise<CaptureResult>,
  now: () => Date,
): FreezePorts {
  return {
    readVariable: async () => "stub",
    writeVariable: async () => {},
    now,
  };
}

export type CliDeps = {
  readonly ports: FreezePorts;
  readonly loadInputs: () => Promise<Outcome<FreezeInputs>>;
  readonly runPush: (argv: readonly string[]) => Promise<number>;
  readonly branch: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly print: (line: string) => void;
  readonly newId: () => string;
};

export async function runCommand(
  _command: Command,
  _deps: CliDeps,
): Promise<number> {
  return 99;
}
