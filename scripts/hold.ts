#!/usr/bin/env bun
// 保留(hold)の、ホストの端末用のCLI。
//
// 保留は、対象を進めないことを、期限つきで伝える。止めるためだけに使い、何かを許可することはない。
// 状態は保留の表に置き、読み書きは`f/factory/lib/holds.ts`の関数が行う。
// このCLIは、psql経由の接続(`scripts/hold_psql.ts`)をその関数に渡す。
//
// 使い方(`mise run`のタスクから呼ぶ。mise経由でないと、composeに必要な環境変数が無い):
//   hold.ts list
//   hold.ts place --scope merge --target <owner>/<repo> --minutes <n> --reason <text>
//   hold.ts release <id>
//
// 置く主体は環境変数`CLAUDECODE`で分ける。あれば`session`、無ければ`human`とする。
// `human`の置く・解除は、端末(TTY)で`yes`を入力して確かめる。`session`は自分の`holder`の保留だけ解除できる。
// この区別は誤操作を防ぐためのもので、権限の境界ではない。迂回のための環境変数は設けない。
//
// 置けるのは、読み手のある範囲だけである。今は`merge`(Factoryのdependabotの自動マージと、ローカルのセッションのフック)だけで、
// `claim`は読み手がなく何も止めないので、置く操作を拒否する。`list`と`release`は両方の範囲を扱う。
// `merge`の保留が止めるのは、Factoryのdependabotの自動マージと、ローカルのClaudeのセッションの
// `gh pr merge`など(`scripts/claude-hooks/merge-guard.ts`)である。
// 人の端末、GitHubのWeb UI、クラウドのセッションのGitHubのMCPによるマージは止まらない。

import { resolve } from "node:path";
import {
  type ActiveFreezeCounts,
  countActiveFreezes,
  parseFreezeState,
} from "../f/factory/lib/freezes.ts";
import {
  HOLD_SCOPES,
  type HoldActor,
  type HoldRow,
  type HoldScope,
  type HoldSqlClient,
  listActiveHolds,
  listInvalidHolds,
  type Outcome,
  placeHold,
  releaseHold,
  sanitizeHoldText,
  validatePlaceInput,
} from "../f/factory/lib/holds.ts";
import { wmillCliPorts } from "./freeze.ts";
import {
  createHoldPsqlClient,
  HOLD_PSQL_TIMEOUT_MS,
  type HoldPsqlRun,
} from "./hold_psql.ts";

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

/** CLIが読み書きするデータベース。使い捨てのデータベースを渡すのは、実DBの検査だけである。 */
export const HOLD_DATABASE = "datatable_db";

/** 置く操作を受け付ける範囲。読み手が配線済みの範囲だけを入れる。 */
export const WIRED_SCOPES: readonly HoldScope[] = ["merge"];

/** 保留が止める経路の説明。`list`と`place`が表示する。 */
const COVERAGE_NOTE =
  "note: a merge hold stops the Factory dependabot from assessing the pull requests of the repository, even in a dry run; its last check before the merge matters only while dependabot_merge_enabled is true; a local Claude session is stopped before gh pr merge, but a person's terminal, the GitHub web UI, and a cloud session that merges through the GitHub MCP are not";

const HOLDER_MAX = 100;

function fail<T>(reason: string): Outcome<T> {
  return { ok: false, reason };
}

/** 知らない引数は拒否する。 */
export function parseArgs(argv: readonly string[]): Outcome<Command> {
  const [name, ...rest] = argv;
  switch (name) {
    case "list":
      return rest.length === 0
        ? { ok: true, value: { kind: "list" } }
        : fail("list takes no arguments");
    case "release": {
      const [id, ...extra] = rest;
      return id !== undefined && extra.length === 0 && /^[0-9]+$/.test(id)
        ? { ok: true, value: { kind: "release", id: Number(id) } }
        : fail("usage: release <id>");
    }
    case "place":
      return parsePlace(rest);
    default:
      return fail(
        "usage: hold.ts place|list|release (see the header of scripts/hold.ts)",
      );
  }
}

