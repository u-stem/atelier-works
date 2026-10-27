import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { TRANSITION_TRANSFORM } from "../lib/motionClasses.ts";
import { JUMP_OPEN_ATTRIBUTE } from "../lib/sectionJump.ts";

/**
 * 開閉できる部分。見出し行を押すか、キーボード(EnterかSpace)で開く。
 * `<details>`と`<summary>`なので、開閉の状態は読み上げが伝える。
 * 開閉はURLにも履歴にも残さず、`open`は要素が持つ。`initiallyOpen`は最初の状態だけを決める。
 * `jumpOpen`の部分は、要約の帯のリンクで節へ移るときに開く(`openJumpDisclosures`)。
 * `onToggle`は、描画を開閉に合わせたいときだけ使う(開いたときに初めて中身を描くなど)。
 */
export function Disclosure({
  summary,
  children,
  jumpOpen = false,
  initiallyOpen = false,
  onToggle,
}: {
  summary: ReactNode;
  children: ReactNode;
  /** 節へ移るときに開く。 */
  jumpOpen?: boolean;
  initiallyOpen?: boolean;
  /** 開閉が変わったときに、開いているかを受け取る。 */
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      className="group"
      {...(jumpOpen ? { [JUMP_OPEN_ATTRIBUTE]: "" } : {})}
      {...(initiallyOpen ? { open: true } : {})}
      onToggle={
        onToggle === undefined
          ? undefined
          : (event) => {
              onToggle(event.currentTarget.open);
            }
      }
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md py-1 text-body font-medium text-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground group-open:rotate-90",
            TRANSITION_TRANSFORM,
          )}
        />
        <span className="min-w-0 flex-1">{summary}</span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
