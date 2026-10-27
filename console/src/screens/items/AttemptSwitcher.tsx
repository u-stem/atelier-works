import { Link } from "react-router";
import { cn } from "../../lib/cn.ts";
import { attemptRef } from "../../lib/labels.ts";
import { TRANSITION_COLORS } from "../../lib/motionClasses.ts";
import {
  attemptChoices,
  requirementsPath,
} from "../../lib/requirementsView.ts";

/**
 * 要件定義の試行を切り替えるリンクの並び。新しい試行から並べ、表示中の試行に印を付ける。
 * 最新の試行へのリンクは番号を付けず、最新を指し続ける。
 * 最新を確かめられないあいだは、どの試行にも「(最新)」を付けず、番号を付けたリンクにする。
 * 却下による作り直しで試行は増えるが、それまでの試行も読める。
 */
export function AttemptSwitcher({
  workItemId,
  current,
  latest,
}: {
  workItemId: number;
  current: number;
  /** 最新の試行の番号。確かめられていないときは`null`で、開いている試行までを並べる。 */
  latest: number | null;
}) {
  return (
    <nav aria-label="試行の切り替え" className="flex flex-wrap gap-2">
      {attemptChoices(latest ?? current, latest !== null).map((choice) => (
        <Link
          key={choice.attempt}
          to={requirementsPath(
            workItemId,
            choice.latest ? null : choice.attempt,
          )}
          aria-current={choice.attempt === current ? "page" : undefined}
          className={cn(
            "inline-flex h-8 items-center rounded-md border border-border px-3 text-small outline-none",
            TRANSITION_COLORS,
            "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
            "aria-[current=page]:border-primary aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-selected-foreground",
          )}
        >
          {attemptRef(choice.attempt)}
          {choice.latest ? "(最新)" : ""}
        </Link>
      ))}
    </nav>
  );
}
