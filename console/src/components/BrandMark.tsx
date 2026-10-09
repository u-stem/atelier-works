import { cn } from "../lib/cn.ts";

/**
 * Factory Consoleの印。流れてくる処理が細くなり、最後の点で出荷される様子を3本の帯と点で表す。
 * 外部のファイルを読まないよう、SVGをそのまま描く。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-8 shrink-0", className)}
    >
      <rect width="32" height="32" rx="9" fill="var(--primary)" />
      <rect
        x="8"
        y="8.5"
        width="16"
        height="3.5"
        rx="1.75"
        fill="var(--primary-foreground)"
      />
      <rect
        x="8"
        y="14.25"
        width="11"
        height="3.5"
        rx="1.75"
        fill="var(--primary-foreground)"
        opacity="0.8"
      />
      <rect
        x="8"
        y="20"
        width="6"
        height="3.5"
        rx="1.75"
        fill="var(--primary-foreground)"
        opacity="0.6"
      />
      <circle cx="22.5" cy="21.75" r="2.25" fill="var(--primary-foreground)" />
    </svg>
  );
}
