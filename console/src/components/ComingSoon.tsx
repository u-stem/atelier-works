import { Hourglass } from "lucide-react";
import type { ReactNode } from "react";

/** まだ作っていない画面の空の枠。 */
export function ComingSoon({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
        <Hourglass aria-hidden="true" className="size-6" />
      </span>
      <p className="text-lead font-semibold">準備中です</p>
      {children === undefined ? null : (
        <p className="max-w-sm text-small text-muted-foreground">{children}</p>
      )}
    </div>
  );
}
