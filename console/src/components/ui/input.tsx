import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-9 w-full rounded-lg border border-input bg-card px-3 py-1 text-body text-foreground outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
