// 設定の項目を、止める向きか下げる向きに変える操作の判定と、確認の文。
// 変えられる項目と範囲は、backendの設定変更のscriptが持つ許可表(`BOOLEAN_STOP_ITEMS`、`LOWERABLE_NUMBERS`)と同じで、
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

/** 画面が出す変更の候補。止める操作か、数値を下げる操作。 */
export type ChangeOffer =
  | { readonly kind: "stop"; readonly key: string }
  | {
      readonly kind: "lower";
      readonly key: string;
      readonly current: number;
      readonly rule: NumberRule;
    };

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

/**
 * 確認のダイアログに並べる文。効く時期と、元に戻す方法を書く。
 * Consoleは止める向きと下げる向きの変更だけを持つので、戻すには人がWindmillで編集する。
 */
export function changeDialogLines(offer: ChangeOffer): readonly string[] {
  return [
    offer.kind === "stop"
      ? "止めると、この機能は新しく動かなくなります。すでに動いている作業は、自動では止まりません。"
      : "下げた値は、いまの値より厳しい上限になります。",
    "変更は、次に設定を読む処理から効きます。",
    "元に戻すには、人がWindmillで編集します。Consoleからは戻せません。",
  ];
}
