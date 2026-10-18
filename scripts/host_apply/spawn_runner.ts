/**
 * 発行した指定を実際に起動する実行口。外部コマンドを起動する唯一のモジュール。
 * 起動するのは`issueSpec`が発行して登録簿に載せた指定だけで、登録簿に無いものは起動せずに拒否する。
 * 時間切れ、中断、標準出力の溢れでは、孫まで止めるためにプロセスグループごと止める。
 */

import {
  CommandError,
  type CommandResult,
  type CommandRunner,
  type IssuedSpec,
  isIssued,
} from "./command.ts";
import { STDERR_LIMIT_BYTES } from "./constants.ts";

export type SpawnOptions = {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: "ignore";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
  /** 新しいセッションとプロセスグループで起動する。 */
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

/** 実行口が外の世界に触れる4つの口。テストは偽物を渡す。 */
export type RunnerDeps = {
  readonly spawn: (cmd: string[], opts: SpawnOptions) => SpawnedProcess;
  /** プロセスグループを止める。グループが無ければ何もしない。 */
  readonly killGroup: (pid: number) => void;
  /** 時間切れの呼び出しを予約し、取り消す関数を返す。 */
  readonly setTimer: (fn: () => void, ms: number) => () => void;
  /** 検査を飛ばして発行した指定も起動するか。テストだけが真にする。 */
  readonly acceptUnchecked: boolean;
};

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

const realDeps: RunnerDeps = {
  spawn: (cmd, opts) => Bun.spawn(cmd, opts),
  killGroup: (pid) => {
    // pidが0や1や自分自身だと、無関係なグループに信号が届く。
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
      throw new Error("pgid is not valid");
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!isNoSuchProcess(error)) throw error;
    }
  },
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  acceptUnchecked: false,
};

type ReadMode =
  | { readonly kind: "kill"; readonly limit: number }
  | { readonly kind: "drain"; readonly limit: number }
  | { readonly kind: "tail"; readonly limit: number };

export function createKillGroup(
  _kill: (pid: number, signal: "SIGKILL") => void,
): (pid: number) => void {
  return () => {};
}

export const defaultRunnerDeps: RunnerDeps = realDeps;

/** 出力のストリームを読み切る、または取り消すための持ち手。 */
type StreamReader = {
  /** EOF、取り消し、溢れ、読み取りの失敗のどれかで解決する。拒否はしない。 */
  readonly done: Promise<void>;
  /** `kill`で上限を超えたときだけ解決する。 */
  readonly overflowed: Promise<void>;
  /** 読み取りが失敗したときだけ解決する。 */
  readonly failed: Promise<void>;
  readonly cancel: () => void;
  readonly text: () => string;
  readonly dropped: () => boolean;
  readonly didOverflow: () => boolean;
  readonly didFail: () => boolean;
};

function readStream(
  stream: ReadableStream<Uint8Array>,
  mode: ReadMode,
): StreamReader {
  const reader = stream.getReader();
  let chunks: Uint8Array[] = [];
  let kept = 0;
  let dropped = false;
  let overflow = false;
  let total = 0;
  let signalOverflow: () => void = () => {};
  const overflowed = new Promise<void>((resolve) => {
    signalOverflow = resolve;
  });
  let failure = false;
  let signalFailure: () => void = () => {};
  const failed = new Promise<void>((resolve) => {
    signalFailure = resolve;
  });
  const cancel = (): void => {
    reader.cancel().catch(() => {});
  };

  const take = (value: Uint8Array): boolean => {
    if (mode.kind === "kill") {
      total += value.length;
      if (total > mode.limit) {
        overflow = true;
        return false;
      }
      chunks.push(value);
      return true;
    }
    if (mode.kind === "drain") {
      const room = mode.limit - kept;
      const used = Math.max(0, Math.min(value.length, room));
      if (used < value.length) dropped = true;
      if (used > 0) chunks.push(value.subarray(0, used));
      kept += used;
      return true;
    }
    chunks.push(value);
    kept += value.length;
    while (kept - (chunks[0]?.length ?? 0) >= mode.limit && chunks.length > 1) {
      kept -= chunks[0]?.length ?? 0;
      chunks = chunks.slice(1);
      dropped = true;
    }
    const first = chunks[0];
    if (first !== undefined && kept > mode.limit) {
      chunks[0] = first.subarray(kept - mode.limit);
      kept = mode.limit;
      dropped = true;
    }
    return true;
  };

  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        if (!take(next.value)) {
          signalOverflow();
          cancel();
          return;
        }
      }
    } catch {
      // 失敗は呼び出し側が分類する。標準出力の失敗は欠けた出力を意味し、標準エラーの失敗は情報にとどまる。
      failure = true;
      signalFailure();
    }
  })();

  return {
    done,
    overflowed,
    failed,
    cancel,
    text: () => Buffer.concat(chunks).toString("utf8"),
    dropped: () => dropped,
    didOverflow: () => overflow,
    didFail: () => failure,
  };
}

