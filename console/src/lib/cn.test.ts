import { describe, expect, test } from "bun:test";
import { cn } from "./cn.ts";

describe("cn", () => {
  test("joins class names and drops falsy values", () => {
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });

  test("lets the later tailwind utility win", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
