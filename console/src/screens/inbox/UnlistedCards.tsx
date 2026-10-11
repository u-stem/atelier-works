import { ExternalLink } from "lucide-react";
import { LEGACY_CONSOLE_PATH } from "../../app/legacyConsole.ts";
import { KindDot } from "../../components/KindDot.tsx";
import { cn } from "../../lib/cn.ts";
import type { UnlistedCount } from "../../lib/inboxView.ts";

const LINK_CLASS =
  "inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/**
 * 一覧に出していない分の行き先。
 * 通知は一覧に出しているので、残りは取得の上限を超えた分である。行き先が無いので、リンクにしない。
 * 一覧が無い種類だけ、旧Consoleの一覧へのリンクにする。
 */
function UnlistedTarget({
  type,
  className,
}: {
  type: UnlistedCount["type"];
  className?: string;
}) {
  if (type === "notice") {
    return (
      <span className={cn("text-small text-subtle", className)}>
        一覧の上限を超えた分
      </span>
    );
  }
  return (
    <a
      className={cn(LINK_CLASS, className)}
      href={LEGACY_CONSOLE_PATH}
      target="_blank"
      rel="noopener noreferrer"
    >
      旧Consoleで見る
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  );
}

/**
 * 一覧に出していない要対応の件数を、種類ごとのカードで示す。
 * 一覧がまだ無い種類は、旧Consoleの一覧へのリンクにする。
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
    <ul
      className={cn(
        compact
          ? "flex flex-wrap gap-2"
          : "grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3",
      )}
    >
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
            <UnlistedTarget type={entry.type} />
          </li>
        ) : (
          <li
            key={entry.type}
            className="rounded-xl border border-border bg-card px-4 py-3"
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
            <UnlistedTarget type={entry.type} className="mt-1 text-small" />
          </li>
        ),
      )}
    </ul>
  );
}
