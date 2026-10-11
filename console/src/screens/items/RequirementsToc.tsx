import { useMemo, useRef } from "react";
import { cn } from "../../lib/cn.ts";
import type { Heading } from "../../lib/markdownHeadings.ts";
import { useActiveHeading } from "./useActiveHeading.ts";

/**
 * 目次の一覧。`activeId`の見出しを、読んでいる節として強調する。
 * 見出しのリンクは、本文の見出しの`id`を指す。見出しが無いときは何も描かない。
 */
export function RequirementsTocList({
  headings,
  activeId,
}: {
  headings: readonly Heading[];
  activeId: string | null;
}) {
  if (headings.length === 0) {
    return null;
  }
  return (
    <nav aria-label="目次" className="text-small">
      <p className="mb-2 font-semibold text-muted-foreground">目次</p>
      <ul className="flex flex-col gap-1.5 border-l border-border pl-4">
        {headings.map((heading) => (
          <li key={heading.id}>
            {/* 強調の線は、目次の左の線に重ねる。左の余白を負の余白で打ち消し、文字の位置は変えない。 */}
            <a
              href={`#${heading.id}`}
              aria-current={heading.id === activeId ? "location" : undefined}
              className={cn(
                "-ml-[calc(1rem+1px)] block rounded-sm border-l-2 border-transparent text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring aria-[current=location]:border-primary aria-[current=location]:font-medium aria-[current=location]:text-foreground",
                heading.level === 3
                  ? "pl-[calc(1rem+0.75rem-1px)]"
                  : "pl-[calc(1rem-1px)]",
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * 要件定義書の目次。本文をスクロールすると、読んでいる節を強調する。
 * 強調する節は、本文の見出しの位置から決める。
 */
export function RequirementsToc({
  headings,
}: {
  headings: readonly Heading[];
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => headings.map((heading) => heading.id), [headings]);
  const activeId = useActiveHeading(ids, anchor);
  return (
    <div ref={anchor}>
      <RequirementsTocList headings={headings} activeId={activeId} />
    </div>
  );
}
