import { cn } from "../../lib/cn.ts";
import type { Heading } from "../../lib/markdownHeadings.ts";

/**
 * 要件定義書の目次。見出しのリンクは、本文の見出しの`id`を指す。
 * 見出しが無いときは何も描かない。
 */
export function RequirementsToc({
  headings,
}: {
  headings: readonly Heading[];
}) {
  if (headings.length === 0) {
    return null;
  }
  return (
    <nav aria-label="目次" className="text-small">
      <p className="mb-2 font-semibold text-muted-foreground">目次</p>
      <ul className="flex flex-col gap-1.5 border-l border-border pl-4">
        {headings.map((heading) => (
          <li key={heading.id} className={cn(heading.level === 3 && "pl-3")}>
            <a
              href={`#${heading.id}`}
              className="rounded-sm text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
