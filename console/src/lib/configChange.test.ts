import { describe, expect, test } from "bun:test";
import type { ConfigItemView } from "../api/jobsQueries.ts";
import {
  changeDialogLines,
  changeOfferOf,
  LOWERABLE_NUMBERS,
  newValueMessage,
  parseNewNumber,
  STOPPABLE_SWITCHES,
} from "./configChange.ts";

function value(key: string, v: unknown, masked = false): ConfigItemView {
  return { key, kind: "value", value: v, masked };
}

describe("changeOfferOf", () => {
  test.each([...STOPPABLE_SWITCHES])(
    "offers to stop %s while it is on",
    (key) => {
      expect(changeOfferOf(value(key, true))).toEqual({ kind: "stop", key });
    },
  );

  test.each([...STOPPABLE_SWITCHES])(
    "offers nothing for %s while it is off",
    (key) => {
      expect(changeOfferOf(value(key, false))).toBeNull();
    },
  );

  test("offers to lower a number", () => {
    const rule = LOWERABLE_NUMBERS.daily_budget_usd;
    if (rule === undefined) throw new Error("daily_budget_usd has no rule");
    expect(changeOfferOf(value("daily_budget_usd", 50))).toEqual({
      kind: "lower",
      key: "daily_budget_usd",
      current: 50,
      rule,
    });
  });

  test("offers nothing for an integer item that is already at its smallest", () => {
    expect(changeOfferOf(value("max_fix_rounds", 1))).toBeNull();
  });

  test("offers nothing for a number that is not valid for its item", () => {
    expect(changeOfferOf(value("max_fix_rounds", 2.5))).toBeNull();
  });

  test("offers nothing for a number that is not finite", () => {
    expect(changeOfferOf(value("daily_budget_usd", Number.NaN))).toBeNull();
  });

  test("offers nothing for a string where a number is expected", () => {
    expect(changeOfferOf(value("daily_budget_usd", "50"))).toBeNull();
  });

  test("offers nothing for a number where a switch is expected", () => {
    expect(changeOfferOf(value("implement_enabled", 1))).toBeNull();
  });

  test("offers nothing for a value that was masked", () => {
    expect(changeOfferOf(value("daily_budget_usd", 50, true))).toBeNull();
  });

  test("offers nothing for a reference", () => {
    expect(
      changeOfferOf({ key: "daily_budget_usd", kind: "reference" }),
    ).toBeNull();
  });

  test.each([
    "owners",
    "repo_allowlist",
    "pr_conflict_watch_enabled",
    "retention_logs_days",
    "worker_alert_memory_ratio",
    "claude_timeout_sec",
    "constructor",
    "toString",
  ])("offers nothing for the item %s", (key) => {
    expect(changeOfferOf(value(key, true))).toBeNull();
  });
});

describe("parseNewNumber", () => {
  const BUDGET = changeOfferOf(value("daily_budget_usd", 50));
  const ROUNDS = changeOfferOf(value("max_fix_rounds", 3));

  function lower(offer: ReturnType<typeof changeOfferOf>) {
    if (offer === null || offer.kind !== "lower") {
      throw new Error("no offer to lower");
    }
    return offer;
  }

  test("reads a whole number", () => {
    expect(parseNewNumber("20", lower(BUDGET))).toEqual({
      ok: true,
      value: 20,
    });
  });

  test("reads a fraction for a budget", () => {
    expect(parseNewNumber("0.5", lower(BUDGET))).toEqual({
      ok: true,
      value: 0.5,
    });
  });

  test("ignores spaces around the number", () => {
    expect(parseNewNumber(" 20 ", lower(BUDGET))).toEqual({
      ok: true,
      value: 20,
    });
  });

  test("asks for a value when the box is empty", () => {
    expect(parseNewNumber("", lower(BUDGET))).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  test.each(["abc", "1e3", "0x10", "--5", "2,5", "５"])(
    "refuses the text %s as not a number",
    (text) => {
      expect(parseNewNumber(text, lower(BUDGET))).toEqual({
        ok: false,
        reason: "not_a_number",
      });
    },
  );

  test("refuses a fraction for an integer item", () => {
    expect(parseNewNumber("1.5", lower(ROUNDS))).toEqual({
      ok: false,
      reason: "not_integer",
    });
  });

  test("refuses zero for an integer item", () => {
    expect(parseNewNumber("0", lower(ROUNDS))).toEqual({
      ok: false,
      reason: "too_small",
    });
  });

  test("refuses zero for a budget", () => {
    expect(parseNewNumber("0", lower(BUDGET))).toEqual({
      ok: false,
      reason: "too_small",
    });
  });

  test("refuses a negative number", () => {
    expect(parseNewNumber("-1", lower(BUDGET))).toEqual({
      ok: false,
      reason: "not_a_number",
    });
  });

  test("refuses the current value", () => {
    expect(parseNewNumber("50", lower(BUDGET))).toEqual({
      ok: false,
      reason: "not_lower",
    });
  });

  test("refuses a larger value", () => {
    expect(parseNewNumber("60", lower(BUDGET))).toEqual({
      ok: false,
      reason: "not_lower",
    });
  });
});

describe("newValueMessage", () => {
  test.each([
    "empty",
    "not_a_number",
    "not_integer",
    "too_small",
    "not_lower",
  ] as const)("has a Japanese sentence for %s", (reason) => {
    expect(newValueMessage(reason)).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  test("tells that a value must be lower than the current one", () => {
    expect(newValueMessage("not_lower")).toContain("現在の値より小さい");
  });
});

describe("changeDialogLines", () => {
  test("says that a person edits it in Windmill to undo the change", () => {
    const offer = changeOfferOf(value("implement_enabled", true));
    expect(offer === null ? [] : changeDialogLines(offer).join("\n")).toContain(
      "元に戻すには、人がWindmillで編集します",
    );
  });

  test("says the same for a number", () => {
    const offer = changeOfferOf(value("daily_budget_usd", 50));
    expect(offer === null ? [] : changeDialogLines(offer).join("\n")).toContain(
      "元に戻すには、人がWindmillで編集します",
    );
  });

  test("says that the Console cannot undo it", () => {
    const offer = changeOfferOf(value("daily_budget_usd", 50));
    expect(offer === null ? [] : changeDialogLines(offer).join("\n")).toContain(
      "Consoleからは戻せません",
    );
  });

  test("says when the new value takes effect", () => {
    const offer = changeOfferOf(value("daily_budget_usd", 50));
    expect(offer === null ? [] : changeDialogLines(offer).join("\n")).toContain(
      "次に設定を読む処理から",
    );
  });
});
