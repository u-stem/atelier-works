/** 外部コマンドの指定と、発行の登録簿。 */

import type { CommandKind } from "./constants.ts";

export type Overflow = "kill" | "drain";

export type CommandSpecInput = {
  readonly kind: CommandKind;
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes?: number;
};

const BRAND: unique symbol = Symbol("issued_spec");

export type IssuedFields = {
  readonly kind: CommandKind;
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly overflow: Overflow;
};

export class IssuedSpec {
  readonly [BRAND] = true;
  readonly kind: CommandKind;
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly overflow: Overflow;

  constructor(fields: IssuedFields) {
    this.kind = fields.kind;
    this.bin = fields.bin;
    this.args = fields.args;
    this.env = fields.env;
    this.cwd = fields.cwd;
    this.timeoutMs = fields.timeoutMs;
    this.maxStdoutBytes = fields.maxStdoutBytes;
    this.overflow = fields.overflow;
  }
}

export type CommandErrorReason =
  | "timeout"
  | "aborted"
  | "signal"
  | "spawn"
  | "invalid_spec";

export class CommandError extends Error {
  readonly reason: CommandErrorReason;

  constructor(reason: CommandErrorReason) {
    super("external command failed");
    this.name = "CommandError";
    this.reason = reason;
  }
}

export const CREATABLE_KINDS: readonly CommandKind[] = [];
export const UNCREATABLE_KINDS: readonly CommandKind[] = [];
export const COMMAND_OUTPUT_LIMITS: Readonly<
  Partial<Record<CommandKind, { ceilingBytes: number; overflow: Overflow }>>
> = {};
export const HOST_PROBE_ENV: Readonly<Record<string, string>> = {};

function build(input: CommandSpecInput): IssuedSpec {
  return new IssuedSpec({
    ...input,
    maxStdoutBytes: input.maxStdoutBytes ?? 0,
    overflow: "kill",
  });
}

export function issueSpec(input: CommandSpecInput): IssuedSpec {
  return build(input);
}

export function issueSpecUnchecked(input: CommandSpecInput): IssuedSpec {
  return build(input);
}

export function isIssued(
  _value: unknown,
  _acceptUnchecked = false,
): _value is IssuedSpec {
  return false;
}
