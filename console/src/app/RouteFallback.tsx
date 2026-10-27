import type { ComponentType } from "react";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { PAGE_HEADER_CLASS, SCROLL_BODY_CLASS } from "../lib/layoutClasses.ts";
import type { ScreenTrail } from "./screens.ts";

/**
 * 最初の画面を読み込んでいる間の表示。外枠(サイドバー)は実物が描かれ、本文の位置にこれが出る。
 * 見出しの帯と本文の枠は、実物の画面と同じclassで描く。実物と入れ替わる瞬間に、帯の線と本文の位置が動かないためである。
 * 副題を持たない画面の帯は、題の1行(`text-title`の28px)でなく、帯の最小の高さ(72px)が高さを決める。
 * 副題を持つ画面は、副題の行(`text-small`の約21px)を足した高さになる。
 * 副題の有無は経路ごとに違うので、`routeFallbackFor`が選ぶ。
 */
function Fallback({ subtitle }: { subtitle: boolean }) {
  return (
    <div role="status" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">読み込み中</span>
      <div className={PAGE_HEADER_CLASS}>
        <div className="flex flex-col">
          <Skeleton className="h-7 w-48" />
          {subtitle ? (
            <div data-part="subtitle" className="flex h-[1.3rem] items-center">
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
          ) : null}
        </div>
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

/** 副題を持たない画面の骨組み。 */
export function RouteFallback() {
  return <Fallback subtitle={false} />;
}

/** 副題を持つ画面の骨組み。 */
export function RouteFallbackWithSubtitle() {
  return <Fallback subtitle />;
}

/** 副題の有無に合う骨組みの部品。 */
export function routeFallbackFor(
  hasSubtitle: boolean,
  _trail?: ScreenTrail,
): ComponentType {
  return hasSubtitle ? RouteFallbackWithSubtitle : RouteFallback;
}
