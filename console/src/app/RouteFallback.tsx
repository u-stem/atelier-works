import type { ComponentType } from "react";
import { Skeleton } from "../components/ui/skeleton.tsx";
import {
  BACK_LINK_ROW_CLASS,
  BREADCRUMB_ROW_CLASS,
  PAGE_HEADER_CLASS,
  SCROLL_BODY_CLASS,
  SUBTITLE_ROW_CLASS,
} from "../lib/layoutClasses.ts";
import type { FallbackHeader, ScreenTrail } from "./screens.ts";

/** 題の下の戻り先の行。パンくずと戻りのリンクで、行の高さが違う。 */
const TRAIL_ROW_CLASS: Readonly<Record<ScreenTrail, string>> = {
  breadcrumb: BREADCRUMB_ROW_CLASS,
  back: BACK_LINK_ROW_CLASS,
};

/**
 * 最初の画面を読み込んでいる間の表示。外枠(サイドバー)は実物が描かれ、本文の位置にこれが出る。
 * 見出しの帯と本文の枠は、実物の画面と同じclassで描く。実物と入れ替わる瞬間に、帯の線と本文の位置が動かないためである。
 * 副題を持たない画面の帯は、題の1行(`text-title`の28px)でなく、帯の最小の高さ(72px)が高さを決める。
 * 戻り先の行(パンくずか戻りのリンク)を持つ画面は、副題の行と、戻り先の行の高さを足す。副題は戻り先の行を持つ画面にだけある。
 * 右端の更新の操作(高さ36px、幅約154px)の枠も置く。幅が狭いと実物は題の下へ折り返し、帯が約44px高くなる。
 * 更新の操作を持たない画面は、枠を置かない。
 */
function Fallback({
  trail,
  refresh,
}: {
  trail?: ScreenTrail;
  refresh: boolean;
}) {
  return (
    <div role="status" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">読み込み中</span>
      <div className={PAGE_HEADER_CLASS}>
        <div className="flex flex-col">
          <Skeleton className="h-7 w-48" />
          {trail === undefined ? null : (
            <>
              <div data-part="subtitle" className={SUBTITLE_ROW_CLASS}>
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
              <div data-part="trail" className={TRAIL_ROW_CLASS[trail]}>
                <Skeleton className="h-3 w-40 max-w-full" />
              </div>
            </>
          )}
        </div>
        {refresh ? (
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

const TRAILS = [undefined, "breadcrumb", "back"] as const;

/** 見出しの帯の特徴ごとの骨組み。部品を毎回作り直さず、同じ特徴には同じ部品を返す。 */
const FALLBACKS: ReadonlyMap<string, ComponentType> = new Map(
  TRAILS.flatMap((trail) =>
    [true, false].map((refresh): [string, ComponentType] => [
      fallbackKey(trail, refresh),
      () => (
        <Fallback
          {...(trail === undefined ? {} : { trail })}
          refresh={refresh}
        />
      ),
    ]),
  ),
);

function fallbackKey(trail: ScreenTrail | undefined, refresh: boolean): string {
  return `${trail ?? "none"}:${refresh ? "refresh" : "static"}`;
}

/** 見出しの帯の特徴に合う骨組みの部品。`refresh`を省くと、更新の操作を持つ画面の骨組みになる。 */
export function routeFallbackFor(header: FallbackHeader = {}): ComponentType {
  const found = FALLBACKS.get(
    fallbackKey(header.trail, header.refresh !== false),
  );
  if (found === undefined) {
    throw new Error("no fallback for the header");
  }
  return found;
}
