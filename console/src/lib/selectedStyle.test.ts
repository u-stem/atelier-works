import { describe, expect, test } from "bun:test";
import { buttonVariants } from "../components/ui/button.tsx";
import { cn } from "./cn.ts";
import { SELECTED_STYLE } from "./selectedStyle.ts";

// 期間切替が選択中を重ねる先。KindChipsとThemeSwitchは、描画のテストで確かめる。
const merged = cn(
  buttonVariants({ variant: "outline", size: "sm" }),
  SELECTED_STYLE,
).split(" ");

describe("SELECTED_STYLE after the class merge", () => {
  test.each([
    "border-primary",
    "bg-selected",
    "text-selected-foreground",
    "hover:bg-selected",
    "hover:text-selected-foreground",
  ])("keeps %s", (token) => {
    expect(merged).toContain(token);
  });

  test.each(["bg-card", "hover:bg-accent", "hover:text-accent-foreground"])(
    "drops %s of the unselected button",
    (token) => {
      expect(merged).not.toContain(token);
    },
  );

  test("does not change the font weight", () => {
    expect(SELECTED_STYLE).not.toContain("font-");
  });
});