type Outcome = "finished" | "overflow" | "read_failed" | "timeout" | "aborted";

/**
 * 実行口を作る。
 * 起動の前に登録簿を確かめ、起動したら、終了と両方の出力の終端、標準出力の溢れ、時間切れ、中断のうち
 * 最初に起きたものに従う。時間切れと中断と溢れでは、タイマーを消し、読み取りを打ち切る。
 * 終了を見た後に時間切れになった場合も、孫がパイプを持ち続けているかもしれないのでグループを止める。
 */
export function createRunner(
  overrides: Partial<RunnerDeps> = {},
): CommandRunner {
  const deps: RunnerDeps = { ...realDeps, ...overrides };

  return async (spec: IssuedSpec, opts): Promise<CommandResult> => {
    if (!isIssued(spec, deps.acceptUnchecked)) {
      throw new CommandError("invalid_spec");
    }
    const { bin, args, env, cwd, timeoutMs, maxStdoutBytes, overflow } = spec;
    const signal = opts?.signal;
    if (signal?.aborted) throw new CommandError("aborted");

    let proc: SpawnedProcess;
    try {
      proc = deps.spawn([bin, ...args], {
        cwd,
        env: { ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        killSignal: "SIGKILL",
      });
    } catch {
      throw new CommandError("spawn");
    }

    const stdout = readStream(proc.stdout, {
      kind: overflow,
      limit: maxStdoutBytes,
    });
    const stderr = readStream(proc.stderr, {
      kind: "tail",
      limit: STDERR_LIMIT_BYTES,
    });
    const stopReading = (): void => {
      stdout.cancel();
      stderr.cancel();
    };
    const killGroup = (): void => {
      try {
        deps.killGroup(proc.pid);
      } catch {
        // 止められなくても、呼び出し側には時間切れなどの失敗を返す。
      }
    };

    let cancelTimer: () => void = () => {};
    let onAbort: () => void = () => {};
    const interrupted = new Promise<"timeout" | "aborted">((resolve) => {
      cancelTimer = deps.setTimer(() => resolve("timeout"), timeoutMs);
      onAbort = () => resolve("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const exit = proc.exited.then(
        (code) => ({ ok: true as const, code }),
        () => ({ ok: false as const }),
      );
      const finished = Promise.all([exit, stdout.done, stderr.done]).then(
        ([result]) => result,
      );
      const first = await Promise.race([
        finished.then((result) => ({ outcome: "finished" as const, result })),
        stdout.overflowed.then(() => ({ outcome: "overflow" as const })),
        stdout.failed.then(() => ({ outcome: "read_failed" as const })),
        interrupted.then((outcome) => ({ outcome })),
      ]);
      const outcome: Outcome = stdout.didOverflow()
        ? "overflow"
        : stdout.didFail()
          ? "read_failed"
          : first.outcome;

      if (outcome === "finished" && first.outcome === "finished") {
        if (!first.result.ok) throw new CommandError("spawn");
        if (proc.signalCode !== null) throw new CommandError("signal");
        return {
          kind: "done",
          code: first.result.code,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutDropped: stdout.dropped(),
          stderrDropped: stderr.dropped(),
        };
      }
      cancelTimer();
      killGroup();
      stopReading();
      if (outcome === "overflow") {
        return {
          kind: "truncated",
          stderr: stderr.text(),
          stderrDropped: stderr.dropped(),
        };
      }
      if (outcome === "read_failed") throw new CommandError("read");
      throw new CommandError(outcome === "aborted" ? "aborted" : "timeout");
    } finally {
      cancelTimer();
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
