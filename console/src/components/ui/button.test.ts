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

const VARIANT_NAMES = [
  "default",
  "destructive",
  "outline",
  "secondary",
  "ghost",
  "link",
] as const;

// variantごとの、aria-disabledのときにhoverを打ち消す値。面と文字を、hoverの前の色へ戻す。
// outlineとghostの文字は、親から継いだ色(text-current)へ戻す。
const CANCELLED_HOVER = {
  default: ["aria-disabled:hover:bg-primary"],
  destructive: ["aria-disabled:hover:bg-destructive"],
  outline: ["aria-disabled:hover:bg-card", "aria-disabled:hover:text-current"],
  secondary: ["aria-disabled:hover:bg-secondary"],
  ghost: [
    "aria-disabled:hover:bg-transparent",
    "aria-disabled:hover:text-current",
  ],
  link: ["aria-disabled:hover:no-underline"],
} as const;

function tokensOf(variant: (typeof VARIANT_NAMES)[number]): string[] {
  return buttonVariants({ variant }).split(" ");
}

/** hoverで変わる性質の名前。`hover:bg-x`なら`bg`、`hover:underline`なら`underline`。 */
function propertyOf(token: string): string {
  const name = token.slice(token.indexOf("hover:") + "hover:".length);
  const bare = name.replace(/^no-/, "");
  return bare.split("-")[0] ?? bare;
}

describe("buttonVariants while aria-disabled", () => {
  test.each(VARIANT_NAMES)("cancels the hover style of %s", (variant) => {
    const cancelled = tokensOf(variant).filter((name) =>
      name.startsWith("aria-disabled:hover:"),
    );

    expect(cancelled.sort()).toEqual([...CANCELLED_HOVER[variant]].sort());
  });

  test.each(VARIANT_NAMES)(
    "pairs every hover property of %s with a cancel",
    (variant) => {
      const tokens = tokensOf(variant);
      const hovered = tokens
        .filter(
          (name) =>
            name.includes("hover:") && !name.startsWith("aria-disabled:"),
        )
        .map(propertyOf);
      const cancelled = tokens
        .filter((name) => name.startsWith("aria-disabled:hover:"))
        .map(propertyOf);

      expect(cancelled.sort()).toEqual(hovered.sort());
    },
  );

  test("keeps the unqualified hover style of every variant", () => {
    const counts = VARIANT_NAMES.map(
      (variant) =>
        tokensOf(variant).filter((name) => name.startsWith("hover:")).length,
    );

    expect(counts).toEqual([1, 1, 2, 1, 2, 1]);
  });

  test("does not use not-aria-disabled", () => {
    expect(VARIANT_NAMES.flatMap(tokensOf).join(" ")).not.toContain(
      "not-aria-disabled",
    );
  });

  test("leaves the not-allowed cursor to the caller", () => {
    const tokens = VARIANT_NAMES.flatMap(tokensOf);

    expect(
      tokens.filter((name) => name.includes("cursor-not-allowed")),
    ).toEqual([]);
  });
});
