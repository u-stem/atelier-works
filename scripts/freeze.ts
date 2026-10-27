#!/usr/bin/env bun
// スケジュールの凍結とdeployの保留の、人の端末用のCLI。
//
// スケジュールの凍結は、`wmill sync push`が指定したスケジュールの`enabled`などを書き換えないよう、
// 期限つきで押さえる。確認作業のためにスケジュールを止めている間に、無関係なmergeの
// 反映で有効に戻されることを防ぐ。
// deployの保留は、反映全体(push、migration、`self_update`の反映)を期限つきで待たせる。
// 状態はどちらもWindmillの変数`f/factory/freezes`に置く。
//
// 使い方(`mise run`のタスクから呼ぶ):
//   freeze.ts place --target f/factory/<name> --minutes <n> --reason <text>
//   freeze.ts place --scope deploy --minutes <n> --reason <text>
//   freeze.ts list
//   freeze.ts release <id>
//   freeze.ts check          有効な凍結を表示する。deployの保留があれば1を返す。読めないときは警告だけで通す
//   freeze.ts push [--prune] [--dry-run]   除外を付けて`wmill sync push`を実行する。deployの保留があれば拒否する
//   freeze.ts migrate        `wmill datatable migrate up`を実行する。deployの保留があるか、読めなければ拒否する
//   freeze.ts apply          1回の読み取りで、pushに続けてmigrateを実行する
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
  type FrozenPushPlan,
  loadFreezeInputs,
  mutateFreezeState,
  prepareFrozenPush,
  readActiveDeployFreezes,
  shouldHoldDeploy,
} from "../f/factory/lib/freeze_apply.ts";
import {
  activeDeployFreezes,
  activeFreezes,
  type DeployFreezeEntry,
  emptyFreezeState,
  FREEZE_ID_IN_USE,
  FREEZE_VARIABLE_PATH,
  type FreezeActor,
  type FreezeState,
  isActive,
  type Outcome,
  parseFreezeState,
  placeDeployFreeze,
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
  | {
      readonly kind: "place_deploy";
      readonly minutes: number;
      readonly reason: string;
    }
  | { readonly kind: "migrate" }
  | { readonly kind: "apply" }
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
    case "migrate":
    case "apply":
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
        "usage: freeze.ts place|list|release|check|push|migrate|apply|reset (see the header of scripts/freeze.ts)",
      );
  }
}

const PLACE_USAGE =
  "usage: place --target f/factory/<name> --minutes <n> --reason <text> | place --scope deploy --minutes <n> --reason <text>";

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
  const scope = values.get("--scope") ?? "schedule";
  const target = values.get("--target");
  const minutes = values.get("--minutes");
  const reason = values.get("--reason");
  if (scope !== "schedule" && scope !== "deploy") {
    return fail("--scope must be schedule or deploy");
  }
  if (minutes === undefined || reason === undefined) {
    return fail("place needs --minutes and --reason");
  }
  if (!/^[0-9]+$/.test(minutes)) {
    return fail("--minutes must be a positive integer");
  }
  if (scope === "deploy") {
    if (target !== undefined) {
      return fail("--target cannot be used with --scope deploy");
    }
    return {
      ok: true,
      value: { kind: "place_deploy", minutes: Number(minutes), reason },
    };
  }
  if (target === undefined) {
    return fail("place needs --target for the schedule scope");
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

/** `wmill variable list`が1回で返す件数の上限(サーバーの既定のページ件数)。これ以上なら一覧が切れている可能性がある。 */
const LIST_PAGE_LIMIT = 100;

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
      const got = await capture([
        "wmill",
        "variable",
        "get",
        FREEZE_VARIABLE_PATH,
        "--json",
      ]);
      if (got.exitCode === 0) {
        const detail: unknown = JSON.parse(got.stdout);
        if (!isRecord(detail) || typeof detail.value !== "string") {
          throw new Error("wmill variable get returned no string value");
        }
        return detail.value;
      }
      // 読めなかった。変数が無いと一覧で確かめられたときだけ「無い」とし、ほかは読み取りの失敗にする。
      const list = await capture(["wmill", "variable", "list", "--json"]);
      if (list.exitCode !== 0) {
        throw new Error("wmill variable get and list failed");
      }
      const items: unknown = JSON.parse(list.stdout);
      if (!Array.isArray(items)) {
        throw new Error("wmill variable list returned an unexpected shape");
      }
      if (items.length >= LIST_PAGE_LIMIT) {
        throw new Error("wmill variable list may be cut at the page size");
      }
      const found = items.some(
        (item) => isRecord(item) && item.path === FREEZE_VARIABLE_PATH,
      );
      if (found) throw new Error("wmill variable get failed");
      return null;
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
  readonly runMigrate: (argv: readonly string[]) => Promise<number>;
  /** `check`が変数を読む待ちの上限(ミリ秒)。 */
  readonly checkReadTimeoutMs: number;
};

