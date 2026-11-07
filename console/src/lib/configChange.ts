// 設定の項目を、止める向きか下げる向きに変える操作と、一覧の要素の追加と削除の判定と、確認の文。
// 変えられる項目と範囲は、backendの設定変更のscriptが持つ許可表(`BOOLEAN_STOP_ITEMS`、`LOWERABLE_NUMBERS`、`LIST_ITEMS`)と同じで、
// 設定変更のscriptの契約テストが突き合わせる。
// 画面が出す操作の絞り込みで、権限の境界ではない。境界はscriptが同じ表で確かめる。

import type { ConfigItemView } from "../api/jobsQueries.ts";

/** `true`から`false`へだけ変えられる真偽の項目。 */
export const STOPPABLE_SWITCHES: readonly string[] = [
  "implement_enabled",
  "dependabot_enabled",
  "dependabot_merge_enabled",
  "pr_ci_fix_enabled",
  "pr_conflict_fix_enabled",
];

/** 数値の項目の規則。`minimumExclusive`なら下限を含まない。 */
export type NumberRule = {
  readonly integer: boolean;
  readonly minimum: number;
  readonly minimumExclusive: boolean;
};

/** いまの値より小さい値へだけ変えられる数値の項目。 */
export const LOWERABLE_NUMBERS: Readonly<Record<string, NumberRule>> = {
  daily_budget_usd: { integer: false, minimum: 0, minimumExclusive: true },
  max_budget_usd_per_run: {
    integer: false,
    minimum: 0,
    minimumExclusive: true,
  },
  max_fix_rounds: { integer: true, minimum: 1, minimumExclusive: false },
  implement_max_changed_files: {
    integer: true,
    minimum: 1,
    minimumExclusive: false,
  },
  max_fix_diff_lines: { integer: true, minimum: 1, minimumExclusive: false },
};

/** 1要素の追加と削除ができる文字列の一覧の項目。 */
export const EDITABLE_LISTS: readonly string[] = [
  "repo_allowlist",
  "dependabot_other_repos",
  "default_reviewers",
];

/**
 * 一覧に足せる要素の長さの上限。操作の記録が文字列の値を100字までに限るためである。
 * 形式の細かい検査は、画面では持たず、scriptの断りの文で伝える。
 */
export const MAX_ELEMENT_LENGTH = 100;

/**
 * リポジトリの許可の一覧。空にすると`owners`配下のすべてのリポジトリが対象になるので、最後の1件を削除できない。
 * 追加は、検査コマンドが及ぶ範囲も広げる。
 */
const ALLOWLIST_ITEM = "repo_allowlist";

/** `repo_allowlist`の最後の1件を削除できない理由。行の案内と、削除を断る通知が同じ文を使う。 */
export const LAST_ELEMENT_NOTE =
  "最後の1件は削除できません。空だと owners 配下の全リポジトリが対象になります。";

/** 画面が出す変更の候補。止める操作、数値を下げる操作、一覧の要素の追加と削除。 */
export type ChangeOffer =
  | { readonly kind: "stop"; readonly key: string }
  | {
      readonly kind: "lower";
      readonly key: string;
      readonly current: number;
      readonly rule: NumberRule;
    }
  | {
      readonly kind: "add";
      readonly key: string;
      /** 画面が読んだ一覧。 */
      readonly current: readonly string[];
    }
  | {
      readonly kind: "remove";
      readonly key: string;
      /** 画面が読んだ一覧。 */
      readonly current: readonly string[];
      /** 除く要素の位置。同じ文字列の要素を見分ける。 */
      readonly index: number;
      readonly element: string;
    };

export type NewElementProblem = "empty" | "too_long";

export type NewElement =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: NewElementProblem };

/**
 * 入力欄の文字列を、一覧に足す要素として読む。前後の空白は除く。
 * 空と、長さの上限を超えるものだけを断る。形式の検査はscriptが行い、断りの文で伝える。
 */
export function parseNewElement(text: string): NewElement {
  const value = text.trim();
  if (value === "") return { ok: false, reason: "empty" };
  if (value.length > MAX_ELEMENT_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true, value };
}