const PLACE_USAGE =
  "usage: place --scope merge --target <owner>/<repo> --minutes <n> --reason <text>";

function parsePlace(args: readonly string[]): Outcome<Command> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      (flag !== "--scope" &&
        flag !== "--target" &&
        flag !== "--minutes" &&
        flag !== "--reason") ||
      value === undefined ||
      values.has(flag)
    ) {
      return fail(PLACE_USAGE);
    }
    values.set(flag, value);
  }
  const scope = values.get("--scope");
  const target = values.get("--target");
  const minutes = values.get("--minutes");
  const reason = values.get("--reason");
  if (
    scope === undefined ||
    target === undefined ||
    minutes === undefined ||
    reason === undefined
  ) {
    return fail(
      `place needs --scope, --target, --minutes, and --reason; ${PLACE_USAGE}`,
    );
  }
  if (!/^[0-9]+$/.test(minutes)) {
    return fail("--minutes must be a positive integer");
  }
  return {
    ok: true,
    value: { kind: "place", scope, target, minutes: Number(minutes), reason },
  };
}

/** ブランチ名から`holder`を作る。detached HEADなどで空のときは`detached`にする。 */
function sessionHolder(branch: string): string {
  const cleaned = branch.trim().replace(/[^A-Za-z0-9._/-]/g, "-");
  const name = cleaned.length === 0 ? "detached" : cleaned;
  return `session:${name}`.slice(0, HOLDER_MAX);
}

/** `CLAUDECODE`があれば`session`、無ければ`human`。`HEAD`はdetached HEADの印として空と同じに扱う。 */
export function deriveActor(
  env: Readonly<Record<string, string | undefined>>,
  branch: string,
): HoldActor {
  if (env.CLAUDECODE === undefined || env.CLAUDECODE === "") {
    return { kind: "human", holder: "human" };
  }
  return {
    kind: "session",
    holder: sessionHolder(branch === "HEAD" ? "" : branch),
  };
}

export type CliDeps = {
  /** 読み取り専用の接続。 */
  readonly read: HoldSqlClient;
  /** 書き込める接続。 */
  readonly write: HoldSqlClient;
  readonly branch: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly print: (line: string) => void;
  /** 有効なスケジュールの凍結とdeployの保留の件数。読めなければ例外を投げる。 */
  readonly activeFreezeCounts: () => Promise<ActiveFreezeCounts>;
};

/** CLIが使う読み取り専用の接続と書き込める接続を作る。接続先は`HOLD_DATABASE`である。 */
export function holdClients(run?: HoldPsqlRun): {
  readonly read: HoldSqlClient;
  readonly write: HoldSqlClient;
} {
  const composeFile = resolve(import.meta.dir, "../infra/docker-compose.yml");
  const base = {
    composeFile,
    database: HOLD_DATABASE,
    timeoutMs: HOLD_PSQL_TIMEOUT_MS,
    ...(run === undefined ? {} : { run }),
  };
  return {
    read: createHoldPsqlClient({ ...base, mode: "read" }),
    write: createHoldPsqlClient({ ...base, mode: "write" }),
  };
}

function formatJst(iso: string): string {
  const text = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return `${text} JST`;
}

