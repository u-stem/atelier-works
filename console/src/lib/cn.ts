import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** クラス名を条件付きで連結し、競合するTailwindのユーティリティは後のものを残す。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
