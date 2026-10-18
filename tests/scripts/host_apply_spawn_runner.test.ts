import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandSpecInput,
  IssuedSpec,
  issueSpec,
  issueSpecUnchecked,
} from "../../scripts/host_apply/command.ts";
import { COMMAND_TIMEOUT_MS } from "../../scripts/host_apply/constants.ts";
import { GIT_BIN } from "../../scripts/host_apply/exec_paths.ts";
import {
  approveGitEnv,
  fetchArgs,
  fetchEnv,
  showBlobArgs,
} from "../../scripts/host_apply/git.ts";
import {
  createKillGroup,
  createRunner,
  defaultKillGroup,
  type RunnerDeps,
  type SpawnedProcess,
  type SpawnOptions,
} from "../../scripts/host_apply/spawn_runner.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PID = 4242;
const ENCODER = new TextEncoder();

function gitRead(overrides: Partial<CommandSpecInput> = {}) {
  return issueSpec({
    kind: "git_read",
    bin: GIT_BIN,
    args: showBlobArgs(SHA, "a"),
    env: approveGitEnv(),
    cwd: "/srv/repo",
    timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    ...overrides,
  });
}

function gitFetch(overrides: Partial<CommandSpecInput> = {}) {
  return issueSpec({
    kind: "git_fetch",
    bin: GIT_BIN,
    args: fetchArgs("https://github.com/example/repo.git"),
    env: { ...approveGitEnv(), ...fetchEnv(null), GIT_DIR: "/srv/repo.git" },
    cwd: "/srv/repo.git",
    timeoutMs: COMMAND_TIMEOUT_MS.git_fetch,
    ...overrides,
  });
}

/** 手で流し込める出力のストリーム。読み取りの取り消しも記録する。 */
function makeStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    stream,
    state,
    push(text: string | Uint8Array) {
      controller?.enqueue(
        typeof text === "string" ? ENCODER.encode(text) : text,
      );
    },
    close() {
      controller?.close();
    },
    /** 読み取りを失敗させる。 */
    fail() {
      controller?.error(new Error("stream failed"));
    },
  };
}

/** 偽のプロセス。出力、終了、シグナルでの終了を、テストから動かす。 */
function makeProcess(pid = PID) {
  const out = makeStream();
  const err = makeStream();
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const signal: { code: string | null } = { code: null };
  const proc: SpawnedProcess = {
    pid,
    stdout: out.stream,
    stderr: err.stream,
    exited,
    get signalCode() {
      return signal.code;
    },
  };
  return {
    proc,
    out,
    err,
    /** 出力を閉じて、終了コードで終わらせる。 */
    finish(code: number) {
      out.close();
      err.close();
      resolveExit(code);
    },
    /** シグナルで終わらせる。 */
    kill(code: string) {
      signal.code = code;
      out.close();
      err.close();
      resolveExit(-1);
    },
    exitOnly(code: number) {
      resolveExit(code);
    },
  };
}

type Timer = { fn: () => void; ms: number; cancelled: boolean };

function makeHarness(overrides: Partial<RunnerDeps> = {}) {
  const fake = makeProcess();
  const spawned: { cmd: string[]; opts: SpawnOptions }[] = [];
  const killed: number[] = [];
  const timers: Timer[] = [];
  const deps: RunnerDeps = {
    spawn(cmd, opts) {
      spawned.push({ cmd, opts });
      return fake.proc;
    },
    killGroup(pid) {
      killed.push(pid);
    },
    setTimer(fn, ms) {
      const timer: Timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    acceptUnchecked: false,
    ...overrides,
  };
  return { fake, spawned, killed, timers, run: createRunner(deps) };
}

describe("a command that ends normally", () => {
  test("returns what the command wrote and its exit code", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.out.push("hello");
    h.fake.err.push("warn");
    h.fake.finish(0);
    expect(await result).toEqual({
      kind: "done",
      code: 0,
      stdout: "hello",
      stderr: "warn",
      stdoutDropped: false,
      stderrDropped: false,
    });
  });

  test("returns a non-zero exit code as a result", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.finish(128);
    expect(await result).toMatchObject({ kind: "done", code: 128 });
  });

  test("joins output that arrives in several chunks", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.out.push("ab");
    h.fake.out.push("cd");
    h.fake.finish(0);
    expect(await result).toMatchObject({ stdout: "abcd" });
  });

  test("keeps a multi-byte character that is split between chunks", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    const bytes = ENCODER.encode("あ");
    h.fake.out.push(bytes.subarray(0, 1));
    h.fake.out.push(bytes.subarray(1));
    h.fake.finish(0);
    expect(await result).toMatchObject({ stdout: "あ" });
  });

  test("cancels the timer once the command ends", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.finish(0);
    await result;
    expect(h.timers.map((timer) => timer.cancelled)).toEqual([true]);
  });
});

