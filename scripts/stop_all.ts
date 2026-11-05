#!/usr/bin/env bun
// 全停止の、人の端末用のCLI。
//
// 使い方(`mise run`のタスクから呼ぶ):
//   stop_all.ts place --reason <text>   Consoleと同じWindmillのscriptで全停止を置き、30秒待ち、
//                                       実行中のジョブを中止し、workerに残ったClaudeと検査のプロセスを止める
//   stop_all.ts place --kill-only       Windmillが落ちているとき。workerに残ったプロセスを止めるだけ
//   stop_all.ts release                 Consoleと同じWindmillのscriptで全停止を解除する
//
// 30秒待つのは、実行中のClaudeと検査が、自分で変数を読んで止まるまでの間である(確認は15秒ごと、読み取りは5秒まで、SIGTERMの猶予は5秒)。
// その後にジョブを中止する。先に中止すると、ジョブのプロセスと一緒に、子プロセスを止める監視が消えるためである。
// scriptが断った結果(`refused`)と、読めない結果は、置けなかった・解除できなかったものとして非0で終える。
// 監視が消えた後に残ったプロセスは、`docker compose exec`でworkerの中から止める。
// Claudeは、属するプロセスグループごと止める。implementとpr_fixのClaudeは`flock`の下で動き、グループの先頭は`flock`である。
// 検査のプロセスは、枠のuidとして全部止める。
//
// どの操作も、端末(TTY)で`yes`を入力して確かめる。環境変数`CLAUDECODE`があるときは、確認の前に断る。
// subagentと背景のセッションは端末を持たないので、確認も通らない。
// 迂回のための環境変数は設けない。

import { resolve } from "node:path";
import {
  KILL_PATH,
  killAllArgv,
  parseCheckUid,
  parsePoolSize,
} from "../f/factory/lib/check_sandbox.ts";
import { selectOrphanClaudePids } from "../f/factory/lib/cleanup_support.ts";
import {
  isStopAllReason,
  STOP_ALL_REASON_MAX,
} from "../f/factory/lib/stop_all.ts";
import { isRecord } from "../f/factory/lib/types.ts";
import { parseRunningJobs, runningJobsSql } from "./check-idle.ts";

/** 全停止を置くWindmillのscript。Consoleの全停止の操作と同じものを呼ぶ。 */
export const STOP_SCRIPT = "f/factory/console_stop_all";
/** 全停止を解除するWindmillのscript。 */
export const RELEASE_SCRIPT = "f/factory/console_stop_all_release";
/**
 * 実行中のClaudeと検査が自分で止まるまで待つ時間(ミリ秒)。
 * 監視の間隔15秒、変数の読み取りの上限5秒、SIGTERMの後の猶予5秒の和に、余裕を足す。
 */
export const SETTLE_WAIT_MS = 30_000;
/** グループにSIGTERMを送ってから、残ったものにSIGKILLを送るまでの猶予(ミリ秒)。 */
export const KILL_GRACE_MS = 5_000;
/** workerのプロセスの一覧。グループの番号を先頭の列に置く(`claudeGroupIds`が読む形)。 */
export const PS_ARGV = ["ps", "-eo", "pgid,pid,args"] as const;

/**
 * `PS_ARGV`の出力から、Claudeが属するプロセスグループの番号を、重複を除いて返す。
 * `selectOrphanClaudePids`は、行の先頭の列を番号、2列目を経過時間として読み、Claudeの行の先頭の列を返す。
 * 先頭にpgidを、2列目にpidを並べ、経過時間の絞り込みを-1で外すと、Claudeの行のpgidが返る。
 * 全停止では、起動した直後のClaudeも止めるため、経過時間で絞らない。
 * 0と1は、自分のグループやinitを指すので除く。
 */
export function claudeGroupIds(psOutput: string): number[] {
  return [...new Set(selectOrphanClaudePids(psOutput, -1))].filter(
    (pgid) => Number.isInteger(pgid) && pgid > 1,
  );
}

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
  /** 呼び出し元の環境変数。Claudeのセッションからの実行を断るために読む。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly confirm: (message: string) => Promise<boolean>;
  /** `wmill script run`で、Windmillのscriptを実行する。 */
  readonly runScript: (
    path: string,
    args: Readonly<Record<string, string>>,
  ) => Promise<ExecResult>;
  /** defaultのworkerで実行中のジョブ。 */
  readonly listRunningJobs: () => Promise<JobList>;
  readonly cancelJob: (id: string) => Promise<ExecResult>;
  /** defaultのworkerのコンテナの中で、コマンドを実行する。 */
  readonly workerExec: (argv: readonly string[]) => Promise<ExecResult>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly print: (line: string) => void;
  /** 検査の枠のuid。 */
  readonly checkUids: readonly number[];
};

const USAGE =
  "usage: stop_all.ts place --reason <text> | place --kill-only | release";