/**
 * 凍結を置く前に始まった`self_update`のpushが終わるまでの目安(分)。
 * 凍結の読み(10秒)、トークンの取得(30秒)、push(300秒)、時間切れ後の停止の猶予(約11秒)で約351秒。
 * 余裕を足して7分にする。
 */
const IN_FLIGHT_PUSH_WAIT_MINUTES = 7;

/**
 * deployの保留を置く前に始まった`self_update`の回が、push、migrate up、記録を終えるまでの目安(分)。
 * 凍結の読みの後、トークンの取得(30秒)、push(300秒と停止の猶予13秒)、migrate up(同じく313秒)で約656秒。
 * 余裕を足して13分にする。
 */
const IN_FLIGHT_DEPLOY_WAIT_MINUTES = 13;
const PLACE_ID_ATTEMPTS = 5;

/** 一覧の対象の欄に出す、deployの保留の印。 */
const DEPLOY_LABEL = "deploy";

/** `check`が変数を読む待ちの上限。凍結の読む段(`self_update`)と同じ10秒にする。 */
const CHECK_READ_TIMEOUT_MS = 10_000;

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

function describeEntry(
  entry: DeployFreezeEntry,
  target: string,
  now: Date,
): string {
  const status = isActive(entry, now)
    ? "active"
    : entry.released_at === null
      ? "expired"
      : "released";
  return [
    entry.id,
    status,
    target,
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
      return await runPush(command, actor, deps);
    case "reset":
      return await runReset(actor, deps);
    case "place_deploy":
      return await runPlaceDeploy(command, actor, deps);
    case "migrate":
      return await runMigrate(deps);
    case "apply":
      return await runApply(deps);
  }
}

/**
 * 空いているidを選んで、操作を当てて書く。idの衝突は選び直す。
 * 置けたらidを返し、置けなかったら理由を表示してnullを返す。
 */