describe("how a command is started", () => {
  async function started(spec = gitRead()) {
    const h = makeHarness();
    const result = h.run(spec);
    h.fake.finish(0);
    await result;
    const [call] = h.spawned;
    if (call === undefined) throw new Error("not spawned");
    return call;
  }

  test("passes the executable first and then the arguments", async () => {
    expect((await started()).cmd).toEqual([GIT_BIN, ...showBlobArgs(SHA, "a")]);
  });

  test("passes the working directory of the specification", async () => {
    expect((await started()).opts.cwd).toBe("/srv/repo");
  });

  test("passes the environment of the specification and nothing else", async () => {
    expect((await started()).opts.env).toEqual(approveGitEnv());
  });

  test("closes the standard input", async () => {
    expect((await started()).opts.stdin).toBe("ignore");
  });

  test("pipes the standard output", async () => {
    expect((await started()).opts.stdout).toBe("pipe");
  });

  test("pipes the standard error", async () => {
    expect((await started()).opts.stderr).toBe("pipe");
  });

  test("runs the command in its own process group", async () => {
    expect((await started()).opts.detached).toBe(true);
  });

  test("kills with SIGKILL", async () => {
    expect((await started()).opts.killSignal).toBe("SIGKILL");
  });

  test("sets the timer to the timeout of the specification", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.finish(0);
    await result;
    expect(h.timers.map((timer) => timer.ms)).toEqual([
      COMMAND_TIMEOUT_MS.git_read,
    ]);
  });
});

describe("a specification that was not issued", () => {
  test("is refused as invalid_spec", async () => {
    const h = makeHarness();
    const outside = new IssuedSpec({
      kind: "git_read",
      bin: GIT_BIN,
      args: showBlobArgs(SHA, "a"),
      env: approveGitEnv(),
      cwd: "/srv/repo",
      timeoutMs: COMMAND_TIMEOUT_MS.git_read,
      maxStdoutBytes: 1024,
      overflow: "kill",
    });
    await expect(h.run(outside)).rejects.toMatchObject({
      reason: "invalid_spec",
    });
  });

  test("is not started", async () => {
    const h = makeHarness();
    const outside = new IssuedSpec({
      kind: "git_read",
      bin: GIT_BIN,
      args: [],
      env: {},
      cwd: "/",
      timeoutMs: 1,
      maxStdoutBytes: 1,
      overflow: "kill",
    });
    await h.run(outside).catch(() => {});
    expect(h.spawned).toEqual([]);
  });

  const unchecked = () =>
    issueSpecUnchecked({
      kind: "git_read",
      bin: "/bin/sh",
      args: ["-c", "true"],
      env: { PATH: "/usr/bin:/bin" },
      cwd: "/tmp",
      timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    });

  test("is refused when it skipped the tables, by default", async () => {
    const h = makeHarness();
    await expect(h.run(unchecked())).rejects.toMatchObject({
      reason: "invalid_spec",
    });
  });

  test("is started when the runner accepts unchecked specifications", async () => {
    const h = makeHarness({ acceptUnchecked: true });
    const result = h.run(unchecked());
    h.fake.finish(0);
    expect(await result).toMatchObject({ kind: "done" });
  });
});

