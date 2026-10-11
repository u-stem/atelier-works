import { describe, expect, test } from "bun:test";
import { cn } from "../../lib/cn.ts";
import { buttonVariants } from "./button.tsx";

const VARIANTS = [
  ["default", "text-primary-foreground"],
  ["destructive", "text-destructive-foreground"],
  ["secondary", "text-secondary-foreground"],
] as const;

describe("buttonVariants after the class merge", () => {
  test.each(VARIANTS)("keeps the text color of %s", (variant, textColor) => {
    const merged = cn(buttonVariants({ variant, size: "sm" })).split(" ");
    expect(merged).toContain(textColor);
  });

  test("keeps the font size of the small size", () => {
    const merged = cn(buttonVariants({ size: "sm" })).split(" ");
    expect(merged).toContain("text-small");
  });
});
