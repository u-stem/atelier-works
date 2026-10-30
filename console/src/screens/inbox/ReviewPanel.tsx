import type { ReactNode } from "react";
import { Link } from "react-router";
import type { LoadingShape } from "../../components/LoadingState.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";

/**
 * 承認の画面で、承認の対象の本体を入れるパネルの外枠。
 * `link`があれば、見出しの横に別の画面へのリンクを出す。
 */
export function PanelShell({
  heading,
  link,
  children,
}: {
  heading: string;
  link: string | null;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="approval-doc-heading"
      className="rounded-xl border border-border bg-card"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
        <h3 id="approval-doc-heading" className="text-lead font-semibold">
          {heading}
        </h3>
        {link === null ? null : (
          <Link
            to={link}
            className="rounded-sm text-small font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            別の画面で開く
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

/** 読み込み中の形。 */
export const LOADING_SHAPE: LoadingShape = {
  className: "space-y-2 px-5 py-4",
  node: (
    <>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </>
  ),
};

export function PanelNote({ children }: { children: string }) {
  return (
    <p className="px-5 py-4 text-small text-muted-foreground">{children}</p>
  );
}