describe("a command that runs past its time", () => {
  test("is reported as a timeout", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.timers[0]?.fn();
    await expect(result).rejects.toMatchObject({ reason: "timeout" });
  });

  test("is killed as a group", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.timers[0]?.fn();
    await result.catch(() => {});
    expect(h.killed).toEqual([PID]);
  });

  test("stops reading its output", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.timers[0]?.fn();
    await result.catch(() => {});
    expect(h.fake.out.state.cancelled).toBe(true);
  });

  test("is still reported as a timeout when the group cannot be killed", async () => {
    const h = makeHarness({
      killGroup() {
        throw new Error("EPERM");
      },
    });
    const result = h.run(gitRead());
    h.timers[0]?.fn();
    await expect(result).rejects.toMatchObject({ reason: "timeout" });
  });

  test("is killed even after the command itself has exited", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.exitOnly(0);
    await Promise.resolve();
    h.timers[0]?.fn();
    await result.catch(() => {});
    expect(h.killed).toEqual([PID]);
  });

  test("is reported as a timeout when a child holds the pipe open", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.exitOnly(0);
    h.timers[0]?.fn();
    await expect(result).rejects.toMatchObject({ reason: "timeout" });
  });

  test("does not leave the message with the output", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.out.push("secret-token");
    h.timers[0]?.fn();
    await expect(result).rejects.toThrow("external command failed: timeout");
  });
});

describe("a command that is aborted", () => {
  test("is reported as aborted", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const result = h.run(gitRead(), { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ reason: "aborted" });
  });

  test("is killed as a group", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const result = h.run(gitRead(), { signal: controller.signal });
    controller.abort();
    await result.catch(() => {});
    expect(h.killed).toEqual([PID]);
  });

  test("cancels the timer", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const result = h.run(gitRead(), { signal: controller.signal });
    controller.abort();
    await result.catch(() => {});
    expect(h.timers.map((timer) => timer.cancelled)).toEqual([true]);
  });

  test("stops reading its output", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const result = h.run(gitRead(), { signal: controller.signal });
    controller.abort();
    await result.catch(() => {});
    expect(h.fake.out.state.cancelled).toBe(true);
  });

  test("is not started when the signal is already aborted", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    await h.run(gitRead(), { signal: controller.signal }).catch(() => {});
    expect(h.spawned).toEqual([]);
  });

  test("is reported as aborted when the signal is already aborted", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.run(gitRead(), { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
  });
});

describe("a command that is ended by a signal", () => {
  test("is reported as signal", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.kill("SIGSEGV");
    await expect(result).rejects.toMatchObject({ reason: "signal" });
  });
});

describe("a read of the output that fails", () => {
  test("is reported as read when it is the standard output", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.out.push("partial");
    h.fake.out.fail();
    await expect(result).rejects.toMatchObject({ reason: "read" });
  });

  test("kills the process group, since the output is lost", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.out.fail();
    await result.catch(() => {});
    expect(h.killed).toEqual([PID]);
  });

  test("is reported as read even after the command has exited", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.exitOnly(0);
    h.fake.err.close();
    h.fake.out.fail();
    await expect(result).rejects.toMatchObject({ reason: "read" });
  });

  test("cancels the timer", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.out.fail();
    await result.catch(() => {});
    expect(h.timers.map((timer) => timer.cancelled)).toEqual([true]);
  });

  test("is only information when it is the standard error", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.out.push("body");
    h.fake.out.close();
    h.fake.err.fail();
    h.fake.exitOnly(0);
    expect(await result).toMatchObject({ kind: "done", stdout: "body" });
  });
});

describe("a command that cannot be started", () => {
  test("is reported as spawn", async () => {
    const h = makeHarness({
      spawn() {
        throw new Error("ENOENT");
      },
    });
    await expect(h.run(gitRead())).rejects.toMatchObject({ reason: "spawn" });
  });

  test("does not leave a timer behind", async () => {
    const h = makeHarness({
      spawn() {
        throw new Error("ENOENT");
      },
    });
    await h.run(gitRead()).catch(() => {});
    expect(h.timers).toEqual([]);
  });
});

