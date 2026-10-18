/**
 * 外部コマンドの指定(`CommandSpec`)を検査して発行する。実行はしない。
 * 実行口(`spawn_runner`)は、ここで発行した指定しか起動しない。
 * 検査は`issueSpec`が唯一の検査点で、種類ごとの`bin`の表と、引数・環境の文法を通ったものだけを発行する。
 * 発行した指定は深く凍結し、発行の登録簿に載せる。呼び出し側は、検査の後で引数や環境を書き換えられない。
 */

import {
  COMMAND_KINDS,
  COMMAND_TIMEOUT_MS,
  type CommandKind,
} from "./constants.ts";
import { GIT_BIN, PS_BIN, SYSCTL_BIN } from "./exec_paths.ts";
import {
  checkFetchForm,
  checkGitReadArgs,
  checkGitReadEnv,
  sameEnv,
} from "./git_grammar.ts";

/** 標準出力が上限を超えたときの動作。`kill`はプロセスを止め、`drain`は超えた分を捨てて読み続ける。 */
export type Overflow = "kill" | "drain";

/** 発行の前の指定。`maxStdoutBytes`を省くと、種類の天井になる。 */
export type CommandSpecInput = {
  readonly kind: CommandKind;
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes?: number;
};

/** 発行した指定の型を、構造的な型にしないための印。外からは書けない。 */
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

/**
 * 検査して発行した指定。引数と環境の写しを凍結して持つ。
 * 作るだけでは登録簿に載らず、実行口は登録簿に無い指定を起動しない。載せるのは`issueSpec`だけ。
 */
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
    this.args = Object.freeze([...fields.args]);
    this.env = Object.freeze({ ...fields.env });
    this.cwd = fields.cwd;
    this.timeoutMs = fields.timeoutMs;
    this.maxStdoutBytes = fields.maxStdoutBytes;
    this.overflow = fields.overflow;
    Object.freeze(this);
  }
}

export type CommandErrorReason =
  | "timeout"
  | "aborted"
  | "signal"
  | "spawn"
  | "invalid_spec";

/** 実行口が投げる失敗。文言は固定で、コマンドの出力や引数を含めない。 */
export class CommandError extends Error {
  readonly reason: CommandErrorReason;

  constructor(reason: CommandErrorReason) {
    super(`external command failed: ${reason}`);
    this.name = "CommandError";
    this.reason = reason;
  }
}

/**
 * 実行口の結果。終了コードが0以外でも`done`で返し、分類は呼び出し側が行う。
 * `truncated`は標準出力が上限を超えてプロセスを止めたときで、終了コードも標準出力も持たない。
 * `*Dropped`が真なら、捨てた分がある。解析する側は、`stdoutDropped`が真なら失敗にする。
 * 標準エラーは末尾だけを残すので、`stderrDropped`は情報として扱う。
 */
export type CommandResult =
  | {
      readonly kind: "done";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly stdoutDropped: boolean;
      readonly stderrDropped: boolean;
    }
  | {
      readonly kind: "truncated";
      readonly stderr: string;
      readonly stderrDropped: boolean;
    };

export type CommandRunner = (
  spec: IssuedSpec,
  opts?: { readonly signal?: AbortSignal },
) => Promise<CommandResult>;

type OutputLimit = {
  readonly ceilingBytes: number;
  readonly overflow: Overflow;
};

/** `host_probe`の環境。表記をロケールとタイムゾーンに依らせないため、固定する。 */
export const HOST_PROBE_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  TZ: "UTC",
});

const PROBE_PID = /^[1-9][0-9]{0,6}$/;
const MAX_PID = 2 ** 22;

type Fields = Omit<IssuedFields, "maxStdoutBytes" | "overflow">;

function checkHostProbe(spec: Fields): string | null {
  if (!sameEnv(spec.env, HOST_PROBE_ENV)) {
    return "host_probe environment differs from the fixed one";
  }
  if (spec.cwd !== "/") return "host_probe runs in the root directory";
  const [first, second, third, pid] = spec.args;
  if (spec.bin === PS_BIN) {
    const valid =
      spec.args.length === 4 &&
      first === "-o" &&
      second === "lstart=" &&
      third === "-p" &&
      pid !== undefined &&
      PROBE_PID.test(pid) &&
      Number(pid) <= MAX_PID;
    return valid ? null : "host_probe takes -o lstart= -p <pid>";
  }
  const valid =
    spec.args.length === 2 &&
    first === "-n" &&
    second === "kern.bootsessionuuid";
  return valid ? null : "host_probe takes -n kern.bootsessionuuid";
}

type KindRule = OutputLimit & {
  readonly bins: readonly string[];
  readonly check: (spec: Fields) => string | null;
};

