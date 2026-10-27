import { describe, expect, test } from "bun:test";
import { type ChangeOffer, changeOfferOf } from "../../lib/configChange.ts";
import { changeInputOf } from "./useConfigChange.ts";

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