const NEW_ELEMENT_MESSAGES: Readonly<Record<NewElementProblem, string>> = {
  empty: "追加する要素を入力してください。",
  too_long: `要素は${String(MAX_ELEMENT_LENGTH)}字までです。`,
};

/** 入力の問題を伝える文。 */
export function newElementMessage(reason: NewElementProblem): string {
  return NEW_ELEMENT_MESSAGES[reason];
}

/** 検査コマンドの項目。リポジトリを足すと、その修正の検証にも及ぶ。 */
const CHECK_COMMANDS_ITEM = "allowed_check_commands";

/** リポジトリ別の検査コマンドの項目。キーが追加したリポジトリと同じ名前なら、その検査コマンドが実装の検証でも走る。 */
const CHECK_COMMANDS_BY_REPO_ITEM = "check_commands_by_repo";

/** 検査コマンドの件数。参照と伏せた値は、件数を読めない。 */
export type CommandCount =
  | { readonly kind: "count"; readonly count: number }
  | { readonly kind: "unknown" };

/**
 * `repo_allowlist`への追加が及ぼす、検査コマンドの設定。
 * `allowed`は`allowed_check_commands`の件数、`byRepo`は`check_commands_by_repo`で検査コマンドを持つリポジトリの数である。
 */
export type CheckCommands = {
  readonly allowed: CommandCount;
  readonly byRepo: CommandCount;
};

/** 検査コマンドの設定が無い状態。 */
export const NO_CHECK_COMMANDS: CheckCommands = {
  allowed: { kind: "count", count: 0 },
  byRepo: { kind: "count", count: 0 },
};

const UNKNOWN_COUNT: CommandCount = { kind: "unknown" };

/** `allowed_check_commands`の件数。項目が無いときは、設定を読む処理の既定の空として、0件と見なす。 */
function allowedCount(item: ConfigItemView | undefined): CommandCount {
  if (item === undefined) return { kind: "count", count: 0 };
  if (item.kind !== "value" || item.masked || !isStringArray(item.value)) {
    return UNKNOWN_COUNT;
  }
  return { kind: "count", count: item.value.length };
}

/**
 * `check_commands_by_repo`で、検査コマンドを持つリポジトリの数。空の配列のエントリは、実行するコマンドが無いので数えない。
 * キーの正規化は設定を読む処理が行うので、画面では追加するリポジトリとの一致を判定しない。
 */
function byRepoCount(item: ConfigItemView | undefined): CommandCount {
  if (item === undefined) return { kind: "count", count: 0 };
  if (item.kind !== "value" || item.masked) return UNKNOWN_COUNT;
  const value = item.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return UNKNOWN_COUNT;
  }
  let count = 0;
  for (const commands of Object.values(value)) {
    if (!isStringArray(commands)) return UNKNOWN_COUNT;
    if (commands.length > 0) count += 1;
  }
  return { kind: "count", count };
}

/**
 * 設定の項目の一覧から、検査コマンドの設定を読む。
 * 項目が無いときは、設定を読む処理の既定の空として、0件と見なす。
 */
