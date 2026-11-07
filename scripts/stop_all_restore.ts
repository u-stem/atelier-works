// 全停止が止めた`*_enabled`を、記録(`f/factory/stop_all_record`)から戻す手順。
// ホストの`mise run stop:restore`(`scripts/stop_all.ts restore`)が呼ぶ。Windmillには同期しない。
// 入出力は差し替えられる形で受け取り、ここでは`wmill`も端末も直接は使わない。
//
// 戻すのは、記録にあり、設定に自分のキーとして実在し、今`false`の名前だけである。
// 1つ足すたびに本番の読み込み(`parseFactoryConfig`)で検査し、通らない名前は足さない。
// 人が`true`にした設定、記録に無い設定、`--except`で除いた設定は変えない。
// 書く直前に設定を読み直して比べ、書いた後に全停止をもう一度読む。
// 全停止が置かれていたら、読み直した設定の`true`の`*_enabled`を、全停止と同じ規則ですべて`false`に書き直す。
// 書き込みが成功したら記録をすべて消す。戻さなかった名前を次の実行に持ち越さず、止めたままにした機能が後で戻らないためである。
// 消すのは、最初に読んだ記録が変わっておらず、全停止が空のときだけである。

import { parseFactoryConfig } from "../f/factory/lib/config.ts";
import { holdsReference } from "../f/factory/lib/console_redact.ts";
import {
  enabledFlags,
  isRecordableFlag,
  parseStopAllRecord,
  parseStopAllValue,
  type StopAllRecord,
} from "../f/factory/lib/stop_all.ts";
import { isRecord } from "../f/factory/lib/types.ts";

export type RestoreRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export type RestoreWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** 戻す手順が読み書きするWindmillの値。読み取りは、変数が無いときも失敗として返してよい。 */
export type RestoreStore = {
  /** 全停止の変数の値。空なら空の文字列か`null`。 */
  readonly readStopAll: () => Promise<RestoreRead<string | null>>;
  /** 記録の変数の値。空なら空の文字列か`null`。 */
  readonly readRecord: () => Promise<RestoreRead<string | null>>;
  /** `factory_config`の、補間しない生の値。 */
  readonly readConfig: () => Promise<RestoreRead<unknown>>;
  /** `factory_config`の値を、渡した値で置き換える。 */
  readonly writeConfig: (
    value: Record<string, unknown>,
  ) => Promise<RestoreWrite>;
  /** 記録の変数を空にする。 */
  readonly clearRecord: () => Promise<RestoreWrite>;
};

export type RestoreIo = RestoreStore & {
  readonly now: () => Date;
  /** 端末で確かめる。`yes`が入力されたときだけ真を返す。 */
  readonly confirm: (message: string) => Promise<boolean>;
  readonly print: (line: string) => void;
};

/**
 * 戻さない理由。
 * - already_on: 今`true`である。人が有効にしたものなので変えない。
 * - missing: 設定に自分のキーとして無い。
 * - not_boolean: 値が真偽値でない。
 * - invalid_combination: 有効にすると、設定が本番の読み込みの検査を通らない。
 * - excepted: `--except`で除いた。
 */
export type RestoreSkipReason =
  | "already_on"
  | "missing"
  | "not_boolean"
  | "invalid_combination"
  | "excepted";

export type RestoreSkip = {
  readonly name: string;
  readonly reason: RestoreSkipReason;
};

/** 書く設定と、戻す名前、書き直す`*_since`、戻さない名前。 */
export type RestorePlan = {
  readonly next: Record<string, unknown>;
  readonly restore: readonly string[];
  readonly since: readonly string[];
  readonly skip: readonly RestoreSkip[];
};

export type ExceptParse =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 先に戻す名前。後の名前の検査が、先の名前が有効であることを求めるためである。
 * `pr_conflict_fix_enabled`は、`pr_conflict_watch_enabled`が有効でないと読み込みを通らない。
 */
const RESTORE_FIRST: readonly string[] = ["pr_conflict_watch_enabled"];

const SKIP_LABELS: Readonly<Record<RestoreSkipReason, string>> = {
  already_on: "already on",
  missing: "no longer in factory_config",
  not_boolean: "not a boolean in factory_config",
  invalid_combination:
    "factory_config would not pass the config check with it on",
  excepted: "left out with --except",
};

