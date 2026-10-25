import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import type { Crumb } from "../lib/breadcrumbs.ts";

/**
 * パンくず。戻り先をリンクで並べ、最後の1つを今の画面として文字で出す。
 * 最後の1つは、`to`を持っていてもリンクにしない。今の画面へのリンクは何も起こさないためである。
 */
export function Breadcrumb({ items }: { items: readonly Crumb[] }) {
  if (items.length === 0) {
    return null;
  }
  const lastIndex = items.length - 1;
  return (
    <nav aria-label="パンくず" className="mt-1">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-small text-muted-foreground">
        {items.map((item, index) => (
          <li key={item.label} className="inline-flex items-center gap-1">
            {index > 0 ? (
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
            ) : null}
            {index < lastIndex && item.to !== undefined ? (
              <Link
                to={item.to}
                className="rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.label}
              </Link>
            ) : (
              <span
                aria-current={index === lastIndex ? "page" : undefined}
                className={index === lastIndex ? "text-foreground" : undefined}
              >
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
