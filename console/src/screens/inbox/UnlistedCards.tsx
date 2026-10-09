import { KindDot } from "../../components/KindDot.tsx";
import { cn } from "../../lib/cn.ts";
import type { UnlistedCount } from "../../lib/inboxView.ts";

/**
 * 一覧に出していない要対応の件数を、種類ごとのカードで示す。
 * 一覧に載せていないので押せない。理由はカードの中に書く。
 * `compact`は、一覧の上の帯に収める1行の形である。
 */
export function UnlistedCards({
  entries,
  compact = false,
}: {
  entries: readonly UnlistedCount[];
  compact?: boolean;
}) {
  return (
    <ul className={cn("flex flex-wrap", compact ? "gap-2" : "gap-3")}>
      {entries.map((entry) =>
        compact ? (
          <li
            key={entry.type}
            className="flex items-center gap-2 rounded-full border border-border bg-card py-1 pr-3.5 pl-3 text-small"
          >
            <KindDot type={entry.type} />
            <span className="text-muted-foreground">{entry.label}</span>
            <span className="font-semibold tabular-nums">
              {entry.count}
              <span className="ml-0.5 font-normal text-muted-foreground">
                件
              </span>
            </span>
            <span className="text-caption text-subtle">{entry.note}</span>
          </li>
        ) : (
          <li
            key={entry.type}
            className="min-w-40 rounded-xl border border-border bg-card px-4 py-3"
          >
            <p className="flex items-center gap-2 text-small text-muted-foreground">
              <KindDot type={entry.type} />
              {entry.label}
            </p>
            <p className="text-title leading-tight font-semibold tabular-nums">
              {entry.count}
              <span className="ml-0.5 text-small font-normal text-muted-foreground">
                件
              </span>
            </p>
            <p className="text-caption text-subtle">{entry.note}</p>
          </li>
        ),
      )}
    </ul>
  );
}