/** `--except`の値(カンマ区切りの名前)を読む。名前の形は記録と同じ規則で確かめる。 */
export function parseExceptNames(text: string): ExceptParse {
  const names = text.split(",").map((name) => name.trim());
  const wrong = names.find((name) => !isRecordableFlag(name));
  if (wrong !== undefined) {
    return {
      ok: false,
      reason: `--except takes *_enabled names separated by commas, such as implement_enabled; got ${JSON.stringify(wrong)}`,
    };
  }
  return { ok: true, names: [...new Set(names)] };
}

/** 戻す順。`RESTORE_FIRST`の名前を先に、残りを名前の順に並べる。 */
function restoreOrder(names: readonly string[]): string[] {
  const rank = (name: string): number => {
    const index = RESTORE_FIRST.indexOf(name);
    return index === -1 ? RESTORE_FIRST.length : index;
  };
  return [...names].sort(
    (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

function passesConfigCheck(config: Record<string, unknown>): boolean {
  try {
    parseFactoryConfig(config);
    return true;
  } catch {
    return false;
  }
}

/**
 * 戻す計画を作る。設定は変えず、書く値を`next`に返す。
 * 候補を戻す順に1つずつ`true`にし、`<名前>_since`のキーが設定にあれば実行時刻に書き直して、検査を通るものだけを残す。
 * `*_since`を書き直すのは、止めている間に起きたことまで、戻した機能が拾いに行かないためである。
 */
export function planRestore(input: {
  readonly config: Record<string, unknown>;
  readonly recorded: readonly string[];
  readonly except: readonly string[];
  readonly now: Date;
}): RestorePlan {
  const { config } = input;
  const skip: RestoreSkip[] = [];
  const candidates: string[] = [];
  for (const name of input.recorded) {
    if (input.except.includes(name)) {
      skip.push({ name, reason: "excepted" });
    } else if (!Object.hasOwn(config, name)) {
      skip.push({ name, reason: "missing" });
    } else if (config[name] === true) {
      skip.push({ name, reason: "already_on" });
    } else if (config[name] !== false) {
      skip.push({ name, reason: "not_boolean" });
    } else {
      candidates.push(name);
    }
  }
  let next: Record<string, unknown> = { ...config };
  const restore: string[] = [];
  const since: string[] = [];
  for (const name of restoreOrder(candidates)) {
    const sinceKey = `${name}_since`;
    const rewritesSince = Object.hasOwn(config, sinceKey);
    const trial: Record<string, unknown> = { ...next, [name]: true };
    if (rewritesSince) trial[sinceKey] = input.now.toISOString();
    if (!passesConfigCheck(trial)) {
      skip.push({ name, reason: "invalid_combination" });
      continue;
    }
    next = trial;
    restore.push(name);
    if (rewritesSince) since.push(sinceKey);
  }
  return { next, restore, since, skip };
}

function printPlan(plan: RestorePlan, print: (line: string) => void): void {
  print("Will turn on:");
  if (plan.restore.length === 0) print("  (none)");
  for (const name of plan.restore) print(`  - ${name}`);
  if (plan.since.length > 0) {
    print(`Will rewrite to now: ${plan.since.join(", ")}`);
  }
  print("Will not turn on:");
  if (plan.skip.length === 0) print("  (none)");
  for (const { name, reason } of plan.skip) {
    print(`  - ${name}: ${SKIP_LABELS[reason]}`);
  }
}

function confirmationOf(plan: RestorePlan): string {
  return plan.restore.length === 0
    ? "This turns nothing on and clears the record of the stop-all, so the names above are not restored later."
    : "This turns on the settings listed above in factory_config and clears the record of the stop-all. The settings under 'Will not turn on' stay as they are.";
}

const STILL_STOPPED =
  "the stop-all is still placed (or its variable is corrupt); release it with mise run stop:release first. Nothing was changed.";

const INLINE_DEPTH_MAX = 16;

/**
 * 値のどこかに、`!inline`で始まる文字列があるか。入れ子の中も見る。
 * `wmill resource push`は、`content`が`!inline <path>`か`!inline_fileset <dir>`で始まる値を、ホストのファイルの中身に置き換えて書く。
 * リモートから読んだ値を書き戻すこの手順では、ホストの秘密のファイルを設定へ持ち出す経路になるので、その形の値を書かない。
 * 深さの上限を超える入れ子は、中を見切れないので、含むものとして扱う。
 */
export function holdsInlineFile(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.startsWith("!inline");
  if (depth >= INLINE_DEPTH_MAX) return true;
  if (Array.isArray(value)) {
    return value.some((item) => holdsInlineFile(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).some((item) =>
      holdsInlineFile(item, depth + 1),
    );
  }
  return false;
}

const INLINE_REFUSAL =
  "factory_config holds a value that starts with !inline, which wmill resource push would replace with a file of this host.";

function isClear(read: RestoreRead<string | null>): boolean {
  return read.ok && parseStopAllValue(read.value).kind === "clear";
}

/**
 * 戻す途中で全停止を見つけたら、設定を読み直し、`true`の`*_enabled`をすべて`false`にして書く。
 * 全停止と同じ規則で止め直すので、書き込みと並行してほかの処理が有効にした名前も止まる。
 * 戻した名前だけを戻すと、その間に有効になった機能が、全停止の間も動き続けるためである。
 * 記録は残す。
 */
async function stopAgain(io: RestoreIo): Promise<void> {
  const read = await io.readConfig();
  if (!read.ok || !isRecord(read.value)) {
    io.print(
      `A stop-all appeared while restoring (or could not be read), and factory_config could not be read again${read.ok ? "" : ` (${read.reason})`}. Turn every *_enabled setting off in factory_config by hand. The record was kept.`,
    );
    return;
  }
  if (holdsInlineFile(read.value)) {
    io.print(
      `A stop-all appeared while restoring (or could not be read). ${INLINE_REFUSAL} Turn every *_enabled setting off in factory_config by hand. The record was kept.`,
    );
    return;
  }
  const flags = enabledFlags(read.value);
  if (flags.length === 0) {
    io.print(
      "A stop-all appeared while restoring (or could not be read). Every *_enabled setting is already off; the record was kept.",
    );
    return;
  }
  const off: Record<string, unknown> = { ...read.value };
  for (const flag of flags) off[flag] = false;
  const undone = await io.writeConfig(off);
  io.print(
    undone.ok
      ? `A stop-all appeared while restoring (or could not be read). Turned ${flags.join(", ")} off again and kept the record; run mise run stop:restore again after releasing it.`
      : `A stop-all appeared while restoring (or could not be read), and the settings could not be turned off again (${undone.reason}). Turn ${flags.join(", ")} off in factory_config by hand. The record was kept.`,
  );
}

/** 設定を書き、書けたことと全停止が無いことを確かめる。確かめられたときだけ真を返す。 */
async function writeAndCheck(
  plan: RestorePlan,
  original: Record<string, unknown>,
  io: RestoreIo,
): Promise<boolean> {
  const again = await io.readConfig();
  if (!again.ok) {
    io.print(
      `could not read factory_config again: ${again.reason}. Nothing was changed.`,
    );
    return false;
  }
  if (!Bun.deepEquals(again.value, original)) {
    io.print(
      "factory_config changed after it was read. Nothing was written; run mise run stop:restore again.",
    );
    return false;
  }
  if (holdsInlineFile(plan.next)) {
    io.print(`${INLINE_REFUSAL} Nothing was written.`);
    return false;
  }
  const written = await io.writeConfig(plan.next);
  // 書き込みが時間切れで失敗しても、値は書かれていることがあるので、全停止を確かめる。
  const stopAll = await io.readStopAll();
  if (!isClear(stopAll)) {
    await stopAgain(io);
    return false;
  }
  if (!written.ok) {
    io.print(
      `could not write factory_config: ${written.reason}. Check factory_config; the record was kept.`,
    );
    return false;
  }
  const after = await io.readConfig();
  const current = after.ok && isRecord(after.value) ? after.value : null;
  if (
    current === null ||
    !plan.restore.every((name) => current[name] === true)
  ) {
    io.print(
      "could not confirm that the settings were turned on. Check factory_config; the record was kept.",
    );
    return false;
  }
  return true;
}

function exceptOption(except: readonly string[]): string {
  return except.length === 0 ? "" : ` -- --except ${except.join(",")}`;
}

/**
 * 記録を消す。最初に読んだ記録と今の記録が同じで、全停止が空のときだけ消す。
 * 戻している間に新しい全停止が記録を置き換えていたら、その記録を残す。消すと、新しい全停止が止めた名前を戻せなくなるためである。
 */
async function clearRecordIfUnchanged(
  first: StopAllRecord,
  plan: RestorePlan,
  except: readonly string[],
  io: RestoreIo,
): Promise<number> {
  const again = await io.readRecord();
  const now = again.ok ? parseStopAllRecord(again.value) : null;
  if (
    now === null ||
    now.kind !== "recorded" ||
    !Bun.deepEquals(now.record, first)
  ) {
    io.print(
      "The record of the stop-all changed while restoring, so a new stop-all may have recorded other names. The record was kept; release that stop-all and run mise run stop:restore again.",
    );
    return 1;
  }
  const stopAll = await io.readStopAll();
  if (!isClear(stopAll)) {
    if (plan.restore.length > 0) await stopAgain(io);
    else io.print(STILL_STOPPED);
    return 1;
  }
  const cleared = await io.clearRecord();
  if (!cleared.ok) {
    io.print(
      `could not clear the record of the stop-all: ${cleared.reason}. The settings listed under 'Will turn on' are on; run mise run stop:restore${exceptOption(except)} again with the same --except to clear the record.`,
    );
    return 1;
  }
  io.print(
    `turned on ${String(plan.restore.length)} setting(s) and cleared the record of the stop-all`,
  );
  return 0;
}

/**
 * 記録から設定を戻す。終了コードを返す。
 * 全停止が置かれているか読めないとき、記録が読めないか壊れているとき、記録に無い名前を`--except`に渡したとき、
 * 設定が参照か`!inline`の値を含むか検査を通らないときは、何も書かずに断る。
 * 記録が空なら、何もせず0を返す。
 */
export async function runRestore(
  except: readonly string[],
  io: RestoreIo,
): Promise<number> {
  const stopAll = await io.readStopAll();
  if (!stopAll.ok) {
    io.print(
      `could not read the stop-all variable: ${stopAll.reason}. Nothing was changed.`,
    );
    return 1;
  }
  if (!isClear(stopAll)) {
    io.print(STILL_STOPPED);
    return 1;
  }
  const recordRead = await io.readRecord();
  if (!recordRead.ok) {
    io.print(
      `could not read the record of the stop-all (it may not exist yet): ${recordRead.reason}. Nothing was changed.`,
    );
    return 1;
  }
  const record = parseStopAllRecord(recordRead.value);
  if (record.kind === "corrupt" || record.kind === "unreadable") {
    io.print(
      `the record of the stop-all is corrupt: ${record.reason}. Nothing was changed; turn the settings on by hand in factory_config.`,
    );
    return 1;
  }
  if (record.kind === "empty" || record.record.flags.length === 0) {
    io.print(
      "there is no record of settings that the stop-all turned off; nothing to restore.",
    );
    return 0;
  }
  // 綴りを誤った名前で除いたつもりの機能が、戻ってしまわないようにする。
  const unknown = except.filter((name) => !record.record.flags.includes(name));
  if (unknown.length > 0) {
    io.print(
      `--except names a setting that is not in the record: ${unknown.join(", ")}. The record lists ${record.record.flags.join(", ")}. Nothing was changed.`,
    );
    return 1;
  }
  const read = await io.readConfig();
  if (!read.ok) {
    io.print(
      `could not read factory_config: ${read.reason}. Nothing was changed.`,
    );
    return 1;
  }
  const original = read.value;
  if (!isRecord(original)) {
    io.print("factory_config is not an object. Nothing was changed.");
    return 1;
  }
  // 参照を含む値を書き戻すと、参照の先を扱う判断をこの手順が負うので、断る。
  if (holdsReference(original)) {
    io.print(
      "factory_config holds a $var: or $res: reference. Nothing was changed; turn the settings on by hand.",
    );
    return 1;
  }
  if (holdsInlineFile(original)) {
    io.print(
      `${INLINE_REFUSAL} Nothing was changed; turn the settings on by hand.`,
    );
    return 1;
  }
  try {
    parseFactoryConfig(original);
  } catch (err) {
    io.print(
      `factory_config does not pass the config check (config_invalid): ${err instanceof Error ? err.message : String(err)}. Nothing was changed; fix it first.`,
    );
    return 1;
  }
  const plan = planRestore({
    config: original,
    recorded: record.record.flags,
    except,
    now: io.now(),
  });
  printPlan(plan, io.print);
  if (!(await io.confirm(confirmationOf(plan)))) {
    io.print("not confirmed; nothing was changed");
    return 1;
  }
  if (plan.restore.length > 0 && !(await writeAndCheck(plan, original, io))) {
    return 1;
  }
  return await clearRecordIfUnchanged(record.record, plan, except, io);
}
