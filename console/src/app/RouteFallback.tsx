import type { ComponentType } from "react";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { PAGE_HEADER_CLASS, SCROLL_BODY_CLASS } from "../lib/layoutClasses.ts";
import type { ScreenTrail } from "./screens.ts";

/**
 * 題の下の戻り先の行の骨組み。実物の行(上の余白4pxと、1行の高さ)に合わせる。
 * パンくずは`text-small`の1行(約21px)で、戻りのリンクは行の高さが約25pxになる。
 */
const TRAIL_ROW_CLASS: Readonly<Record<ScreenTrail, string>> = {
  breadcrumb: "mt-1 flex h-[1.3rem] items-center",
  back: "mt-1 flex h-[1.575rem] items-center",
};

/**
 * 最初の画面を読み込んでいる間の表示。外枠(サイドバー)は実物が描かれ、本文の位置にこれが出る。
 * 見出しの帯と本文の枠は、実物の画面と同じclassで描く。実物と入れ替わる瞬間に、帯の線と本文の位置が動かないためである。
 * 副題を持たない画面の帯は、題の1行(`text-title`の28px)でなく、帯の最小の高さ(72px)が高さを決める。
 * 副題を持つ画面は、副題の行(`text-small`の約21px)を足した高さになる。
 * 題の下に戻り先の行(パンくずか戻りのリンク)を持つ画面は、その行の高さも足す。
 * 右端の更新の操作(高さ36px、幅約154px)の枠も置く。幅が狭いと実物は題の下へ折り返し、帯が約44px高くなる。
 * 副題と戻り先の有無は経路ごとに違うので、`routeFallbackFor`が選ぶ。
 */
function Fallback({
  subtitle,
  trail,
}: {
  subtitle: boolean;
  trail?: ScreenTrail;
}) {
  // 戻りのリンクは、取得するものを持たない新規投入の画面だけが使う。更新の操作が無い。
  const hasRefresh = trail !== "back";
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
          {trail === undefined ? null : (
            <div data-part="trail" className={TRAIL_ROW_CLASS[trail]}>
              <Skeleton className="h-3 w-40 max-w-full" />
            </div>
          )}
        </div>
        {hasRefresh ? (
          <Skeleton data-part="refresh" className="h-9 w-[9.6rem]" />
        ) : null}
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

/** 副題とパンくずを持つ画面の骨組み。 */
export function RouteFallbackWithBreadcrumb() {
  return <Fallback subtitle trail="breadcrumb" />;
}

/** 副題と戻りのリンクを持つ画面の骨組み。 */
export function RouteFallbackWithBackLink() {
  return <Fallback subtitle trail="back" />;
}

/** 副題と戻り先の有無に合う骨組みの部品。 */
export function routeFallbackFor(
  hasSubtitle: boolean,
  trail?: ScreenTrail,
): ComponentType {
  if (trail === "breadcrumb") {
    return RouteFallbackWithBreadcrumb;
  }
  if (trail === "back") {
    return RouteFallbackWithBackLink;
  }
  return hasSubtitle ? RouteFallbackWithSubtitle : RouteFallback;
}
