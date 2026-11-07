import { describe, expect, test } from "bun:test";
import type { ConfigItemView } from "../api/jobsQueries.ts";
import {
  type ChangeOffer,
  type CheckCommands,
  changeDialogLines,
  changeOfferOf,
  changeOffersOf,
  checkCommandsOf,
  EDITABLE_LISTS,
  LOWERABLE_NUMBERS,
  MAX_ELEMENT_LENGTH,
  NO_CHECK_COMMANDS,
  newElementMessage,
  newValueMessage,
  parseNewElement,
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
      "元に戻すには、運用者がWindmillでリソースを編集するか、wmill resource pushで戻します",
    );
  });

  test("says the same for a number", () => {
    const offer = changeOfferOf(value("daily_budget_usd", 50));
    expect(offer === null ? [] : changeDialogLines(offer).join("\n")).toContain(
      "元に戻すには、運用者がWindmillでリソースを編集するか、wmill resource pushで戻します",
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

describe("changeDialogLines for what the change reaches", () => {
  function linesFor(key: string, value: unknown): string {
    const offer = changeOfferOf({ key, kind: "value", value, masked: false });
    return offer === null ? "" : changeDialogLines(offer).join("\n");
  }

  test("does not say that running work is not affected", () => {
    expect(linesFor("implement_enabled", true)).not.toContain(
      "自動では止まりません",
    );
  });

  test("says that a flow already running reads the new value in its later steps", () => {
    expect(linesFor("max_fix_diff_lines", 1500)).toContain(
      "動いているフローも、以後の手順が設定を読むときから、新しい値で動きます",
    );
  });

  test("says the same for a switch", () => {
    expect(linesFor("implement_enabled", true)).toContain(
      "動いているフローも、以後の手順が設定を読むときから、新しい値で動きます",
    );
  });

  test("warns that an approval while the implementation is stopped ends as approved", () => {
    expect(linesFor("implement_enabled", true)).toContain(
      "止めている間に承認した要件定義は、承認済みで止まります",
    );
  });

  test("says that a person resumes it by the retry after the switch is on again", () => {
    expect(linesFor("implement_enabled", true)).toContain(
      "有効に戻した後、人が再実行で再開します",
    );
  });

  test("keeps the approval warning out of the other switches", () => {
    expect(linesFor("dependabot_enabled", true)).not.toContain("承認");
  });

  test("warns that a daily limit below today's spending fails the flows that use Claude today", () => {
    expect(linesFor("daily_budget_usd", 50)).toContain(
      "今日の使用額を下回る値にすると、今日のClaudeを使うフローがすべて失敗します",
    );
  });

  test("says that the Console cannot raise it again", () => {
    expect(linesFor("daily_budget_usd", 50)).toContain(
      "引き上げはConsoleではできません",
    );
  });

  test("keeps the daily warning out of the per-run limit", () => {
    expect(linesFor("max_budget_usd_per_run", 5)).not.toContain("今日の使用額");
  });
});

const REPOS = [
  "https://github.com/octo-owner/atelier-works",
  "https://github.com/octo-owner/widgets",
  "https://github.com/octo-owner/gadgets",
];

describe("EDITABLE_LISTS", () => {
  test("is the three lists that take one element at a time", () => {
    expect([...EDITABLE_LISTS]).toEqual([
      "repo_allowlist",
      "dependabot_other_repos",
      "default_reviewers",
    ]);
  });
});

describe("changeOffersOf for a list", () => {
  test("offers to remove each element and to add one", () => {
    expect(
      changeOffersOf(value("default_reviewers", ["alice", "bob"])),
    ).toEqual([
      {
        kind: "remove",
        key: "default_reviewers",
        current: ["alice", "bob"],
        index: 0,
        element: "alice",
      },
      {
        kind: "remove",
        key: "default_reviewers",
        current: ["alice", "bob"],
        index: 1,
        element: "bob",
      },
      { kind: "add", key: "default_reviewers", current: ["alice", "bob"] },
    ]);
  });

  test("offers only to add to an empty list", () => {
    expect(changeOffersOf(value("dependabot_other_repos", []))).toEqual([
      { kind: "add", key: "dependabot_other_repos", current: [] },
    ]);
  });

  test("offers to remove the only element of a list that may become empty", () => {
    expect(
      changeOffersOf(value("default_reviewers", ["alice"])).map(
        (offer) => offer.kind,
      ),
    ).toEqual(["remove", "add"]);
  });

  test("does not offer to remove the last element of repo_allowlist", () => {
    expect(
      changeOffersOf(value("repo_allowlist", [REPOS[0]])).map(
        (offer) => offer.kind,
      ),
    ).toEqual(["add"]);
  });

  test("offers to remove an element of repo_allowlist that has others", () => {
    expect(
      changeOffersOf(value("repo_allowlist", REPOS)).map((offer) => offer.kind),
    ).toEqual(["remove", "remove", "remove", "add"]);
  });

  test("offers nothing for a list that was masked", () => {
    expect(changeOffersOf(value("default_reviewers", ["alice"], true))).toEqual(
      [],
    );
  });

  test("offers nothing for a list that is a reference", () => {
    expect(
      changeOffersOf({ key: "default_reviewers", kind: "reference" }),
    ).toEqual([]);
  });

  test("offers nothing for a list that holds a number", () => {
    expect(changeOffersOf(value("default_reviewers", ["alice", 1]))).toEqual(
      [],
    );
  });

  test("offers nothing for a value that is not a list", () => {
    expect(changeOffersOf(value("default_reviewers", "alice"))).toEqual([]);
  });

  test.each(["$var:f/factory/token", "$res:f/factory/resource"])(
    "offers nothing for a list that holds %s",
    (reference) => {
      expect(
        changeOffersOf(value("default_reviewers", ["alice", reference])),
      ).toEqual([]);
    },
  );

  test("offers nothing for a list that is not on the table", () => {
    expect(changeOffersOf(value("owners", ["alice"]))).toEqual([]);
  });
});

describe("changeOffersOf for the other items", () => {
  test("offers to stop a switch that is on", () => {
    expect(changeOffersOf(value("implement_enabled", true))).toEqual([
      { kind: "stop", key: "implement_enabled" },
    ]);
  });

  test("offers nothing for a switch that is off", () => {
    expect(changeOffersOf(value("implement_enabled", false))).toEqual([]);
  });
});

describe("changeOfferOf for a list", () => {
  test("keeps offering a single change to the items that take one", () => {
    expect(changeOfferOf(value("default_reviewers", ["alice"]))).toBeNull();
  });
});

describe("parseNewElement", () => {
  test("trims the whitespace around the element", () => {
    expect(parseNewElement("  alice \n")).toEqual({
      ok: true,
      value: "alice",
    });
  });

  test("says an empty box is empty", () => {
    expect(parseNewElement("")).toEqual({ ok: false, reason: "empty" });
  });

  test("says a box with only whitespace is empty", () => {
    expect(parseNewElement(" \t ")).toEqual({ ok: false, reason: "empty" });
  });

  test("accepts an element of the longest length", () => {
    expect(parseNewElement("a".repeat(MAX_ELEMENT_LENGTH)).ok).toBe(true);
  });

  test("refuses an element that is one character too long", () => {
    expect(parseNewElement("a".repeat(MAX_ELEMENT_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  test("measures the length after trimming", () => {
    expect(parseNewElement(` ${"a".repeat(MAX_ELEMENT_LENGTH)} `).ok).toBe(
      true,
    );
  });

  test("says in Japanese that an empty box needs an element", () => {
    expect(newElementMessage("empty")).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  test("says the limit of the length", () => {
    expect(newElementMessage("too_long")).toContain("100字");
  });
});

describe("changeDialogLines for a list", () => {
  const NO_COMMANDS = NO_CHECK_COMMANDS;

  function commandsOf(allowed: number, byRepo = 0): CheckCommands {
    return {
      allowed: { kind: "count", count: allowed },
      byRepo: { kind: "count", count: byRepo },
    };
  }

  function linesOf(
    offer: ChangeOffer,
    commands: CheckCommands = NO_COMMANDS,
  ): string {
    return changeDialogLines(offer, commands).join("\n");
  }

  function addTo(key: string, current: string[]): ChangeOffer {
    return { kind: "add", key, current };
  }

  function removeFrom(key: string, current: string[], index = 0): ChangeOffer {
    return {
      kind: "remove",
      key,
      current,
      index,
      element: current[index] ?? "",
    };
  }

  test("says when an added element takes effect", () => {
    expect(linesOf(addTo("default_reviewers", ["alice"]))).toContain(
      "変更は、次に設定を読む処理から効きます",
    );
  });

  test("says when a removed element takes effect", () => {
    expect(
      linesOf(removeFrom("default_reviewers", ["alice", "bob"])),
    ).toContain("変更は、次に設定を読む処理から効きます");
  });

  test("does not say that the Console cannot undo a removal", () => {
    expect(
      linesOf(removeFrom("default_reviewers", ["alice", "bob"])),
    ).not.toContain("Consoleからは戻せません");
  });

  test("says that adding the same value undoes a removal", () => {
    expect(
      linesOf(removeFrom("default_reviewers", ["alice", "bob"])),
    ).toContain("元に戻すには、同じ値を追加します");
  });

  test("does not say that the Console cannot undo an addition", () => {
    expect(linesOf(addTo("default_reviewers", ["alice"]))).not.toContain(
      "Consoleからは戻せません",
    );
  });

  test("says that removing the same value undoes an addition", () => {
    expect(linesOf(addTo("default_reviewers", ["alice"]))).toContain(
      "元に戻すには、同じ値を削除します",
    );
  });

  test("tells that only the listed repositories remain when repo_allowlist was empty", () => {
    expect(linesOf(addTo("repo_allowlist", []))).toContain(
      "owners 配下の、ここに挙げたリポジトリだけが対象になります。挙げていない他のリポジトリは対象から外れます",
    );
  });

  test("does not say that others leave when repo_allowlist already has elements", () => {
    expect(linesOf(addTo("repo_allowlist", [REPOS[0] ?? ""]))).not.toContain(
      "対象から外れます",
    );
  });

  test("does not say that others leave when another list was empty", () => {
    expect(linesOf(addTo("default_reviewers", []))).not.toContain(
      "対象から外れます",
    );
  });

  test("tells how many check commands also reach a new repository", () => {
    expect(
      linesOf(addTo("repo_allowlist", [REPOS[0] ?? ""]), commandsOf(2)),
    ).toContain(
      "検査コマンドが 2 件あり、新しいリポジトリの修正の検証でも、隔離なしで実行されます",
    );
  });

  test("says nothing about check commands when there are none", () => {
    expect(
      linesOf(addTo("repo_allowlist", [REPOS[0] ?? ""]), NO_COMMANDS),
    ).not.toContain("検査コマンド");
  });

  test("says that the count cannot be read when the check commands are hidden", () => {
    expect(
      linesOf(addTo("repo_allowlist", [REPOS[0] ?? ""]), {
        ...NO_COMMANDS,
        allowed: { kind: "unknown" },
      }),
    ).toContain(
      "件数を読めません。検査コマンドが新しいリポジトリでも実行されます",
    );
  });

  test("tells how many repositories have their own check commands", () => {
    expect(
      linesOf(addTo("repo_allowlist", [REPOS[0] ?? ""]), commandsOf(0, 3)),
    ).toContain(
      "リポジトリ別の検査コマンドが 3 リポジトリ分あり、追加したリポジトリが同じ名前なら、その検査コマンドも隔離なしで実行されます",
    );
  });

  test("says that the per-repository check commands cannot be counted", () => {
    expect(
      linesOf(addTo("repo_allowlist", [REPOS[0] ?? ""]), {
        ...NO_COMMANDS,
        byRepo: { kind: "unknown" },
      }),
    ).toContain(
      "リポジトリ別の検査コマンドの数を読めません。追加したリポジトリが同じ名前なら、その検査コマンドがあれば隔離なしで実行されます",
    );
  });

  test("says nothing about per-repository check commands when there are none", () => {
    expect(
      linesOf(addTo("repo_allowlist", [REPOS[0] ?? ""]), commandsOf(2, 0)),
    ).not.toContain("リポジトリ別の検査コマンド");
  });

  test("keeps the count of allowed check commands when per-repository ones exist too", () => {
    expect(
      linesOf(addTo("repo_allowlist", [REPOS[0] ?? ""]), commandsOf(2, 3)),
    ).toContain("検査コマンドが 2 件あり");
  });

  test("says nothing about check commands when another list gets an element", () => {
    expect(
      linesOf(addTo("default_reviewers", ["alice"]), commandsOf(2, 3)),
    ).not.toContain("検査コマンド");
  });

  test("says nothing about check commands when an element is removed", () => {
    expect(
      linesOf(removeFrom("repo_allowlist", REPOS), commandsOf(2, 3)),
    ).not.toContain("検査コマンド");
  });
});

describe("checkCommandsOf", () => {
  const COUNT = (count: number) => ({ kind: "count", count });

  test("counts the commands that are listed", () => {
    expect(
      checkCommandsOf([value("allowed_check_commands", ["bun test", "bun x"])])
        .allowed,
    ).toEqual(COUNT(2));
  });

  test("counts none when the item is absent", () => {
    expect(checkCommandsOf([value("daily_budget_usd", 5)]).allowed).toEqual(
      COUNT(0),
    );
  });

  test("cannot count a reference", () => {
    expect(
      checkCommandsOf([{ key: "allowed_check_commands", kind: "reference" }])
        .allowed,
    ).toEqual({ kind: "unknown" });
  });

  test("cannot count a value that was masked", () => {
    expect(
      checkCommandsOf([value("allowed_check_commands", ["bun test"], true)])
        .allowed,
    ).toEqual({ kind: "unknown" });
  });

  test("cannot count a value that is not a list", () => {
    expect(
      checkCommandsOf([value("allowed_check_commands", "bun test")]).allowed,
    ).toEqual({ kind: "unknown" });
  });

  test("counts the repositories that have check commands", () => {
    expect(
      checkCommandsOf([
        value("check_commands_by_repo", {
          "u-stem/app": ["bun test"],
          "u-stem/lib": ["bun test", "bun x"],
        }),
      ]).byRepo,
    ).toEqual(COUNT(2));
  });

  test("does not count a repository whose commands are an empty list", () => {
    expect(
      checkCommandsOf([
        value("check_commands_by_repo", {
          "u-stem/app": [],
          "u-stem/lib": ["bun test"],
        }),
      ]).byRepo,
    ).toEqual(COUNT(1));
  });

  test("counts none for an empty object of per-repository commands", () => {
    expect(
      checkCommandsOf([value("check_commands_by_repo", {})]).byRepo,
    ).toEqual(COUNT(0));
  });

  test("counts none for per-repository commands when the item is absent", () => {
    expect(checkCommandsOf([value("daily_budget_usd", 5)]).byRepo).toEqual(
      COUNT(0),
    );
  });

  test("cannot count per-repository commands that are a reference", () => {
    expect(
      checkCommandsOf([{ key: "check_commands_by_repo", kind: "reference" }])
        .byRepo,
    ).toEqual({ kind: "unknown" });
  });

  test("cannot count per-repository commands that were masked", () => {
    expect(
      checkCommandsOf([
        value("check_commands_by_repo", { "u-stem/app": ["bun test"] }, true),
      ]).byRepo,
    ).toEqual({ kind: "unknown" });
  });

  test("cannot count per-repository commands that are not an object", () => {
    expect(
      checkCommandsOf([value("check_commands_by_repo", ["bun test"])]).byRepo,
    ).toEqual({ kind: "unknown" });
  });

  test("cannot count per-repository commands when an entry is not a list of strings", () => {
    expect(
      checkCommandsOf([
        value("check_commands_by_repo", { "u-stem/app": "bun test" }),
      ]).byRepo,
    ).toEqual({ kind: "unknown" });
  });
});