describe("output over the limit with overflow kill", () => {
  test("is reported as truncated", async () => {
    const h = makeHarness();
    const result = h.run(gitRead({ maxStdoutBytes: 4 }));
    h.fake.out.push("12345");
    expect(await result).toMatchObject({ kind: "truncated" });
  });

  test("carries no exit code and no standard output", async () => {
    const h = makeHarness();
    const result = h.run(gitRead({ maxStdoutBytes: 4 }));
    h.fake.out.push("12345");
    expect(Object.keys(await result).sort()).toEqual([
      "kind",
      "stderr",
      "stderrDropped",
    ]);
  });

  test("kills the process group", async () => {
    const h = makeHarness();
    const result = h.run(gitRead({ maxStdoutBytes: 4 }));
    h.fake.out.push("12345");
    await result;
    expect(h.killed).toEqual([PID]);
  });

  test("keeps the standard error read so far", async () => {
    const h = makeHarness();
    const result = h.run(gitRead({ maxStdoutBytes: 4 }));
    h.fake.err.push("warn");
    await Promise.resolve();
    h.fake.out.push("12345");
    expect(await result).toMatchObject({ stderr: "warn" });
  });

  test("cancels the timer", async () => {
    const h = makeHarness();
    const result = h.run(gitRead({ maxStdoutBytes: 4 }));
    h.fake.out.push("12345");
    await result;
    expect(h.timers.map((timer) => timer.cancelled)).toEqual([true]);
  });

  test("counts the bytes of a multi-byte string, not its length", async () => {
    const h = makeHarness();
    const result = h.run(gitRead({ maxStdoutBytes: 4 }));
    h.fake.out.push("ああ");
    expect(await result).toMatchObject({ kind: "truncated" });
  });

  test("passes output of exactly the limit", async () => {
    const h = makeHarness();
    const result = h.run(gitRead({ maxStdoutBytes: 4 }));
    h.fake.out.push("1234");
    h.fake.finish(0);
    expect(await result).toMatchObject({ kind: "done", stdout: "1234" });
  });
});

describe("output over the limit with overflow drain", () => {
  test("keeps the first bytes up to the limit", async () => {
    const h = makeHarness();
    const result = h.run(gitFetch({ maxStdoutBytes: 4 }));
    h.fake.out.push("123456");
    h.fake.finish(0);
    expect(await result).toMatchObject({ stdout: "1234" });
  });

  test("reports that output was dropped", async () => {
    const h = makeHarness();
    const result = h.run(gitFetch({ maxStdoutBytes: 4 }));
    h.fake.out.push("123456");
    h.fake.finish(0);
    expect(await result).toMatchObject({ stdoutDropped: true });
  });

  test("keeps the exit code", async () => {
    const h = makeHarness();
    const result = h.run(gitFetch({ maxStdoutBytes: 4 }));
    h.fake.out.push("123456");
    h.fake.finish(7);
    expect(await result).toMatchObject({ kind: "done", code: 7 });
  });

  test("does not kill the process", async () => {
    const h = makeHarness();
    const result = h.run(gitFetch({ maxStdoutBytes: 4 }));
    h.fake.out.push("123456");
    h.fake.finish(0);
    await result;
    expect(h.killed).toEqual([]);
  });

  test("reports nothing dropped for output within the limit", async () => {
    const h = makeHarness();
    const result = h.run(gitFetch({ maxStdoutBytes: 4 }));
    h.fake.out.push("1234");
    h.fake.finish(0);
    expect(await result).toMatchObject({ stdoutDropped: false });
  });
});

describe("the standard error", () => {
  const LIMIT = 64 * 1024;

  test("keeps the tail when it is over 64 KiB", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.err.push("a".repeat(LIMIT));
    h.fake.err.push("tail");
    h.fake.finish(0);
    const done = await result;
    expect(done.kind === "done" ? done.stderr.endsWith("tail") : false).toBe(
      true,
    );
  });

  test("keeps exactly 64 KiB of it", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.err.push("a".repeat(LIMIT));
    h.fake.err.push("tail");
    h.fake.finish(0);
    const done = await result;
    expect(done.kind === "done" ? done.stderr.length : -1).toBe(LIMIT);
  });

  test("reports that it was cut", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.err.push("a".repeat(LIMIT + 1));
    h.fake.finish(0);
    expect(await result).toMatchObject({ stderrDropped: true });
  });

  test("does not report a cut for 64 KiB exactly", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.err.push("a".repeat(LIMIT));
    h.fake.finish(0);
    expect(await result).toMatchObject({ stderrDropped: false });
  });

  test("does not stop the command, even when it is long", async () => {
    const h = makeHarness();
    const result = h.run(gitRead());
    h.fake.err.push("a".repeat(LIMIT * 3));
    h.fake.finish(0);
    await result;
    expect(h.killed).toEqual([]);
  });
});

