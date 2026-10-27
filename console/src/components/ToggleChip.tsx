import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { TRANSITION_COLORS } from "../lib/motionClasses.ts";
import { SELECTED_STYLE } from "../lib/selectedStyle.ts";

/**
 * 1つだけ選ぶ切り替えの組。`ToggleChip`を並べる。
 * `legend`は読み上げだけに出し、画面には描かない。
 * `className`は、画面ごとに面や幅を変えるときに足す。省くと、今の見た目になる。
 */
export function ToggleChipGroup({
  legend,
  className,
  children,
}: {
  legend: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset
      className={cn(
        "m-0 inline-flex w-fit min-w-0 gap-0.5 rounded-lg border-0 bg-muted p-0.5",
        className,
      )}
    >
      <legend className="sr-only">{legend}</legend>
      {children}
    </fieldset>
  );
}

/**
 * 切り替えの1つの選択肢。選択中は`aria-pressed`と藍の枠線で示す。
 * 大きさと文字の色は呼び出し側の`className`で決める。
 * `TooltipTrigger asChild`の子にできるよう、残りの属性とrefをbuttonへ渡す。
 */
export function ToggleChip({
  pressed,
  className,
  ...props
}: ComponentProps<"button"> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        "inline-flex items-center rounded-md border border-transparent text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted",
        TRANSITION_COLORS,
        className,
        pressed && SELECTED_STYLE,
      )}
      {...props}
    />
  );
}
