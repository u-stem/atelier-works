#!/usr/bin/env bun
// スケジュールの凍結の、人の端末用のCLI。
//
// 凍結は、`wmill sync push`が指定したスケジュールの`enabled`などを書き換えないよう、
// 期限つきで押さえる。確認作業のためにスケジュールを止めている間に、無関係なmergeの
// 反映で有効に戻されることを防ぐ。状態はWindmillの変数`f/factory/freezes`に置く。
//
// 使い方(`mise run`のタスクから呼ぶ):
//   freeze.ts place --target f/factory/<name> --minutes <n> --reason <text>
//   freeze.ts list
//   freeze.ts release <id>
//   freeze.ts check          有効な凍結を表示する。読めないときは警告だけで通す
//   freeze.ts push [--prune] [--dry-run]   除外を付けて`wmill sync push`を実行する
//   freeze.ts reset          壊れた変数を空に戻す(人の端末の確認が要る)
//
// 置く主体は環境変数`CLAUDECODE`で分ける。あれば`session`、無ければ`human`とする。
// `human`の置く・解除・resetは、端末(TTY)で`yes`を入力して確かめる。`session`は自分の
// `holder`の凍結だけ解除できる。この区別は誤操作を防ぐためのもので、権限の境界ではない。
// 迂回のための環境変数は設けない。

import { resolve } from "node:path";
import {
  type FreezeInputs,
  type FreezePorts,
  loadFreezeInputs,
  mutateFreezeState,
  prepareFrozenPush,
} from "../f/factory/lib/freeze_apply.ts";
import {
  activeFreezes,
  emptyFreezeState,
  FREEZE_VARIABLE_PATH,
  type FreezeActor,
  type FreezeEntry,
  isActive,
  type Outcome,
  parseFreezeState,
  placeFreeze,
  releaseFreeze,
  sanitizeForDisplay,
  serializeFreezeState,
  sessionHolderFromBranch,
} from "../f/factory/lib/freezes.ts";

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

function fail<T>(reason: string): Outcome<T> {
  return { ok: false, reason };
}

/** 知らない引数は拒否する(`--excludes`や`--token`を素通ししない)。 */
export function parseArgs(argv: readonly string[]): Outcome<Command> {
  const [name, ...rest] = argv;
  switch (name) {
    case "list":
    case "check":
    case "reset":
      return rest.length === 0
        ? { ok: true, value: { kind: name } }
        : fail(`${name} takes no arguments`);
    case "release": {
      const [id, ...extra] = rest;
      return id !== undefined && extra.length === 0
        ? { ok: true, value: { kind: "release", id } }
        : fail("usage: release <id>");
    }
    case "push": {
      let prune = false;
      let dryRun = false;
      for (const arg of rest) {
        if (arg === "--prune") prune = true;
        else if (arg === "--dry-run") dryRun = true;
        else return fail(`unknown argument for push: ${arg}`);
      }
      return { ok: true, value: { kind: "push", prune, dryRun } };
    }
    case "place":
      return parsePlace(rest);
    default:
      return fail(
        "usage: freeze.ts place|list|release|check|push|reset (see the header of scripts/freeze.ts)",
      );
  }
}

function parsePlace(args: readonly string[]): Outcome<Command> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      (flag !== "--target" && flag !== "--minutes" && flag !== "--reason") ||
      value === undefined ||
      values.has(flag)
    ) {
      return fail(
        "usage: place --target f/factory/<name> --minutes <n> --reason <text>",
      );
    }
    values.set(flag, value);
  }
  const target = values.get("--target");
  const minutes = values.get("--minutes");
  const reason = values.get("--reason");
  if (target === undefined || minutes === undefined || reason === undefined) {
    return fail("place needs --target, --minutes, and --reason");
  }
  if (!/^[0-9]+$/.test(minutes)) {
    return fail("--minutes must be a positive integer");
  }
  return {
    ok: true,
    value: { kind: "place", target, minutes: Number(minutes), reason },
  };
}

