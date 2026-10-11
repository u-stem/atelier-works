import { describe, expect, test } from "bun:test";
import { themeOptionClass } from "./ThemeSwitch.tsx";

describe("themeOptionClass", () => {
  test.each(["border-primary", "bg-selected", "text-selected-foreground"])(
    "gives the pressed option %s",
    (token) => {
      expect(themeOptionClass(true).split(" ")).toContain(token);
    },
  );

  test("keeps the border of the unpressed option transparent", () => {
    expect(themeOptionClass(false).split(" ")).toContain("border-transparent");
  });

  test("does not give the unpressed option the selected border", () => {
    expect(themeOptionClass(false).split(" ")).not.toContain("border-primary");
  });

  test("moves the focus ring off the border", () => {
    expect(themeOptionClass(false).split(" ")).toContain(
      "focus-visible:ring-offset-1",
    );
  });
});
