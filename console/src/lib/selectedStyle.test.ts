import { describe, expect, test } from "bun:test";
import { buttonVariants } from "../components/ui/button.tsx";
import { cn } from "./cn.ts";
import { SELECTED_STYLE } from "./selectedStyle.ts";

// 選択中を重ねる先の、未選択のクラスと、そこで落ちるべき背景。
const UNSELECTED = [
  ["border border-transparent bg-muted text-subtle", "bg-muted"],
  [buttonVariants({ variant: "outline", size: "sm" }), "bg-card"],
] as const;

describe("SELECTED_STYLE after the class merge", () => {
  test.each(UNSELECTED)("keeps the selected colors over %s", (base) => {
    const merged = cn(base, SELECTED_STYLE).split(" ");
    expect(merged).toEqual(
      expect.arrayContaining([
        "border-primary",
        "bg-selected",
        "text-selected-foreground",
      ]),
    );
  });

  test.each(UNSELECTED)("drops the unselected background of %s", (base, bg) => {
    const merged = cn(base, SELECTED_STYLE).split(" ");
    expect(merged).not.toContain(bg);
  });

  test("does not change the font weight", () => {
    expect(SELECTED_STYLE).not.toContain("font-");
  });
});