describe("createKillGroup", () => {
  function errnoError(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  function recordingKill(failure: Error | null = null) {
    const calls: [number, string][] = [];
    const kill = (pid: number, signal: string): void => {
      calls.push([pid, signal]);
      if (failure !== null) throw failure;
    };
    return { calls, kill };
  }

  test("sends SIGKILL to the negative process group id", () => {
    const k = recordingKill();
    createKillGroup(k.kill)(4242);
    expect(k.calls).toEqual([[-4242, "SIGKILL"]]);
  });

  test("ignores a group that does not exist", () => {
    const k = recordingKill(errnoError("ESRCH"));
    expect(() => createKillGroup(k.kill)(4242)).not.toThrow();
  });

  test("rethrows any other error", () => {
    const k = recordingKill(errnoError("EPERM"));
    expect(() => createKillGroup(k.kill)(4242)).toThrow("EPERM");
  });

  test("rethrows an error that has no code", () => {
    const k = recordingKill(new Error("boom"));
    expect(() => createKillGroup(k.kill)(4242)).toThrow("boom");
  });

  test.each([0, 1, -5, 1.5, Number.NaN, process.pid])(
    "refuses the process id %p before sending anything",
    (pid) => {
      const k = recordingKill();
      expect(() => createKillGroup(k.kill)(pid)).toThrow("pgid");
    },
  );

  test("sends nothing for a refused process id", () => {
    const k = recordingKill();
    try {
      createKillGroup(k.kill)(1);
    } catch {
      // 拒否の例外は、上のテストが確かめる。
    }
    expect(k.calls).toEqual([]);
  });
});

describe("real processes", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "host-apply-runner-"));
    dirs.push(dir);
    return dir;
  }

  const run = createRunner({ acceptUnchecked: true });

  /** 終了して回収を待つゾンビは、生きているとは数えない。 */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    return state !== "" && !state.startsWith("Z");
  }

  async function goneWithin(pid: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await Bun.sleep(25);
    }
    return !alive(pid);
  }

  /** シェルが孫のpidを書き終えるまで、短い間隔で待つ。書かれた値が不正なら、前提が崩れているので例外にする。 */
  async function waitForPid(file: string): Promise<number> {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (/^[0-9]+\n$/.test(text)) {
        const pid = Number(text.trim());
        if (!(pid >= 1)) throw new Error("the pid file holds an invalid pid");
        return pid;
      }
      await Bun.sleep(10);
    }
    throw new Error("the pid file was not written");
  }

  function sleeper(dir: string, pidFile: string) {
    return issueSpecUnchecked({
      kind: "git_read",
      bin: "/bin/sh",
      args: ["-c", `sleep 30 & echo $! > '${pidFile}'; wait`],
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    });
  }

  test("an abort stops a grandchild that the shell started", async () => {
    const dir = scratch();
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    const result = run(sleeper(dir, pidFile), { signal: controller.signal });
    const pid = await waitForPid(pidFile);
    controller.abort();
    await result.catch(() => {});
    expect(await goneWithin(pid, 3000)).toBe(true);
  });

  test("the grandchild is alive before the abort", async () => {
    const dir = scratch();
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    const result = run(sleeper(dir, pidFile), { signal: controller.signal });
    const pid = await waitForPid(pidFile);
    const before = alive(pid);
    controller.abort();
    await result.catch(() => {});
    expect(before).toBe(true);
  });

  test("an abort is reported as aborted", async () => {
    const dir = scratch();
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    const result = run(sleeper(dir, pidFile), { signal: controller.signal });
    await waitForPid(pidFile);
    controller.abort();
    await expect(result).rejects.toMatchObject({ reason: "aborted" });
  });

  test.each([0, 1, process.pid])(
    "the default killGroup refuses the process id %d",
    (pid) => {
      expect(() => defaultKillGroup(pid)).toThrow("pgid");
    },
  );

  test("the child sees only the environment of the specification", async () => {
    const spec = issueSpecUnchecked({
      kind: "git_read",
      bin: "/usr/bin/printenv",
      args: [],
      env: { FOO_X: "1" },
      cwd: tmpdir(),
      timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    });
    const result = await run(spec);
    expect(result).toMatchObject({ kind: "done", stdout: "FOO_X=1\n" });
  });
});
