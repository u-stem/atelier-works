import { Hourglass } from "lucide-react";
import type { ReactNode } from "react";

/** まだ作っていない画面の空の枠。 */
export function ComingSoon({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
      <Hourglass aria-hidden="true" className="size-8" />
      <p className="text-base font-medium text-foreground">準備中です</p>
      {children === undefined ? null : <p className="text-sm">{children}</p>}
    </div>
  );
}