export function parseStopArgs(argv: readonly string[]): StopParse {
  const [command, ...rest] = argv;
  if (command === "release") {
    return rest.length === 0
      ? { ok: true, value: { kind: "release" } }
      : { ok: false, reason: "release takes no arguments" };
  }
  if (command !== "place") return { ok: false, reason: USAGE };
  if (rest.length === 1 && rest[0] === "--kill-only") {
    return { ok: true, value: { kind: "kill_only" } };
  }
  if (rest.length === 2 && rest[0] === "--reason") {
    const reason = rest[1] ?? "";
    // Consoleのscriptも同じ検査で確かめ直す。
    return isStopAllReason(reason)
      ? { ok: true, value: { kind: "place", reason } }
      : {
          ok: false,
          reason: `the reason must be 1 to ${String(STOP_ALL_REASON_MAX)} characters without control characters`,
        };
  }
  return { ok: false, reason: USAGE };
}

/** `pid`のプロセスグループ全体にシグナルを送るargv。procps-ngの`kill`は、負の番号を`--`の後に置く。 */
export function signalGroupArgv(
  signal: "TERM" | "KILL",
  pid: number,
): string[] {
  // pid 0と1と負の値は、自分のグループやinitを指す。グループ全体への送信が広がるので拒否する。
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`refusing to signal the group of pid ${String(pid)}`);
  }
  return [KILL_PATH, "-s", signal, "--", `-${String(pid)}`];
}

const SESSION_REFUSAL =
  "mise run stop and mise run stop:release are human-only operations; run them in your own terminal, not from a Claude session";
const NOT_PLACED_WARNING =
  "WARNING: the stop-all was NOT placed. The schedules and the *_enabled settings are still active; fix Windmill and run mise run stop again.";

const PLACE_MESSAGE =
  "This stops the whole Factory: it places the stop-all, turns off every *_enabled setting, disables the repository schedules, cancels the running jobs after 30 seconds, and kills the claude and check processes left in the worker.";
const KILL_MESSAGE =
  "This kills the claude processes and the check processes left in the worker container, without touching Windmill.";
const RELEASE_MESSAGE =
  "This releases the stop-all and enables the repository schedules again. The *_enabled settings stay off; turn them on one by one.";

/**
 * `wmill script run -s`の標準出力から読んだ、scriptの結果。
 * scriptは断るときも正常に終わるので、終了コードだけでは置けたかどうかが分からない。
 */
export type ScriptOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreadable" };

/** scriptの結果のJSONを読む。`refused`が真偽値でない結果は、読めないものとして扱う。 */
export function readScriptOutcome(stdout: string): ScriptOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "unreadable" };
  }
  if (!isRecord(parsed)) return { kind: "unreadable" };
  if (parsed.refused === false) return { kind: "done" };
  if (parsed.refused === true && typeof parsed.reason === "string") {
    return { kind: "refused", reason: parsed.reason };
  }
  return { kind: "unreadable" };
}

/** 置けなかったか解除できなかった理由。成功していれば`null`を返す。 */
function scriptFailure(result: ExecResult): string | null {
  if (result.exitCode !== 0) {
    return `the script failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`;
  }
  const outcome = readScriptOutcome(result.stdout);
  switch (outcome.kind) {
    case "done":
      return null;
    case "refused":
      return `the script refused (${outcome.reason})`;
    case "unreadable":
      return "the result of the script could not be read";
  }
}

/** 端末で確かめるときに見せる文。 */
function confirmationOf(command: StopCommand): string {
  switch (command.kind) {
    case "place":
      return PLACE_MESSAGE;
    case "kill_only":
      return KILL_MESSAGE;
    case "release":
      return RELEASE_MESSAGE;
  }
}

/** workerに残ったClaudeのグループと、検査の枠のプロセスを止める。止められなかった段の数を返す。 */
async function killLeftovers(deps: StopDeps): Promise<number> {
  const listed = await deps.workerExec(PS_ARGV);
  if (listed.exitCode !== 0) {
    deps.print(
      `could not list the worker processes (exit ${String(listed.exitCode)}): ${listed.stderr.trim()}`,
    );
    return 1;
  }
  const groups = claudeGroupIds(listed.stdout);
  for (const pgid of groups) {
    await deps.workerExec(signalGroupArgv("TERM", pgid));
  }
  if (groups.length > 0) {
    await deps.sleep(KILL_GRACE_MS);
    // 先頭が終わっても、グループの子が残ることがある。先頭の有無で選ばず、見つけたグループすべてに送る。
    // グループが既に無ければ`kill`は失敗するが、止めるものが無いだけなので数えない。
    for (const pgid of groups) {
      await deps.workerExec(signalGroupArgv("KILL", pgid));
    }
  }
  // 枠のプロセスが無いuidでは`kill`が失敗するが、止めるものが無いだけなので数えない。
  for (const uid of deps.checkUids) {
    await deps.workerExec(killAllArgv(uid));
  }
  deps.print(
    `stopped ${String(groups.length)} claude process group(s) and the processes of ${String(deps.checkUids.length)} check user(s)`,
  );
  return 0;
}