async function placeWithFreshId(
  deps: CliDeps,
  operation: (
    id: string,
  ) => (state: FreezeState, now: Date) => Outcome<FreezeState>,
): Promise<string | null> {
  for (let attempt = 0; attempt < PLACE_ID_ATTEMPTS; attempt++) {
    const id = deps.newId();
    let result: Outcome<unknown>;
    try {
      result = await mutateFreezeState(deps.ports, operation(id));
    } catch (err) {
      deps.print(`failed: ${errorMessage(err)}`);
      return null;
    }
    if (!result.ok) {
      if (result.reason === FREEZE_ID_IN_USE) continue;
      deps.print(`refused: ${result.reason}`);
      return null;
    }
    return id;
  }
  deps.print("failed: could not pick an unused freeze id");
  return null;
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
  const summary = `freeze ${sanitizeForDisplay(command.target)} for ${command.minutes} minutes, reason "${sanitizeForDisplay(command.reason)}"`;
  if (!(await authorize(actor, summary, deps))) return 1;
  const id = await placeWithFreshId(
    deps,
    (freshId) => (state, now) =>
      placeFreeze(
        state,
        {
          id: freshId,
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
  if (id === null) return 1;
  const entry = await readPlaced(deps, (state) =>
    state.freezes.find((e) => e.id === id),
  );
  if (entry === null) return 1;
  const safeAt = new Date(
    deps.ports.now().getTime() + IN_FLIGHT_PUSH_WAIT_MINUTES * 60_000,
  );
  deps.print(
    `placed ${id}: ${command.target} until ${formatJst(new Date(entry.expires_at))}`,
  );
  deps.print(
    `a self_update push that started before now may still run; stop the schedule after ${formatJst(safeAt).slice(11)}`,
  );
  return 0;
}

async function runPlaceDeploy(
  command: Extract<Command, { kind: "place_deploy" }>,
  actor: FreezeActor,
  deps: CliDeps,
): Promise<number> {
  const summary = `hold every deployment for ${command.minutes} minutes, reason "${sanitizeForDisplay(command.reason)}"`;
  if (!(await authorize(actor, summary, deps))) return 1;
  const id = await placeWithFreshId(
    deps,
    (freshId) => (state, now) =>
      placeDeployFreeze(
        state,
        {
          id: freshId,
          minutes: command.minutes,
          reason: command.reason,
          holder_kind: actor.kind,
          holder: actor.holder,
        },
        now,
      ),
  );
  if (id === null) return 1;
  const entry = await readPlaced(deps, (state) =>
    state.deploy_freezes.find((e) => e.id === id),
  );
  if (entry === null) return 1;
  const safeAt = new Date(
    deps.ports.now().getTime() + IN_FLIGHT_DEPLOY_WAIT_MINUTES * 60_000,
  );
  deps.print(
    `placed ${id}: deploy until ${formatJst(new Date(entry.expires_at))}`,
  );
  deps.print(
    `a self_update run that started before now may still push and migrate; start the work after ${formatJst(safeAt).slice(11)}`,
  );
  return 0;
}

/** 書いた後に読み直し、自分の行が残っていることを確かめる(同時の書き込みに負けていないか)。 */
async function readPlaced(
  deps: CliDeps,
  find: (state: FreezeState) => DeployFreezeEntry | undefined,
): Promise<DeployFreezeEntry | null> {
  let state: Outcome<FreezeState>;
  try {
    state = parseFreezeState(await deps.ports.readVariable());
  } catch (err) {
    deps.print(`failed to confirm the freeze: ${errorMessage(err)}`);
    return null;
  }
  const entry = state.ok ? find(state.value) : undefined;
  if (entry === undefined) {
    deps.print("the freeze was lost to a concurrent write; place it again");
    return null;
  }
  return entry;
}

async function runRelease(
  id: string,
  actor: FreezeActor,
  deps: CliDeps,
): Promise<number> {
  const shown = sanitizeForDisplay(id);
  if (!(await authorize(actor, `release freeze ${shown}`, deps))) return 1;
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
  let state: Outcome<FreezeState>;
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
  if (
    state.value.freezes.length === 0 &&
    state.value.deploy_freezes.length === 0
  ) {
    deps.print("no freezes");
  }
  for (const entry of state.value.freezes) {
    deps.print(describeEntry(entry, entry.target, now));
  }
  for (const entry of state.value.deploy_freezes) {
    deps.print(describeEntry(entry, DEPLOY_LABEL, now));
  }
  return 0;
}

/** `ms`のうちに終わらなければ`timeout`を返す。待ちの後にタイマーを残さない。 */
async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ readonly done: T } | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolveExpired) => {
    timer = setTimeout(() => resolveExpired("timeout"), ms);
  });
  try {
    return await Promise.race([work.then((done) => ({ done })), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 有効なスケジュールの凍結とdeployの保留を表示し、deployの保留があれば1を返す。
 * 読めないときと、応答が上限を超えたときは警告だけで通す(`deploy`と`up`が、止まっているスタックを
 * 起こせるように)。後段のpushとmigrateは、読めないと止める。
 */
async function runCheck(deps: CliDeps): Promise<number> {
  let raw: string | null;
  try {
    const read = await within(
      deps.ports.readVariable(),
      deps.checkReadTimeoutMs,
    );
    if (read === "timeout") {
      deps.print(
        `warning: could not read the freeze variable (timed out after ${deps.checkReadTimeoutMs} ms); the push and the migration will refuse to run until it is readable`,
      );
      return 0;
    }
    raw = read.done;
  } catch (err) {
    deps.print(
      `warning: could not read the freeze variable (${errorMessage(err)}); the push and the migration will refuse to run until it is readable`,
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
  for (const entry of active) {
    deps.print(describeEntry(entry, entry.target, now));
  }
  const held = activeDeployFreezes(state.value, now);
  for (const entry of held) {
    deps.print(describeEntry(entry, DEPLOY_LABEL, now));
  }
  if (held.length > 0) {
    deps.print(
      "refused: a deploy freeze is active; wait until it ends, or ask its holder to release it (mise run freeze:list)",
    );
    return 1;
  }
  return 0;
}

/** 拒否の文言に載せる、deployの保留のidと期限。`reason`と`holder`は載せない。 */
function describeHold(held: FrozenPushPlan["deployFreezes"]): string {
  return held
    .map((h) => `${h.id} until ${formatJst(new Date(h.expires_at))}`)
    .join(", ");
}

/**
 * 変数を1回読み、pushの除外とdeployの保留を求める。`checkHold`が真でdeployの保留があれば拒否する。
 * 拒否や失敗のときは理由を表示してnullを返す。
 */
async function planPush(
  deps: CliDeps,
  action: string,
  checkHold: boolean,
): Promise<FrozenPushPlan | null> {
  const inputs = await deps.loadInputs();
  if (!inputs.ok) {
    deps.print(`refused to ${action}: ${inputs.reason}`);
    return null;
  }
  const plan = await prepareFrozenPush(deps.ports, inputs.value);
  if (!plan.ok) {
    deps.print(`refused to ${action}: ${plan.reason}`);
    return null;
  }
  if (checkHold && shouldHoldDeploy(plan.value)) {
    deps.print(
      `refused to ${action}: a deploy freeze is active (${describeHold(plan.value.deployFreezes)})`,
    );
    return null;
  }
  for (const warning of plan.value.warnings) deps.print(`warning: ${warning}`);
  for (const target of plan.value.excludedTargets) {
    deps.print(`frozen, not pushed: ${target}`);
  }
  return plan.value;
}

async function runPush(
  command: Extract<Command, { kind: "push" }>,
  actor: FreezeActor,
  deps: CliDeps,
): Promise<number> {
  // 削除を確定するpushは、人が端末で確かめる(AGENTS.mdの決まり)。確認の無いセッションからは実行させない。
  const pruning = command.prune && !command.dryRun;
  if (pruning && actor.kind !== "human") {
    deps.print("refused: only a human can push with --prune");
    return 1;
  }
  // 保留による拒否の後に確認する。保留中に、人へyesを打たせない。
  const plan = await planPush(deps, "push", !command.dryRun);
  if (plan === null) return 1;
  if (
    pruning &&
    !(await authorize(actor, "push and delete remote-only items", deps))
  ) {
    return 1;
  }
  return await deps.runPush(buildPushArgv(plan.excludesArg, command));
}

const MIGRATE_ARGV: readonly string[] = ["wmill", "datatable", "migrate", "up"];

/** deployの保留があるか、読めなければ拒否する。通れば`wmill datatable migrate up`を実行する。 */
async function runMigrate(deps: CliDeps): Promise<number> {
  const held = await readActiveDeployFreezes(deps.ports);
  if (!held.ok) {
    deps.print(`refused to migrate: ${held.reason}`);
    return 1;
  }
  if (held.value.length > 0) {
    deps.print(
      `refused to migrate: a deploy freeze is active (${describeHold(held.value)})`,
    );
    return 1;
  }
  return await deps.runMigrate(MIGRATE_ARGV);
}

/** 1回の読み取りで、pushに続けてmigrateを実行する。pushが失敗したら、migrateは実行しない。 */
async function runApply(deps: CliDeps): Promise<number> {
  const plan = await planPush(deps, "apply", true);
  if (plan === null) return 1;
  const pushed = await deps.runPush(
    buildPushArgv(plan.excludesArg, { prune: false, dryRun: false }),
  );
  if (pushed !== 0) return pushed;
  return await deps.runMigrate(MIGRATE_ARGV);
}

async function runReset(actor: FreezeActor, deps: CliDeps): Promise<number> {
  if (actor.kind !== "human") {
    deps.print("refused: only a human can reset the freezes");
    return 1;
  }
  if (
    !(await authorize(
      actor,
      "reset all freezes, schedule and deploy, to empty",
      deps,
    ))
  ) {
    return 1;
  }
  try {
    await deps.ports.writeVariable(serializeFreezeState(emptyFreezeState()));
  } catch (err) {
    deps.print(`failed: ${errorMessage(err)}`);
    return 1;
  }
  deps.print("reset: no freezes");
  deps.print(
    "note: a schedule stopped from the Console stays off until the next deploy; turn it on in Windmill",
  );
  return 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/**
 * 起動した子プロセス。`check`が応答を待ちきれずに終わるとき、読みの`wmill`が残らないよう、
 * 終了時に止める。
 */
const liveChildren = new Set<ReturnType<typeof Bun.spawn>>();

process.on("exit", () => {
  for (const child of liveChildren) child.kill();
});

async function capture(
  argv: readonly string[],
  cwd?: string,
): Promise<CaptureResult> {
  const child = Bun.spawn([...argv], {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
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

/** 除外を作った作業ツリーでpushする(別のディレクトリから起動されても、読んだ内容とpushする内容をそろえる)。 */
async function runInherited(
  argv: readonly string[],
  cwd: string,
): Promise<number> {
  const child = Bun.spawn([...argv], {
    cwd,
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
    ports: wmillCliPorts(
      (argv) => capture(argv, root),
      () => new Date(),
    ),
    loadInputs: () => loadFreezeInputs(root),
    runPush: (argv) => runInherited(argv, root),
    runMigrate: (argv) => runInherited(argv, root),
    checkReadTimeoutMs: CHECK_READ_TIMEOUT_MS,
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