function describeHold(hold: HoldRow, status: "active" | "invalid"): string {
  return [
    String(hold.id),
    status,
    hold.scope,
    sanitizeHoldText(hold.target),
    `until ${formatJst(hold.expires_at)}`,
    `${hold.holder_kind} "${sanitizeHoldText(hold.holder)}"`,
    `reason "${sanitizeHoldText(hold.reason)}"`,
  ].join("  ");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `human`は端末で確かめる。`session`は確認なしで通す(自分の保留の範囲は`releaseHold`が見る)。 */
async function authorize(
  actor: HoldActor,
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
  switch (command.kind) {
    case "list":
      return await runList(deps);
    case "place":
      return await runPlace(command, deps);
    case "release":
      return await runRelease(command.id, deps);
  }
}

async function runList(deps: CliDeps): Promise<number> {
  const active = await listActiveHolds({}, deps.read);
  if (!active.ok) {
    deps.print(`failed: ${active.reason}`);
    return 1;
  }
  const invalid = await listInvalidHolds({}, deps.read);
  // 有効な保留は、無効な行を読めなくても先に出す。有効な保留を見落とさないためである。
  if (active.value.length === 0 && invalid.ok && invalid.value.length === 0) {
    deps.print("no holds");
  }
  for (const hold of active.value) deps.print(describeHold(hold, "active"));
  if (!invalid.ok) {
    deps.print(`failed: ${invalid.reason}`);
    return 1;
  }
  for (const hold of invalid.value) deps.print(describeHold(hold, "invalid"));
  try {
    const counts = await deps.activeFreezeCounts();
    deps.print(
      `active freezes: schedule ${String(counts.schedule)}, deploy ${String(counts.deploy)} (see mise run freeze:list)`,
    );
  } catch (err) {
    deps.print(
      `warning: could not read the freezes (${sanitizeHoldText(errorMessage(err)).slice(0, 200)}); run mise run freeze:list`,
    );
  }
  deps.print(COVERAGE_NOTE);
  return 0;
}

async function runPlace(
  command: Extract<Command, { kind: "place" }>,
  deps: CliDeps,
): Promise<number> {
  // 読み手の無い範囲は、DBに触れる前に拒否する。置いても何も止まらず、守られていると誤解させるため。
  const known = HOLD_SCOPES.some((scope) => scope === command.scope);
  if (known && !WIRED_SCOPES.some((scope) => scope === command.scope)) {
    deps.print(
      `refused: nothing reads ${sanitizeHoldText(command.scope)} holds yet, so a hold would not protect anything; it takes effect once a reader is wired`,
    );
    return 1;
  }
  const actor = deriveActor(deps.env, await deps.branch());
  const checked = validatePlaceInput({
    scope: command.scope,
    target: command.target,
    reason: command.reason,
    holder_kind: actor.kind,
    holder: actor.holder,
    minutes: command.minutes,
  });
  if (!checked.ok) {
    deps.print(`refused: ${checked.reason}`);
    return 1;
  }
  const input = checked.value;
  const summary = `hold ${input.scope} ${input.target} for ${String(input.minutes)} minutes, reason "${input.reason}"`;
  if (!(await authorize(actor, summary, deps))) return 1;
  const placed = await placeHold(input, deps.write);
  if (!placed.ok) {
    deps.print(`refused: ${placed.reason}`);
    return 1;
  }
  deps.print(
    `placed ${String(placed.value.id)}: ${input.scope} ${input.target} for ${String(input.minutes)} minutes`,
  );
  deps.print(COVERAGE_NOTE);
  return 0;
}

async function runRelease(id: number, deps: CliDeps): Promise<number> {
  const actor = deriveActor(deps.env, await deps.branch());
  if (!(await authorize(actor, `release hold ${String(id)}`, deps))) return 1;
  const released = await releaseHold(id, actor, deps.write);
  if (!released.ok) {
    deps.print(`refused: ${released.reason}`);
    return 1;
  }
  deps.print(`released ${String(released.value.id)}`);
  return 0;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

type Captured = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function capture(
  argv: readonly string[],
  cwd: string,
): Promise<Captured> {
  const child = Bun.spawn([...argv], {
    cwd,
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

async function confirmOnTerminal(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  console.log(message);
  return prompt("Type yes to continue:") === "yes";
}

async function currentBranch(root: string): Promise<string> {
  try {
    const result = await capture(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      root,
    );
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
  const { read, write } = holdClients();
  const freezePorts = wmillCliPorts(
    (argv) => capture(argv, root),
    () => new Date(),
  );
  const deps: CliDeps = {
    read,
    write,
    branch: () => currentBranch(root),
    env: process.env,
    confirm: confirmOnTerminal,
    print: (line) => console.log(line),
    activeFreezeCounts: async () => {
      const state = parseFreezeState(await freezePorts.readVariable());
      if (!state.ok) throw new Error(state.reason);
      return countActiveFreezes(state.value, freezePorts.now());
    },
  };
  return await runCommand(command.value, deps);
}

if (import.meta.main) {
  process.exit(await main());
}
