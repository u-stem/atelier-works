import type { ReactNode } from "react";

/** 空であることを伝える実線の面。 */
export function EmptyNote({
  children,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span>{children}</span>;
}