/** `CLAUDECODE`があれば`session`、無ければ`human`。`HEAD`はdetached HEADの印として空と同じに扱う。 */
export function deriveActor(
  env: Readonly<Record<string, string | undefined>>,
  branch: string,
): FreezeActor {
  if (env.CLAUDECODE === undefined || env.CLAUDECODE === "") {
    return { kind: "human", holder: "human" };
  }
  return {
    kind: "session",
    holder: sessionHolderFromBranch(branch === "HEAD" ? "" : branch),
  };
}

export function buildPushArgv(
  excludesArg: string,
  flags: { readonly prune: boolean; readonly dryRun: boolean },
): string[] {
  const argv = ["wmill", "sync", "push"];
  if (flags.dryRun) argv.push("--dry-run");
  else argv.push("--yes");
  if (!flags.prune && !flags.dryRun) argv.push("--keep-deleted");
  argv.push(excludesArg);
  return argv;
}

export type CaptureResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const VARIABLE_DESCRIPTION =
  "スケジュールの凍結の状態です。mise run freeze:placeなどが書くため、通常は人が編集する必要はありません。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `wmill`のCLIで変数を読み書きする入出力。変数の有無は一覧で確かめ、
 * 一覧に無いと確かめられたときだけ「無い」とする。それ以外の失敗は読み取りの失敗にする。
 */
