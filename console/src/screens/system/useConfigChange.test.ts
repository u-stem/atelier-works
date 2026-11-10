import { describe, expect, test } from "bun:test";
import {
  type ChangeOffer,
  changeOfferOf,
  changeOffersOf,
} from "../../lib/configChange.ts";
import { changeInputOf, routeConfigOutcome } from "./useConfigChange.ts";

function offerFor(key: string, value: unknown): ChangeOffer {
  const offer = changeOfferOf({ key, kind: "value", value, masked: false });
  if (offer === null) throw new Error(`no offer for ${key}`);
  return offer;
}

describe("changeInputOf", () => {
  test("turns a switch from true to false, whatever was typed", () => {
    expect(changeInputOf(offerFor("implement_enabled", true), "x")).toEqual({
      item: "implement_enabled",
      expected: true,
      next: false,
    });
  });

  test("keeps the value that was read as the expected value of a number", () => {
    expect(changeInputOf(offerFor("daily_budget_usd", 50), "20")).toEqual({
      item: "daily_budget_usd",
      expected: 50,
      next: 20,
    });
  });

  test("reads a fraction for a budget", () => {
    expect(changeInputOf(offerFor("daily_budget_usd", 50), "0.5")).toEqual({
      item: "daily_budget_usd",
      expected: 50,
      next: 0.5,
    });
  });

  test("gives nothing while the box is empty", () => {
    expect(changeInputOf(offerFor("daily_budget_usd", 50), "")).toBeNull();
  });

  test("gives nothing for a value that is not lower", () => {
    expect(changeInputOf(offerFor("daily_budget_usd", 50), "60")).toBeNull();
  });

  test("gives nothing for a fraction of an integer item", () => {
    expect(changeInputOf(offerFor("max_fix_rounds", 3), "1.5")).toBeNull();
  });
});

describe("routeConfigOutcome", () => {
  const INPUT = { item: "daily_budget_usd", expected: 50, next: 20 };
  const LOWERED = {
    refused: false,
    item: "daily_budget_usd",
    before: 50,
    after: 20,
    verified: true,
    action_audit: "recorded",
  } as const;

  function route(outcome: Parameters<typeof routeConfigOutcome>[0]) {
    const announced: unknown[] = [];
    const pinned: unknown[] = [];
    routeConfigOutcome(outcome, INPUT, {
      announce: (notice) => {
        announced.push(notice);
      },
      pin: (item, notice) => {
        pinned.push({ item, notice });
      },
    });
    return { announced, pinned };
  }

  test("lets a success go by itself as a toast", () => {
    expect(route({ kind: "done", result: LOWERED }).announced).toHaveLength(1);
  });

  test("pins nothing for a success", () => {
    expect(route({ kind: "done", result: LOWERED }).pinned).toEqual([]);
  });

  test("pins a refusal with the item that was changed", () => {
    const { pinned } = route({
      kind: "done",
      result: { refused: true, reason: "has_reference" },
    });
    expect(pinned).toMatchObject([
      { item: "daily_budget_usd", notice: { tone: "info" } },
    ]);
  });

  test("announces no toast for a refusal", () => {
    expect(
      route({ kind: "done", result: { refused: true, reason: "conflict" } })
        .announced,
    ).toEqual([]);
  });

  test("pins a write that could not be read back", () => {
    expect(
      route({ kind: "done", result: { ...LOWERED, verified: false } }).pinned,
    ).toHaveLength(1);
  });

  test("pins a failure of the write", () => {
    expect(
      route({
        kind: "failed",
        error: { kind: "network" },
        message: "サーバーに接続できませんでした。",
      }).pinned,
    ).toMatchObject([{ notice: { tone: "error" } }]);
  });
});

describe("changeInputOf for a list", () => {
  const LIST = ["alice", "bob", "carol"];

  function offersFor(key: string, value: unknown): readonly ChangeOffer[] {
    return changeOffersOf({ key, kind: "value", value, masked: false });
  }

  function offerOf(kind: "add" | "remove", index = 0): ChangeOffer {
    const offers = offersFor("default_reviewers", LIST).filter(
      (offer) => offer.kind === kind,
    );
    const offer = offers[index];
    if (offer === undefined) throw new Error(`no ${kind} offer`);
    return offer;
  }

  test("puts a typed element at the end of the list that was read", () => {
    expect(changeInputOf(offerOf("add"), "dave")).toEqual({
      item: "default_reviewers",
      expected: LIST,
      next: [...LIST, "dave"],
    });
  });

  test("trims the whitespace around a typed element", () => {
    expect(changeInputOf(offerOf("add"), "  dave\n")).toEqual({
      item: "default_reviewers",
      expected: LIST,
      next: [...LIST, "dave"],
    });
  });

  test("gives nothing while the box is empty", () => {
    expect(changeInputOf(offerOf("add"), " ")).toBeNull();
  });

  test("gives nothing for an element that is too long", () => {
    expect(changeInputOf(offerOf("add"), "a".repeat(101))).toBeNull();
  });

  test("takes the chosen element out of the list that was read, whatever was typed", () => {
    expect(changeInputOf(offerOf("remove", 1), "ignored")).toEqual({
      item: "default_reviewers",
      expected: LIST,
      next: ["alice", "carol"],
    });
  });

  test("takes only the chosen one out of elements that are the same", () => {
    const offers = offersFor("default_reviewers", ["alice", "alice", "bob"]);
    const second = offers[1];
    if (second === undefined) throw new Error("no second offer");
    expect(changeInputOf(second, "")).toEqual({
      item: "default_reviewers",
      expected: ["alice", "alice", "bob"],
      next: ["alice", "bob"],
    });
  });
});
