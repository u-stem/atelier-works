// 全停止が止めた`*_enabled`を、記録(`f/factory/stop_all_record`)から戻す手順。
// ホストの`mise run stop:restore`(`scripts/stop_all.ts restore`)が呼ぶ。Windmillには同期しない。
// 入出力は差し替えられる形で受け取り、ここでは`wmill`も端末も直接は使わない。
//
// 戻すのは、記録にあり、設定に自分のキーとして実在し、今`false`の名前だけである。
// 1つ足すたびに本番の読み込み(`parseFactoryConfig`)で検査し、通らない名前は足さない。
// 人が`true`にした設定、記録に無い設定、`--except`で除いた設定は変えない。
// 書く直前に設定と記録を読み直して比べ、書いた後に全停止をもう一度読む。
// 全停止が置かれていたら、読み直した設定の`true`の`*_enabled`を、全停止と同じ規則ですべて`false`に書き直す。
// 書き込みが成功したら記録をすべて消す。戻さなかった名前を次の実行に持ち越さず、止めたままにした機能が後で戻らないためである。
// 消す前に、最初に読んだ記録が変わっておらず、全停止が空であることを確かめる。
// 変数に条件つきの更新は無いので、確かめてから消すまでの間に置かれた全停止の記録は、消えうる。
// 消した後に、消す書き込みの成否によらず全停止を読み直し、置かれていれば警告して止め直す。読めなければ警告だけにする。
// 端末に出す設定の名前は、制御文字を字面にしてから出す。

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
  /** 標準エラーに警告を出す。 */
  readonly warn: (line: string) => void;
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