export function wmillCliPorts(
  capture: (argv: readonly string[]) => Promise<CaptureResult>,
  now: () => Date,
): FreezePorts {
  return {
    readVariable: async () => {
      const list = await capture(["wmill", "variable", "list", "--json"]);
      if (list.exitCode !== 0) {
        throw new Error("wmill variable list failed");
      }
      const items: unknown = JSON.parse(list.stdout);
      if (!Array.isArray(items)) {
        throw new Error("wmill variable list returned an unexpected shape");
      }
      const found = items.some(
        (item) => isRecord(item) && item.path === FREEZE_VARIABLE_PATH,
      );
      if (!found) return null;
      const got = await capture([
        "wmill",
        "variable",
        "get",
        FREEZE_VARIABLE_PATH,
        "--json",
      ]);
      if (got.exitCode !== 0) throw new Error("wmill variable get failed");
      const detail: unknown = JSON.parse(got.stdout);
      if (!isRecord(detail) || typeof detail.value !== "string") {
        throw new Error("wmill variable get returned no string value");
      }
      return detail.value;
    },
    writeVariable: async (text) => {
      const added = await capture([
        "wmill",
        "variable",
        "add",
        text,
        FREEZE_VARIABLE_PATH,
        "--no-secret",
        "--yes",
        "--description",
        VARIABLE_DESCRIPTION,
      ]);
      if (added.exitCode !== 0) throw new Error("wmill variable add failed");
    },
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

/** 実行中の`self_update`のpushは最大300秒で終わる。余裕を足した待ちの目安(分)。 */
const IN_FLIGHT_PUSH_WAIT_MINUTES = 5;
const PLACE_ID_ATTEMPTS = 5;

function formatJst(date: Date): string {
  const text = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${text} JST`;
}

function describeEntry(entry: FreezeEntry, now: Date): string {
  const status = isActive(entry, now)
    ? "active"
    : entry.released_at === null
      ? "expired"
      : "released";
  return [
    entry.id,
    status,
    entry.target,
    `until ${formatJst(new Date(entry.expires_at))}`,
    `${entry.holder_kind} "${sanitizeForDisplay(entry.holder)}"`,
    `reason "${sanitizeForDisplay(entry.reason)}"`,
  ].join("  ");
}

/** `human`は端末で確かめる。`session`は確認なしで通す(自分の凍結の範囲は呼び出し側が見る)。 */
async function authorize(
  actor: FreezeActor,
  message: string,
  deps: CliDeps,
): Promise<boolean> {
  if (actor.kind === "session") return true;
  if (await deps.confirm(message)) return true;
  deps.print(
    "refused: a human must confirm in an interactive terminal by typing yes",
  );
  return false;
}

export async function runCommand(
  command: Command,
  deps: CliDeps,
): Promise<number> {
  const actor = deriveActor(deps.env, await deps.branch());
  switch (command.kind) {
    case "place":
      return await runPlace(command, actor, deps);
    case "release":
      return await runRelease(command.id, actor, deps);
    case "list":
      return await runList(deps);
    case "check":
      return await runCheck(deps);
    case "push":
      return await runPush(command, deps);
    case "reset":
      return await runReset(actor, deps);
  }
}

async function runPlace(
  command: Extract<Command, { kind: "place" }>,
  actor: FreezeActor,
  deps: CliDeps,
): Promise<number> {
  const inputs = await deps.loadInputs();
  if (!inputs.ok) {
    deps.print(`refused: ${inputs.reason}`);
    return 1;
  }
  const summary = `freeze ${command.target} for ${command.minutes} minutes, reason "${sanitizeForDisplay(command.reason)}"`;
  if (!(await authorize(actor, summary, deps))) return 1;
  for (let attempt = 0; attempt < PLACE_ID_ATTEMPTS; attempt++) {
    const id = deps.newId();
    let result: Outcome<unknown>;
    try {
      result = await mutateFreezeState(deps.ports, (state, now) =>
        placeFreeze(
          state,
          {
            id,
            target: command.target,
            minutes: command.minutes,
            reason: command.reason,
            holder_kind: actor.kind,
            holder: actor.holder,
          },
          inputs.value.known,
          now,
        ),
      );
    } catch (err) {
      deps.print(`failed: ${errorMessage(err)}`);
      return 1;
    }
    if (!result.ok) {
      if (result.reason.includes("already in use")) continue;
      deps.print(`refused: ${result.reason}`);
      return 1;
    }
    return await confirmPlaced(id, command, deps);
  }
  deps.print("failed: could not pick an unused freeze id");
  return 1;
}

/** 書いた後に読み直し、自分の行が残っていることを確かめる(同時の書き込みに負けていないか)。 */
async function confirmPlaced(
  id: string,
  command: Extract<Command, { kind: "place" }>,
  deps: CliDeps,
): Promise<number> {
  let state: Outcome<ReturnType<typeof emptyFreezeState>>;
  try {
    state = parseFreezeState(await deps.ports.readVariable());
  } catch (err) {
    deps.print(`failed to confirm the freeze: ${errorMessage(err)}`);
    return 1;
  }
  const entry = state.ok
    ? state.value.freezes.find((e) => e.id === id)
    : undefined;
  if (entry === undefined) {
    deps.print("the freeze was lost to a concurrent write; place it again");
    return 1;
  }
  const now = deps.ports.now();
  const safeAt = new Date(now.getTime() + IN_FLIGHT_PUSH_WAIT_MINUTES * 60_000);
  deps.print(
    `placed ${id}: ${command.target} until ${formatJst(new Date(entry.expires_at))}`,
  );
  deps.print(
    `a self_update push that started before now may still run; stop the schedule after ${formatJst(safeAt).slice(11)}`,
  );
  return 0;
}

async function runRelease(
  id: string,
  actor: FreezeActor,
  deps: CliDeps,
): Promise<number> {
  if (!(await authorize(actor, `release freeze ${id}`, deps))) return 1;
  let result: Outcome<unknown>;
  try {
    result = await mutateFreezeState(deps.ports, (state, now) =>
      releaseFreeze(state, id, actor, now),
    );
  } catch (err) {
    deps.print(`failed: ${errorMessage(err)}`);
    return 1;
  }
  if (!result.ok) {
    deps.print(`refused: ${result.reason}`);
    return 1;
  }
  deps.print(`released ${id}`);
  return 0;
}

async function runList(deps: CliDeps): Promise<number> {
  let state: Outcome<ReturnType<typeof emptyFreezeState>>;
  try {
    state = parseFreezeState(await deps.ports.readVariable());
  } catch (err) {
    deps.print(
      `failed: could not read the freeze variable: ${errorMessage(err)}`,
    );
    return 1;
  }
  if (!state.ok) {
    deps.print(`failed: ${state.reason}`);
    return 1;
  }
  const now = deps.ports.now();
  if (state.value.freezes.length === 0) deps.print("no freezes");
  for (const entry of state.value.freezes) {
    deps.print(describeEntry(entry, now));
  }
  return 0;
}

/** 読めないときは警告だけで通す(`deploy`が止まっているスタックを起こせるように)。pushの時点では読めないと止める。 */
async function runCheck(deps: CliDeps): Promise<number> {
  let raw: string | null;
  try {
    raw = await deps.ports.readVariable();
  } catch (err) {
    deps.print(
      `warning: could not read the freeze variable (${errorMessage(err)}); the push will refuse to run until it is readable`,
    );
    return 0;
  }
  const state = parseFreezeState(raw);
  if (!state.ok) {
    deps.print(
      `failed: ${state.reason}; a human can run "mise run freeze:reset"`,
    );
    return 1;
  }
  const now = deps.ports.now();
  const active = activeFreezes(state.value, now);
  deps.print(`active freezes: ${active.length}`);
  for (const entry of active) deps.print(describeEntry(entry, now));
  return 0;
}

async function runPush(
  command: Extract<Command, { kind: "push" }>,
  deps: CliDeps,
): Promise<number> {
  const inputs = await deps.loadInputs();
  if (!inputs.ok) {
    deps.print(`refused to push: ${inputs.reason}`);
    return 1;
  }
  const plan = await prepareFrozenPush(deps.ports, inputs.value);
  if (!plan.ok) {
    deps.print(`refused to push: ${plan.reason}`);
    return 1;
  }
  for (const warning of plan.value.warnings) deps.print(`warning: ${warning}`);
  for (const target of plan.value.excludedTargets) {
    deps.print(`frozen, not pushed: ${target}`);
  }
  return await deps.runPush(buildPushArgv(plan.value.excludesArg, command));
}

async function runReset(actor: FreezeActor, deps: CliDeps): Promise<number> {
  if (actor.kind !== "human") {
    deps.print("refused: only a human can reset the freezes");
    return 1;
  }
  if (!(await authorize(actor, "reset all freezes to empty", deps))) return 1;
  try {
    await deps.ports.writeVariable(serializeFreezeState(emptyFreezeState()));
  } catch (err) {
    deps.print(`failed: ${errorMessage(err)}`);
    return 1;
  }
  deps.print("reset: no freezes");
  return 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

async function capture(argv: readonly string[]): Promise<CaptureResult> {
  const child = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runInherited(argv: readonly string[]): Promise<number> {
  const child = Bun.spawn([...argv], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" },
  });
  return await child.exited;
}

async function confirmOnTerminal(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  console.log(message);
  return prompt("Type yes to continue:") === "yes";
}

async function currentBranch(): Promise<string> {
  try {
    const result = await capture(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    return result.exitCode === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function main(): Promise<number> {
  const command = parseArgs(process.argv.slice(2));
  if (!command.ok) {
    console.error(command.reason);
    return 2;
  }
  const root = resolve(import.meta.dir, "..");
  const deps: CliDeps = {
    ports: wmillCliPorts(capture, () => new Date()),
    loadInputs: () => loadFreezeInputs(root),
    runPush: runInherited,
    branch: currentBranch,
    env: process.env,
    confirm: confirmOnTerminal,
    print: (line) => console.log(line),
    newId: () => crypto.randomUUID().replaceAll("-", "").slice(0, 8),
  };
  return await runCommand(command.value, deps);
}

if (import.meta.main) {
  process.exit(await main());
}