/** 作れる種類の表。ここに無い種類は発行できない。後続の変更が、使う側と一緒に足す。 */
const KIND_RULES: Readonly<Partial<Record<CommandKind, KindRule>>> = {
  git_read: {
    bins: [GIT_BIN],
    ceilingBytes: 64 * 1024 * 1024,
    overflow: "kill",
    check: (spec) => checkGitReadArgs(spec.args) ?? checkGitReadEnv(spec.env),
  },
  git_fetch: {
    bins: [GIT_BIN],
    ceilingBytes: 64 * 1024,
    overflow: "drain",
    check: (spec) =>
      checkFetchForm({ args: spec.args, env: spec.env, cwd: spec.cwd }),
  },
  host_probe: {
    bins: [PS_BIN, SYSCTL_BIN],
    ceilingBytes: 4 * 1024,
    overflow: "kill",
    check: checkHostProbe,
  },
};

export const CREATABLE_KINDS: readonly CommandKind[] = COMMAND_KINDS.filter(
  (kind) => KIND_RULES[kind] !== undefined,
);

export const UNCREATABLE_KINDS: readonly CommandKind[] = COMMAND_KINDS.filter(
  (kind) => KIND_RULES[kind] === undefined,
);

/** 種類ごとの標準出力の天井と、溢れたときの動作。 */
export const COMMAND_OUTPUT_LIMITS: Readonly<
  Partial<Record<CommandKind, OutputLimit>>
> = Object.freeze(
  Object.fromEntries(
    CREATABLE_KINDS.flatMap((kind) => {
      const rule = KIND_RULES[kind];
      return rule === undefined
        ? []
        : [
            [
              kind,
              { ceilingBytes: rule.ceilingBytes, overflow: rule.overflow },
            ],
          ];
    }),
  ),
);

/** 発行の登録簿。モジュールの外からは触れない。 */
const ISSUED = new WeakSet<object>();
const ISSUED_UNCHECKED = new WeakSet<object>();

function invalid(reason: string, kind?: CommandKind): never {
  const scope = kind === undefined ? "" : ` (${kind})`;
  throw new Error(`invalid command spec${scope}: ${reason}`);
}

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

/** 絶対パスで、`..`の要素と`\0`を持たないか。`my..repo`のような名前の一部は許す。 */
function isCleanAbsolute(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
  );
}

/** 入力を一度だけ読んで写しを取り、形を検査する。以降は写しだけを使う。 */
function snapshot(input: CommandSpecInput): Fields & {
  readonly maxStdoutBytes: number | undefined;
} {
  const { kind, bin, cwd, timeoutMs, maxStdoutBytes } = input;
  const rawArgs: unknown = input.args;
  const rawEnv: unknown = input.env;
  if (!isCleanAbsolute(bin)) invalid("bin must be a clean absolute path");
  if (!isCleanAbsolute(cwd)) invalid("cwd must be a clean absolute path");
  if (!Array.isArray(rawArgs)) invalid("args must be an array");
  const args: string[] = [];
  for (const arg of rawArgs) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      invalid("an argument must be a string without NUL");
    }
    args.push(arg);
  }
  if (typeof rawEnv !== "object" || rawEnv === null) {
    invalid("env must be an object");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (
      !ENV_KEY.test(key) ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      invalid("an environment entry is not allowed");
    }
    env[key] = value;
  }
  return { kind, bin, args, env, cwd, timeoutMs, maxStdoutBytes };
}

function build(input: CommandSpecInput, checked: boolean): IssuedSpec {
  const spec = snapshot(input);
  const rule = KIND_RULES[spec.kind];
  if (rule === undefined) invalid("kind cannot be created");
  if (spec.timeoutMs !== COMMAND_TIMEOUT_MS[spec.kind]) {
    invalid("timeout differs from the table", spec.kind);
  }
  const requested = spec.maxStdoutBytes ?? rule.ceilingBytes;
  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > rule.ceilingBytes
  ) {
    invalid("output limit is not allowed", spec.kind);
  }
  if (checked) {
    if (!rule.bins.includes(spec.bin)) {
      invalid("bin is not allowed", spec.kind);
    }
    const reason = rule.check(spec);
    if (reason !== null) invalid(reason, spec.kind);
  }
  return new IssuedSpec({
    kind: spec.kind,
    bin: spec.bin,
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    maxStdoutBytes: requested,
    overflow: rule.overflow,
  });
}

/** 指定を検査し、凍結して発行する。種類ごとの`bin`の表と文法に合わなければ例外にする。 */
export function issueSpec(input: CommandSpecInput): IssuedSpec {
  const spec = build(input, true);
  ISSUED.add(spec);
  return spec;
}

/**
 * 種類ごとの`bin`の表と文法を飛ばして発行する。形の検査と凍結は`issueSpec`と同じ。
 * テストが、使い捨てのコマンドで実行口を確かめるための入口。
 * 別の登録簿に載せ、実行口は`acceptUnchecked`を明示されない限り起動しない。
 */
export function issueSpecUnchecked(input: CommandSpecInput): IssuedSpec {
  const spec = build(input, false);
  ISSUED_UNCHECKED.add(spec);
  return spec;
}

/** 発行の登録簿に載っているか。検査を飛ばした指定は、`acceptUnchecked`が真のときだけ受ける。 */
export function isIssued(
  value: unknown,
  acceptUnchecked = false,
): value is IssuedSpec {
  if (typeof value !== "object" || value === null) return false;
  return ISSUED.has(value) || (acceptUnchecked && ISSUED_UNCHECKED.has(value));
}
