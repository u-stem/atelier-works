import { FileQuestion } from "lucide-react";

/** 開いた番号や対象が見つからないとき、本文の代わりに出す枠。 */
export function MissingMessage({ children }: { children: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
        <FileQuestion aria-hidden="true" className="size-6" />
      </span>
      <p className="max-w-sm text-small text-muted-foreground">{children}</p>
    </div>
  );
}