async function cancelRunningJobs(deps: StopDeps): Promise<number> {
  const jobs = await deps.listRunningJobs();
  if (!jobs.ok) {
    deps.print(`could not list the running jobs: ${jobs.reason}`);
    return 1;
  }
  let failures = 0;
  for (const id of jobs.ids) {
    const cancelled = await deps.cancelJob(id);
    if (cancelled.exitCode === 0) {
      deps.print(`cancelled job ${id}`);
    } else {
      deps.print(`could not cancel job ${id}: ${cancelled.stderr.trim()}`);
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}

/** コマンドを実行し、終了コードを返す。どれかの段が失敗すれば1を返すが、残りの段は続ける。 */
export async function runStop(
  command: StopCommand,
  deps: StopDeps,
): Promise<number> {
  // Claudeのセッションは端末を持たないが、確認の前に明示して断る。
  if ((deps.env.CLAUDECODE ?? "") !== "") {
    deps.print(SESSION_REFUSAL);
    return 1;
  }
  if (!(await deps.confirm(confirmationOf(command)))) {
    deps.print("not confirmed; nothing was changed");
    return 1;
  }
  if (command.kind === "release") {
    const released = await deps.runScript(RELEASE_SCRIPT, {});
    deps.print(released.stdout.trim());
    const failure = scriptFailure(released);
    if (failure !== null) {
      deps.print(`could not release the stop-all: ${failure}`);
      return 1;
    }
    return 0;
  }
  let failures = 0;
  let notPlaced = false;
  if (command.kind === "place") {
    const placed = await deps.runScript(STOP_SCRIPT, {
      reason: command.reason,
    });
    deps.print(placed.stdout.trim());
    const failure = scriptFailure(placed);
    // 置けなくても、ジョブの中止とプロセスの停止は続ける。Windmillで止められないときの受け皿だからである。
    if (failure !== null) {
      deps.print(
        `could not place the stop-all through Windmill: ${failure}. Continuing with the process kill.`,
      );
      failures += 1;
      notPlaced = true;
    }
    deps.print(
      `waiting ${String(SETTLE_WAIT_MS / 1000)}s for the running claude and checks to stop by themselves`,
    );
    await deps.sleep(SETTLE_WAIT_MS);
    failures += await cancelRunningJobs(deps);
  }
  failures += await killLeftovers(deps);
  if (notPlaced) deps.print(NOT_PLACED_WARNING);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 実際の入出力
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dir, "..");
const COMPOSE_FILE = resolve(ROOT, "infra/docker-compose.yml");
/** 1回のコマンドを待つ上限(ミリ秒)。Console用workerが止まっていても、端末を止めたままにしない。 */
const COMMAND_TIMEOUT_MS = 120_000;

/** 起動した子プロセス。端末で中断されたときに、孤児として残さず終了時に止める。 */
const liveChildren = new Set<ReturnType<typeof Bun.spawn>>();

process.on("exit", () => {
  for (const child of liveChildren) child.kill();
});

async function capture(argv: readonly string[]): Promise<ExecResult> {
  const child = Bun.spawn([...argv], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: COMMAND_TIMEOUT_MS,
  });
  liveChildren.add(child);
  child.exited.finally(() => liveChildren.delete(child));
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function compose(service: string, argv: readonly string[]): string[] {
  return [
    "docker",
    "compose",
    "-f",
    COMPOSE_FILE,
    "exec",
    "-T",
    service,
    ...argv,
  ];
}

async function listRunningJobs(): Promise<JobList> {
  const result = await capture([
    "docker",
    "compose",
    "-f",
    COMPOSE_FILE,
    "exec",
    "-T",
    "-e",
    "PGOPTIONS=-c default_transaction_read_only=on",
    "db",
    "psql",
    "-U",
    "postgres",
    "-d",
    "windmill",
    "-X",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    runningJobsSql(),
  ]);
  if (result.exitCode !== 0) {
    return { ok: false, reason: result.stderr.trim() };
  }
  const reading = parseRunningJobs(result.stdout);
  if (!reading.ok) return { ok: false, reason: reading.reason };
  return { ok: true, ids: reading.rows.map((row) => row.id) };
}

function checkUids(): number[] {
  const first = parseCheckUid(process.env.FACTORY_CHECK_UID);
  const size = parsePoolSize(process.env.FACTORY_CHECK_POOL_SIZE);
  return Array.from({ length: size }, (_unused, index) => first + index);
}

async function confirmOnTerminal(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  console.log(message);
  return prompt("Type yes to continue:") === "yes";
}

async function main(): Promise<number> {
  const command = parseStopArgs(process.argv.slice(2));
  if (!command.ok) {
    console.error(command.reason);
    return 2;
  }
  return await runStop(command.value, {
    env: process.env,
    confirm: confirmOnTerminal,
    runScript: (path, args) =>
      capture([
        "wmill",
        "script",
        "run",
        path,
        "-d",
        JSON.stringify(args),
        "-s",
      ]),
    listRunningJobs,
    cancelJob: (id) =>
      capture(["wmill", "job", "cancel", id, "--reason", "stop_all"]),
    workerExec: (argv) => capture(compose("windmill_worker", argv)),
    sleep: (ms) => Bun.sleep(ms),
    print: (line) => {
      if (line !== "") console.log(line);
    },
    checkUids: checkUids(),
  });
}

if (import.meta.main) {
  process.exit(await main());
}
