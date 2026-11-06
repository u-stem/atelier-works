import { describe, expect, test } from "bun:test";
import { buttonVariants } from "../components/ui/button.tsx";
import { cn } from "./cn.ts";
import { SELECTED_STYLE } from "./selectedStyle.ts";

// 期間切替が選択中を重ねる先。KindChipsは、描画のテストで確かめる。
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

  test("drops the unselected surface", () => {
    expect(merged).not.toContain("bg-card");
  });

  // ボタンのhoverの打ち消し(aria-disabled:で始まる分)は、選択中でも残ってよい。
  // それ以外のhoverが、選択中の2つだけになっていることを見る。
  test("leaves only the selected hover style besides the aria-disabled cancels", () => {
    const isHover = (name: string) =>
      name.includes("hover:") && !name.startsWith("aria-disabled:");

    expect(merged.filter(isHover).sort()).toEqual(
      SELECTED_STYLE.split(" ").filter(isHover).sort(),
    );
  });

  test("does not change the font weight", () => {
    expect(SELECTED_STYLE).not.toContain("font-");
  });
});
