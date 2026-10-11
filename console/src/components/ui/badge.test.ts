import { describe, expect, test } from "bun:test";
import { cn } from "../../lib/cn.ts";
import { badgeVariants } from "./badge.tsx";

const VARIANTS = [
  ["default", "text-primary-foreground"],
  ["secondary", "text-secondary-foreground"],
  ["destructive", "text-destructive-foreground"],
  ["outline", "text-muted-foreground"],
  ["approval", "text-approval"],
  ["failure", "text-failure"],
  ["notice", "text-notice"],
  ["success", "text-success"],
  ["warning", "text-warning"],
] as const;

describe("badgeVariants after the class merge", () => {
  test.each(VARIANTS)("keeps the text color of %s", (variant, textColor) => {
    const merged = cn(badgeVariants({ variant })).split(" ");
    expect(merged).toContain(textColor);
  });

  test.each(VARIANTS)("keeps the font size of %s", (variant) => {
    const merged = cn(badgeVariants({ variant })).split(" ");
    expect(merged).toContain("text-caption");
  });
});
