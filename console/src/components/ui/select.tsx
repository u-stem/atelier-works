import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * ブラウザ標準の`select`を、ボタンや入力欄と同じ高さ、角、枠にしたもの。
 * 開いた一覧は標準のまま使うので、キーボードと読み上げの動きは変わらない。
 * 矢印は飾りで、操作を受けない。
 */
function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative inline-flex">
      <select
        data-slot="select"
        className={cn(
          "h-9 w-full appearance-none rounded-lg border border-input bg-card py-1 pr-8 pl-3 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export { Select };