/** 計画を表示する。記録の時刻も出し、古い全停止の記録かを人が確かめられるようにする。 */
function printPlan(
  plan: RestorePlan,
  record: StopAllRecord,
  print: (line: string) => void,
): void {
  print(
    `The record of the stop-all was made at ${record.recorded_at} and lists ${String(record.flags.length)} setting(s).`,
  );
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

/** 端末で働きうる制御文字と書式文字、行と段落の区切り。`f/factory/lib/stop_all.ts`の検査と同じ範囲である。 */
const UNSAFE_FOR_TERMINAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function escapeChar(char: string): string {
  return `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
}

/**
 * 端末に出す文字列の、制御文字と書式文字を`\uXXXX`の字面に置き換える。改行とタブは残す。
 * 設定のキーや`wmill`の標準エラーは信頼できない入力で、端末の表示や題名を書き換える並びを含みうるためである。
 * 改行を残すのは、複数行のscriptの結果を読める形で出すためで、1行の値には`oneLine`を使う。
 */
export function safeForTerminal(text: string): string {
  return text.replace(UNSAFE_FOR_TERMINAL, (char) =>
    char === "\n" || char === "\t" ? char : escapeChar(char),
  );
}

/**
 * 1行の値(例外の文、`wmill`の失敗の理由)を、改行とタブも字面にして1行にする。
 * 値の中の改行が、このコマンドの出力に見える偽の行を作らないためである。
 */
export function oneLine(text: string): string {
  return text.replace(UNSAFE_FOR_TERMINAL, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\t") return "\\t";
    return escapeChar(char);
  });
}

/** 端末に出す設定の名前。記録してよい形の名前はそのまま、それ以外は引用符で囲み、制御文字を字面にして出す。 */
export function displayName(name: string): string {
  return isRecordableFlag(name) ? name : safeForTerminal(JSON.stringify(name));
}

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

/** 戻している途中で読んだ全停止の状態。読めないときは、止まっている扱いにする。 */
type StopAllCheck = "clear" | "placed" | "unreadable";

/**
 * 全停止の変数を読む。読めなければ1回だけ読み直す。
 * 一度の読み取りの失敗で、置かれていない全停止のために設定を止め直さないためである。
 */
async function checkStopAll(io: RestoreIo): Promise<StopAllCheck> {
  const first = await io.readStopAll();
  const read = first.ok ? first : await io.readStopAll();
  if (!read.ok) return "unreadable";
  return parseStopAllValue(read.value).kind === "clear" ? "clear" : "placed";
}

/** 止め直したときの、何が起きたかの文と、次にすることの文。読めなかった全停止を、置かれたものとして案内しない。 */
function stopAgainWords(
  cause: Exclude<StopAllCheck, "clear">,
  except: readonly string[],
): {
  readonly head: string;
  readonly next: string;
  /** 手で戻してよくなる時点。読めなかった全停止の解除を待たせない。 */
  readonly when: string;
} {
  return cause === "placed"
    ? {
        head: "A stop-all was placed while restoring.",
        next: `Run mise run stop:restore${exceptOption(except)} again after the stop-all is released.`,
        when: "after the stop-all is released",
      }
    : {
        head: "The stop-all variable could not be read while restoring, so the settings are treated as stopped.",
        next: `Check the stop-all variable in Windmill, then run mise run stop:restore${exceptOption(except)} again.`,
        when: "after confirming in Windmill that no stop-all is placed",
      };
}

/**
 * 止め直した後の記録の状態と、次にすることを伝える。
 * - during: 記録を消す前に止め直した。記録が最初のままなら、戻すコマンドを実行し直せばよい。
 * - after_clear: 記録を消した後に止め直した。記録はこの手順が消したので、戻した名前を手で戻すよう伝える。
 * 手で戻す名前は、今回戻した名前のうち、今の記録に無いものに限る。`--except`で除いた名前と、検査を通らなかった名前は含めない。
 */
async function reportRecord(
  cause: Exclude<StopAllCheck, "clear">,
  mode: "during" | "after_clear",
  first: StopAllRecord,
  plan: RestorePlan,
  except: readonly string[],
  io: RestoreIo,
): Promise<void> {
  const { next, when } = stopAgainWords(cause, except);
  if (mode === "after_clear") {
    io.print(
      `Turn these on by hand in factory_config ${when}, when they should be on: ${plan.restore.map(displayName).join(", ")}. Check the other *_enabled settings that are false at the same time.`,
    );
    return;
  }
  const again = await io.readRecord();
  const now = again.ok ? parseStopAllRecord(again.value) : null;
  if (now?.kind === "recorded" && Bun.deepEquals(now.record, first)) {
    io.print(`The record was kept. ${next}`);
    return;
  }
  const kept = now?.kind === "recorded" ? now.record.flags : [];
  const lost = plan.restore.filter((name) => !kept.includes(name));
  io.print(
    `The record was replaced by a new stop-all or is gone. ${lost.length > 0 ? `Turn these on by hand in factory_config ${when}, when they should be on: ${lost.map(displayName).join(", ")}. ` : ""}${next}`,
  );
}

/**
 * 戻す途中で全停止を見つけたら、設定を読み直し、`true`の`*_enabled`をすべて`false`にして書く。
 * 全停止と同じ規則で止め直すので、書き込みと並行してほかの処理が有効にした名前も止まる。
 * 戻した名前だけを戻すと、その間に有効になった機能が、全停止の間も動き続けるためである。
 * 記録には触らない。記録に無い名前を止めたときは、手で戻すよう名前を出す。
 * 設定のキーは信頼できない入力なので、端末に出す名前は`displayName`を通す。
 */
async function stopAgain(
  cause: Exclude<StopAllCheck, "clear">,
  mode: "during" | "after_clear",
  first: StopAllRecord,
  plan: RestorePlan,
  except: readonly string[],
  io: RestoreIo,
): Promise<void> {
  const { head, when } = stopAgainWords(cause, except);
  const read = await io.readConfig();
  if (!read.ok || !isRecord(read.value)) {
    io.print(
      `${head} factory_config could not be read again${read.ok ? "" : ` (${oneLine(read.reason)})`}. Turn every *_enabled setting off in factory_config by hand.`,
    );
    await reportRecord(cause, mode, first, plan, except, io);
    return;
  }
  if (holdsInlineFile(read.value)) {
    io.print(
      `${head} ${INLINE_REFUSAL} Turn every *_enabled setting off in factory_config by hand.`,
    );
    await reportRecord(cause, mode, first, plan, except, io);
    return;
  }
  const flags = enabledFlags(read.value);
  if (flags.length === 0) {
    io.print(`${head} Every *_enabled setting is already off.`);
    await reportRecord(cause, mode, first, plan, except, io);
    return;
  }
  const off: Record<string, unknown> = { ...read.value };
  for (const flag of flags) off[flag] = false;
  const undone = await io.writeConfig(off);
  const shown = flags.map(displayName).join(", ");
  io.print(
    undone.ok
      ? `${head} Turned ${shown} off again.`
      : `${head} The settings could not be turned off again (${oneLine(undone.reason)}). Turn ${shown} off in factory_config by hand.`,
  );
  const unrecorded = flags.filter((flag) => !first.flags.includes(flag));
  if (undone.ok && unrecorded.length > 0) {
    io.print(
      `These settings were on but not in the record, so turn them on by hand ${when}, when they should be on: ${unrecorded.map(displayName).join(", ")}.`,
    );
  }
  await reportRecord(cause, mode, first, plan, except, io);
}

/** 最初に読んだ記録と、今の記録が同じか。 */
async function recordUnchanged(
  first: StopAllRecord,
  io: RestoreIo,
): Promise<boolean> {
  const again = await io.readRecord();
  const now = again.ok ? parseStopAllRecord(again.value) : null;
  return now?.kind === "recorded" && Bun.deepEquals(now.record, first);
}

const RECORD_CHANGED =
  "The record of the stop-all changed while restoring, so a new stop-all may have recorded other names.";

/** 設定を書き、書けたことと全停止が無いことを確かめる。確かめられたときだけ真を返す。 */
async function writeAndCheck(
  plan: RestorePlan,
  original: Record<string, unknown>,
  first: StopAllRecord,
  except: readonly string[],
  io: RestoreIo,
): Promise<boolean> {
  const again = await io.readConfig();
  if (!again.ok) {
    io.print(
      `could not read factory_config again: ${oneLine(again.reason)}. Nothing was changed.`,
    );
    return false;
  }
  if (!Bun.deepEquals(again.value, original)) {
    io.print(
      "factory_config changed after it was read. Nothing was written; run mise run stop:restore again.",
    );
    return false;
  }
  if (!(await recordUnchanged(first, io))) {
    io.print(
      `${RECORD_CHANGED} Nothing was written; run mise run stop:restore again when no stop-all is placed.`,
    );
    return false;
  }
  if (holdsInlineFile(plan.next)) {
    io.print(`${INLINE_REFUSAL} Nothing was written.`);
    return false;
  }
  const written = await io.writeConfig(plan.next);
  // 書き込みが時間切れで失敗しても、値は書かれていることがあるので、全停止を確かめる。
  const stopAll = await checkStopAll(io);
  if (stopAll !== "clear") {
    await stopAgain(stopAll, "during", first, plan, except, io);
    return false;
  }
  if (!written.ok) {
    io.print(
      `could not write factory_config: ${oneLine(written.reason)}. Check factory_config; the record was kept.`,
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

const PLACED_AFTER_CLEAR =
  "WARNING: a stop-all was placed while the record was being cleared, so the record of that stop-all may be gone. After the stop-all is released, check the *_enabled settings that are false in factory_config and turn on by hand the ones that should be on.";
const UNREADABLE_AFTER_CLEAR =
  "WARNING: the stop-all variable could not be read right after the record was cleared, so the settings were not turned off again. If a stop-all was placed at that moment, its record may be gone. After confirming in Windmill that no stop-all is placed, check the *_enabled settings that are false in factory_config and turn on by hand the ones that should be on.";

/**
 * 記録を消す。最初に読んだ記録と今の記録が同じで、全停止が空のときだけ消す。
 * 戻している間に新しい全停止が記録を置き換えていたら、その記録を残す。消すと、新しい全停止が止めた名前を戻せなくなるためである。
 * Windmillの変数には条件つきの更新が無いので、確かめてから消すまでの間に置かれた全停止は止められない。
 * 消した後に全停止を読み直す。消す書き込みが失敗と返っても、値は書かれていることがあるので、必ず読み直す。
 * 置かれていれば警告して止め直す。この場合に消えうるのは記録だけで、設定は全停止が`false`にする。
 * 読めなければ警告だけにする。記録はもう無いので、止め直すと、成功した戻しがすべて手作業になるためである。
 */
async function clearRecordIfUnchanged(
  first: StopAllRecord,
  plan: RestorePlan,
  except: readonly string[],
  io: RestoreIo,
): Promise<number> {
  if (!(await recordUnchanged(first, io))) {
    io.print(
      `${RECORD_CHANGED} The record was kept; run mise run stop:restore again when no stop-all is placed.`,
    );
    return 1;
  }
  const before = await checkStopAll(io);
  if (before !== "clear") {
    if (plan.restore.length > 0) {
      await stopAgain(before, "during", first, plan, except, io);
    } else {
      const { head, next } = stopAgainWords(before, except);
      io.print(`${head} Nothing was changed. ${next}`);
    }
    return 1;
  }
  const cleared = await io.clearRecord();
  const after = await checkStopAll(io);
  if (after === "placed") {
    io.warn(PLACED_AFTER_CLEAR);
    if (plan.restore.length > 0) {
      await stopAgain(after, "after_clear", first, plan, except, io);
    }
    return 1;
  }
  if (after === "unreadable") {
    // 消す書き込みが失敗と返ったときは、記録が残っていることもあるので、その理由を添える。
    io.warn(
      cleared.ok
        ? UNREADABLE_AFTER_CLEAR
        : `${UNREADABLE_AFTER_CLEAR} Clearing the record also failed (${oneLine(cleared.reason)}), so the record may remain.`,
    );
    return 1;
  }
  if (!cleared.ok) {
    io.print(
      `could not clear the record of the stop-all: ${oneLine(cleared.reason)}. The settings listed under 'Will turn on' are on; run mise run stop:restore${exceptOption(except)} again with the same --except to clear the record.`,
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
      `could not read the stop-all variable: ${oneLine(stopAll.reason)}. Nothing was changed.`,
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
      `could not read the record of the stop-all (it may not exist yet): ${oneLine(recordRead.reason)}. Nothing was changed.`,
    );
    return 1;
  }
  const record = parseStopAllRecord(recordRead.value);
  if (record.kind === "corrupt" || record.kind === "unreadable") {
    io.print(
      `the record of the stop-all is corrupt: ${oneLine(record.reason)}. Nothing was changed; turn the settings on by hand in factory_config.`,
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
      `could not read factory_config: ${oneLine(read.reason)}. Nothing was changed.`,
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
      `factory_config does not pass the config check (config_invalid): ${oneLine(err instanceof Error ? err.message : String(err))}. Nothing was changed; fix it first.`,
    );
    return 1;
  }
  const plan = planRestore({
    config: original,
    recorded: record.record.flags,
    except,
    now: io.now(),
  });
  printPlan(plan, record.record, io.print);
  if (!(await io.confirm(confirmationOf(plan)))) {
    io.print("not confirmed; nothing was changed");
    return 1;
  }
  if (
    plan.restore.length > 0 &&
    !(await writeAndCheck(plan, original, record.record, except, io))
  ) {
    return 1;
  }
  return await clearRecordIfUnchanged(record.record, plan, except, io);
}
