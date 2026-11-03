import { describe, expect, test } from "bun:test";
import { cn } from "../../lib/cn.ts";
import { buttonVariants } from "./button.tsx";

// variantを足したら、この一覧にも足す。
const VARIANTS = [
  ["default", "text-primary-foreground"],
  ["destructive", "text-destructive-foreground"],
  ["secondary", "text-secondary-foreground"],
  ["link", "text-primary"],
] as const;

describe("buttonVariants after the class merge", () => {
  test.each(VARIANTS)("keeps the text color of %s", (variant, textColor) => {
    const merged = cn(buttonVariants({ variant, size: "sm" })).split(" ");
    expect(merged).toContain(textColor);
  });

  test.each(VARIANTS)("keeps the font size of %s", (variant) => {
    const merged = cn(buttonVariants({ variant, size: "sm" })).split(" ");
    expect(merged).toContain("text-small");
  });
});

describe("buttonVariants while aria-disabled", () => {
  test.each([
    "default",
    "destructive",
    "outline",
    "secondary",
    "ghost",
    "link",
  ] as const)(
    "shows no hover style of %s on an aria-disabled button",
    (variant) => {
      const hover = buttonVariants({ variant })
        .split(" ")
        .filter((name) => name.includes("hover:"));

      expect(
        hover.filter((name) => !name.startsWith("not-aria-disabled:")),
      ).toEqual([]);
    },
  );
});
