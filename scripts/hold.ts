#!/usr/bin/env bun
// 保留の、ホストの端末用のCLI。

import type {
  HoldActor,
  HoldScope,
  HoldSqlClient,
  Outcome,
} from "../f/factory/lib/holds.ts";
import type { HoldPsqlRun } from "./hold_psql.ts";

export type Command =
  | {
      readonly kind: "place";
      readonly scope: string;
      readonly target: string;
      readonly minutes: number;
      readonly reason: string;
    }
  | { readonly kind: "list" }
  | { readonly kind: "release"; readonly id: number };

export const HOLD_DATABASE = "";

export const WIRED_SCOPES: readonly HoldScope[] = [];

export function parseArgs(_argv: readonly string[]): Outcome<Command> {
  return { ok: false, reason: "not implemented" };
}

export function deriveActor(
  _env: Readonly<Record<string, string | undefined>>,
  _branch: string,
): HoldActor {
  return { kind: "human", holder: "human" };
}

export type CliDeps = {
  readonly read: HoldSqlClient;
  readonly write: HoldSqlClient;
  readonly branch: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly print: (line: string) => void;
  readonly activeFreezeCount: () => Promise<number>;
};

export function holdClients(_run?: HoldPsqlRun): {
  readonly read: HoldSqlClient;
  readonly write: HoldSqlClient;
} {
  const none: HoldSqlClient = () => ({
    fetch: async () => [],
    execute: async () => {},
  });
  return { read: none, write: none };
}

export async function runCommand(
  _command: Command,
  _deps: CliDeps,
): Promise<number> {
  return 0;
}