export function checkCommandsOf(
  items: readonly ConfigItemView[],
): CheckCommands {
  return {
    allowed: allowedCount(
      items.find((entry) => entry.key === CHECK_COMMANDS_ITEM),
    ),
    byRepo: byRepoCount(
      items.find((entry) => entry.key === CHECK_COMMANDS_BY_REPO_ITEM),
    ),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** 参照を含む要素。値を解決しないので、含む一覧は変更しない。 */
function holdsReference(entries: readonly string[]): boolean {
  return entries.some(
    (entry) => entry.includes("$var:") || entry.includes("$res:"),
  );
}

function ownRule(key: string): NumberRule | undefined {
  return Object.hasOwn(LOWERABLE_NUMBERS, key)
    ? LOWERABLE_NUMBERS[key]
    : undefined;
}

function fits(value: number, rule: NumberRule): boolean {
  if (rule.integer && !Number.isInteger(value)) return false;
  return rule.minimumExclusive ? value > rule.minimum : value >= rule.minimum;
}

/**
 * 設定の1項目に出す変更の候補。出さないときは`null`。
 * 真偽の項目は、いま`true`のときだけ止められる。数値の項目は、いまの値が範囲に合い、下げる余地があるときだけ下げられる。
 * 参照と、伏せた値は、値を読めないので出さない。
 */
export function changeOfferOf(item: ConfigItemView): ChangeOffer | null {
  if (item.kind !== "value" || item.masked) return null;
  if (STOPPABLE_SWITCHES.includes(item.key)) {
    return item.value === true ? { kind: "stop", key: item.key } : null;
  }
  const rule = ownRule(item.key);
  const current = item.value;
  if (
    rule === undefined ||
    typeof current !== "number" ||
    !Number.isFinite(current) ||
    !fits(current, rule)
  ) {
    return null;
  }
  // 整数の項目は、1つ下の整数が範囲に残るときだけ下げられる。小数の項目は、0に近づける余地が常にある。
  if (rule.integer && !fits(current - 1, rule)) return null;
  return { kind: "lower", key: item.key, current, rule };
}

/**
 * 一覧の項目に出す候補。要素ごとの削除と、一覧ごとの追加である。
 * 伏せた値、参照、文字列でない要素、参照を含む要素の一覧には出さない。
 * `repo_allowlist`の最後の1件は、空にすると`owners`配下の全リポジトリが対象になるので、削除を出さない。
 */
function listOffersOf(item: ConfigItemView): readonly ChangeOffer[] {
  if (item.kind !== "value" || item.masked) return [];
  const current = item.value;
  if (!isStringArray(current) || holdsReference(current)) return [];
  const removable = !(item.key === ALLOWLIST_ITEM && current.length === 1);
  const removals: ChangeOffer[] = removable
    ? current.map((element, index) => ({
        kind: "remove",
        key: item.key,
        current,
        index,
        element,
      }))
    : [];
  return [...removals, { kind: "add", key: item.key, current }];
}

/**
 * 設定の1項目に出す変更の候補の全部。出さないときは空。
 * 一覧の項目は、要素ごとの削除と一覧ごとの追加を返す。それ以外の項目は、`changeOfferOf`の1つである。
 */
export function changeOffersOf(item: ConfigItemView): readonly ChangeOffer[] {
  if (EDITABLE_LISTS.includes(item.key)) return listOffersOf(item);
  const offer = changeOfferOf(item);
  return offer === null ? [] : [offer];
}

export type NewNumberProblem =
  | "empty"
  | "not_a_number"
  | "not_integer"
  | "too_small"
  | "not_lower";

export type NewNumber =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: NewNumberProblem };

const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;

/**
 * 入力欄の文字列を、新しい値として読む。空白は無視する。
 * 符号、指数、16進、全角の数字は受けない。値は、範囲に合い、いまの値より小さいものに限る。
 */
export function parseNewNumber(
  text: string,
  offer: Extract<ChangeOffer, { kind: "lower" }>,
): NewNumber {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (!PLAIN_NUMBER.test(trimmed)) {
    return { ok: false, reason: "not_a_number" };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, reason: "not_a_number" };
  if (offer.rule.integer && !Number.isInteger(value)) {
    return { ok: false, reason: "not_integer" };
  }
  if (!fits(value, offer.rule)) return { ok: false, reason: "too_small" };
  if (value >= offer.current) return { ok: false, reason: "not_lower" };
  return { ok: true, value };
}

const NEW_VALUE_MESSAGES: Readonly<Record<NewNumberProblem, string>> = {
  empty: "変更後の値を入力してください。",
  not_a_number: "数字で入力してください。",
  not_integer: "整数で入力してください。",
  too_small: "この項目の下限より小さい値です。",
  not_lower: "現在の値より小さい値を入力してください。",
};

/** 入力の問題を伝える文。 */
export function newValueMessage(reason: NewNumberProblem): string {
  return NEW_VALUE_MESSAGES[reason];
}

const TAKES_EFFECT =
  "変更は、次に設定を読む処理から効きます。動いているフローも、以後の手順が設定を読むときから、新しい値で動きます。";

function allowedCommandsLine(count: CommandCount): string | null {
  if (count.kind === "unknown") {
    return "件数を読めません。検査コマンドが新しいリポジトリでも実行されます。";
  }
  return count.count === 0
    ? null
    : `検査コマンドが ${String(count.count)} 件あり、新しいリポジトリの修正の検証でも、隔離なしで実行されます。`;
}

function byRepoCommandsLine(count: CommandCount): string | null {
  if (count.kind === "unknown") {
    return "リポジトリ別の検査コマンドの数を読めません。追加したリポジトリが同じ名前なら、その検査コマンドがあれば隔離なしで実行されます。";
  }
  return count.count === 0
    ? null
    : `リポジトリ別の検査コマンドが ${String(count.count)} リポジトリ分あり、追加したリポジトリが同じ名前なら、その検査コマンドも隔離なしで実行されます。`;
}

/**
 * 一覧の追加と削除の確認に並べる文。逆の操作で元に戻せるので、Windmillで直す手順は書かない。
 * 空の`repo_allowlist`への追加は、挙げたリポジトリだけが対象になる。空のときは`owners`配下のすべてが対象だったためである。
 */
function listDialogLines(
  offer: Extract<ChangeOffer, { kind: "add" | "remove" }>,
  checkCommands: CheckCommands,
): readonly string[] {
  const adding = offer.kind === "add";
  const lines = [
    adding
      ? "追加した要素は、この項目の対象に加わります。"
      : "削除した要素は、この項目の対象から外れます。",
    TAKES_EFFECT,
  ];
  if (adding && offer.key === ALLOWLIST_ITEM) {
    if (offer.current.length === 0) {
      lines.push(
        "owners 配下の、ここに挙げたリポジトリだけが対象になります。挙げていない他のリポジトリは対象から外れます。",
      );
    }
    for (const line of [
      allowedCommandsLine(checkCommands.allowed),
      byRepoCommandsLine(checkCommands.byRepo),
    ]) {
      if (line !== null) lines.push(line);
    }
  }
  lines.push(
    adding
      ? "元に戻すには、同じ値を削除します。"
      : "元に戻すには、同じ値を追加します。",
  );
  return lines;
}

/** 止めている間の承認が、承認済みで止まる項目。 */
const APPROVAL_STOPPING_SWITCH = "implement_enabled";

/** 日次の予算の項目。下げた値が今日の使用額を下回ると、今日のClaudeを使うフローが止まる。 */
const DAILY_BUDGET_ITEM = "daily_budget_usd";

/**
 * 確認のダイアログに並べる文。効く範囲と、項目ごとの注意と、元に戻す方法を書く。
 * 変更は、次に設定を読む処理から効く。動いているフローも、以後の手順が設定を読めば、新しい値で動く。
 * 実装を止めている間の承認は、承認済みで止まり、要対応に載らない。再開は、有効に戻した後に人が再実行で行う。
 * 日次の予算は、今日の使用額を下回る値にすると、今日のClaudeを使うフローがすべて失敗する。今日の使用額は、ここでは調べない。
 * 止める向きと下げる向きの変更は、Consoleからは戻せないので、戻すには運用者がWindmillで直す。
 * 一覧の追加と削除は、逆の操作で戻せる。
 * `checkCommands`は、`repo_allowlist`への追加が、検査コマンドの及ぶ範囲を広げることを伝えるために使う。
 * リポジトリ別の検査コマンドは、追加した要素との一致を判定せず、あれば一般の警告にする。
 */
export function changeDialogLines(
  offer: ChangeOffer,
  checkCommands: CheckCommands = NO_CHECK_COMMANDS,
): readonly string[] {
  if (offer.kind === "add" || offer.kind === "remove") {
    return listDialogLines(offer, checkCommands);
  }
  const lines = [
    offer.kind === "stop"
      ? "止めると、この機能は新しく動かなくなります。"
      : "下げた値は、いまの値より厳しい上限になります。",
    TAKES_EFFECT,
  ];
  if (offer.key === APPROVAL_STOPPING_SWITCH) {
    lines.push(
      "止めている間に承認した要件定義は、承認済みで止まります。要対応には載りません。有効に戻した後、人が再実行で再開します。",
    );
  }
  if (offer.key === DAILY_BUDGET_ITEM) {
    lines.push(
      "今日の使用額を下回る値にすると、今日のClaudeを使うフローがすべて失敗します。引き上げはConsoleではできません。",
    );
  }
  lines.push(
    "元に戻すには、運用者がWindmillでリソースを編集するか、wmill resource pushで戻します。Consoleからは戻せません。",
  );
  return lines;
}
