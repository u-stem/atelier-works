import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { KindDot } from "../../components/KindDot.tsx";
import { cn } from "../../lib/cn.ts";
import {
  type UnlistedCount,
  unlistedNote,
  unlistedPath,
} from "../../lib/inboxView.ts";

const LINK_HOVER =
  "outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none";

/** 移動先があるカードは全体を1つのリンクにし、押せると分かる矢印を添える。リンクの名前は、カードに見える文になる。 */
function CardBody({
  entry,
  className,
  children,
}: {
  entry: UnlistedCount;
  className: string;
  children: ReactNode;
}) {
  const path = unlistedPath(entry);
  if (path === null) {
    return <div className={className}>{children}</div>;
  }
  return (
    <Link to={path} className={cn(className, LINK_HOVER)}>
      {children}
      <ChevronRight
        aria-hidden="true"
        className="ml-auto size-4 shrink-0 text-subtle"
      />
    </Link>
  );
}

/**
 * 一覧に出していない要対応の件数を、種類ごとのカードで示す。
 * 一覧にない分は、取得の上限を超えた分と、再実行できず、後の監査で報告済みにもなっていない監査の失敗なので、その旨を添える。
 * システムの画面で読める監査の失敗のカードだけ、その画面へのリンクにする。
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
            key={`${entry.type}:${entry.cause ?? ""}`}
            className="overflow-hidden rounded-full border border-border bg-card text-small"
          >
            <CardBody
              entry={entry}
              className="flex items-center gap-2 py-1 pr-3.5 pl-3"
            >
              <KindDot type={entry.type} />
              <span className="text-muted-foreground">{entry.label}</span>
              <span className="font-semibold tabular-nums">
                {entry.count}
                <span className="ml-0.5 font-normal text-muted-foreground">
                  件
                </span>
              </span>
              <span className="text-muted-foreground">
                {unlistedNote(entry)}
              </span>
            </CardBody>
          </li>
        ) : (
          <li
            key={`${entry.type}:${entry.cause ?? ""}`}
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            <CardBody entry={entry} className="flex items-start px-4 py-3">
              <div className="min-w-0">
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
                <p className="mt-1 text-small text-muted-foreground">
                  {unlistedNote(entry)}
                </p>
              </div>
            </CardBody>
          </li>
        ),
      )}
    </ul>
  );
}
