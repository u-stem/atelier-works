import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * index.cssの`--text-*`が定める文字の大きさ。
 * 教えないと、`text-body`などを文字色と見なし、同じ要素の`text-primary-foreground`を落とす。
 */
export const FONT_SIZES: readonly string[] = [
  "caption",
  "small",
  "body",
  "lead",
  "title",
  "display",
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...FONT_SIZES] }],
    },
  },
});

/** クラス名を条件付きで連結し、競合するTailwindのユーティリティは後のものを残す。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
