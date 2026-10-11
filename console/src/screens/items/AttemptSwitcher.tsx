import { Link } from "react-router";
import { cn } from "../../lib/cn.ts";
import { attemptRef } from "../../lib/labels.ts";
import {
  attemptChoices,
  requirementsPath,
} from "../../lib/requirementsView.ts";

/**
 * 要件定義の試行を切り替えるリンクの並び。新しい試行から並べ、表示中の試行に印を付ける。
 * 最新の試行へのリンクは番号を付けず、最新を指し続ける。
 * 却下による作り直しで試行は増えるが、それまでの試行も読める。
 */
export function AttemptSwitcher({
  workItemId,
  current,
  latest,
}: {
  workItemId: number;
  current: number;
  latest: number;
}) {
  return (
    <nav aria-label="試行の切り替え" className="flex flex-wrap gap-2">
      {attemptChoices(latest).map((choice) => (
        <Link
          key={choice.attempt}
          to={requirementsPath(
            workItemId,
            choice.latest ? null : choice.attempt,
          )}
          aria-current={choice.attempt === current ? "page" : undefined}
          className={cn(
            "inline-flex h-8 items-center rounded-md border border-border px-3 text-small outline-none transition-colors duration-150 motion-reduce:transition-none",
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
