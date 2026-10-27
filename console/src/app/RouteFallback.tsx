import type { ComponentType } from "react";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { PAGE_HEADER_CLASS, SCROLL_BODY_CLASS } from "../lib/layoutClasses.ts";

/**
 * 最初の画面を読み込んでいる間の表示。外枠(サイドバー)は実物が描かれ、本文の位置にこれが出る。
 * 見出しの帯と本文の枠は、実物の画面と同じclassで描く。実物に置き換わるときに、帯と本文の位置が動かないためである。
 * 帯の高さは、題の1行(`text-title`の28px)と余白でなく、帯の最小の高さ(72px)が決める。
 * 副題を持つ画面(要対応など)の帯は、これより約9px高い。画面の入口の多くは副題を持たないので、持たない形に合わせる。
 */
export function RouteFallback() {
  return (
    <div role="status" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">読み込み中</span>
      <div className={PAGE_HEADER_CLASS}>
        <Skeleton className="h-7 w-48" />
      </div>
      <div className={SCROLL_BODY_CLASS}>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}

function RouteFallbackWithSubtitle() {
  return null;
}

/** 副題の有無に合う骨組みの部品。 */
export function routeFallbackFor(hasSubtitle: boolean): ComponentType {
  return hasSubtitle ? RouteFallbackWithSubtitle : RouteFallback;
}
