import { describe, expect, test } from "bun:test";
import {
  INBOX_KINDS,
  type InboxSelection,
  parseSelection,
  withSelection,
} from "./inboxSelection.ts";

function parse(query: string): InboxSelection | null {
  return parseSelection(new URLSearchParams(query));
}

describe("parseSelection", () => {
  test("reads an approval", () => {
    expect(parse("approval=42")).toEqual({ type: "approval", id: 42 });
  });

  test("reads a failure", () => {
    expect(parse("failure=7")).toEqual({ type: "failure", id: 7 });
  });

  test("reads a notice", () => {
    expect(parse("notice=9")).toEqual({ type: "notice", id: 9 });
  });

  test("returns null when nothing is selected", () => {
    expect(parse("")).toBeNull();
  });

  test("ignores unrelated parameters", () => {
    expect(parse("x=1&approval=3")).toEqual({ type: "approval", id: 3 });
  });

  test("ignores the selection when two kinds are present", () => {
    expect(parse("approval=1&failure=2")).toBeNull();
  });

  test("ignores the selection when all three kinds are present", () => {
    expect(parse("approval=1&failure=2&notice=3")).toBeNull();
  });

  test("ignores two kinds even when one value is invalid", () => {
    expect(parse("approval=1&notice=abc")).toBeNull();
  });

  test.each([
    ["zero", "0"],
    ["negative", "-3"],
    ["decimal", "1.5"],
    ["leading zero", "07"],
    ["text", "abc"],
    ["empty", ""],
    ["exponent", "1e3"],
    ["sign", "+3"],
    ["unsafe integer", "99999999999999999999"],
    ["padded", " 3"],
  ])("returns null for an approval of %s", (_name, value) => {
    expect(parseSelection(new URLSearchParams({ approval: value }))).toBeNull();
  });

  test("uses the first value when a key is repeated", () => {
    expect(parse("approval=1&approval=2")).toEqual({ type: "approval", id: 1 });
  });
});

describe("withSelection", () => {
  test("sets the selected id", () => {
    expect(
      withSelection(new URLSearchParams(""), {
        type: "failure",
        id: 9,
      }).toString(),
    ).toBe("failure=9");
  });

  test("replaces another kind and keeps other parameters", () => {
    expect(
      withSelection(new URLSearchParams("x=1&approval=1"), {
        type: "notice",
        id: 4,
      }).toString(),
    ).toBe("x=1&notice=4");
  });

  test("replaces the previous id of the same kind", () => {
    expect(
      withSelection(new URLSearchParams("approval=1"), {
        type: "approval",
        id: 9,
      }).toString(),
    ).toBe("approval=9");
  });

  test("removes every selection key when nothing is selected", () => {
    expect(
      withSelection(
        new URLSearchParams("approval=1&failure=2&notice=3&x=1"),
        null,
      ).toString(),
    ).toBe("x=1");
  });

  test("does not mutate its input", () => {
    const input = new URLSearchParams("approval=1");
    withSelection(input, { type: "approval", id: 2 });
    expect(input.toString()).toBe("approval=1");
  });
});

describe("INBOX_KINDS", () => {
  test("lists approval, failure and notice", () => {
    expect([...INBOX_KINDS]).toEqual(["approval", "failure", "notice"]);
  });
});
