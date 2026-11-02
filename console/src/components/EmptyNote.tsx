import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Card } from "./ui/card.tsx";

/**
 * 一覧や節が空であることを伝える実線の面。空の標準である。
 * 破線の面(`Card`の`empty`)は、一覧が入るはずの高さを保つ広い版と、操作の面の代わりに置く知らせに使う。
 */
export function EmptyNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card
      tag="p"
      padding="default"
      className={cn("text-small text-muted-foreground", className)}
    >
      {children}
    </Card>
  );
}
