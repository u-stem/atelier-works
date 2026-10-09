import { describe, expect, test } from "bun:test";
import {
  APPROVAL_PARAM,
  parseApprovalParam,
  withApprovalParam,
} from "./inboxSelection.ts";

describe("parseApprovalParam", () => {
  test("reads a positive integer", () => {
    expect(parseApprovalParam(new URLSearchParams("approval=42"))).toBe(42);
  });

  test("returns null when the parameter is absent", () => {
    expect(parseApprovalParam(new URLSearchParams(""))).toBeNull();
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
  ])("returns null for %s", (_name, value) => {
    expect(
      parseApprovalParam(new URLSearchParams({ [APPROVAL_PARAM]: value })),
    ).toBeNull();
  });

  test("uses the first value when repeated", () => {
    expect(
      parseApprovalParam(new URLSearchParams("approval=1&approval=2")),
    ).toBe(1);
  });
});

describe("withApprovalParam", () => {
  test("sets the selected id", () => {
    expect(withApprovalParam(new URLSearchParams(""), 9).toString()).toBe(
      "approval=9",
    );
  });

  test("replaces the previous id and keeps other parameters", () => {
    expect(
      withApprovalParam(
        new URLSearchParams("kind=requirements&approval=1"),
        9,
      ).toString(),
    ).toBe("kind=requirements&approval=9");
  });

  test("removes the parameter when nothing is selected", () => {
    expect(
      withApprovalParam(new URLSearchParams("approval=1"), null).toString(),
    ).toBe("");
  });

  test("does not mutate its input", () => {
    const input = new URLSearchParams("approval=1");
    withApprovalParam(input, 2);
    expect(input.toString()).toBe("approval=1");
  });
});
