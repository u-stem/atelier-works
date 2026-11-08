// 区画への移動を、区画の側で受ける仕組みと、着地した区画の強調の時間。
// 取得の決着や読み込み中の骨組みの残り時間に依存しないよう、区画が描かれた時点で自分が受ける。

import { useEffect, useRef, useState } from "react";
import { jumpToSection } from "../../lib/sectionJump.ts";
import {
  type SystemSectionId,
  sectionDomId,
} from "../../lib/systemSections.ts";

/** 区画へ渡す、移動の受け取りと強調の状態。 */
export type SectionArrival = {
  /** 移動を待っている区画。待つ区画が無いときは`null`。 */
  readonly pending: SystemSectionId | null;
  /** 強調している区画。無ければ`null`。 */
  readonly highlighted: SystemSectionId | null;
  /** 区画が移動を受け取ったときに呼ぶ。 */
  readonly onArrived: (id: SystemSectionId) => void;
};

/** 着地した区画を強調する時間。読み取るのに足りて、読み終えた後に残らない長さにする。 */
export const HIGHLIGHT_MS = 4000;

/** 時間を計る道具。テストでは偽物を渡す。 */
export type Scheduler<Handle> = {
  readonly setTimeout: (run: () => void, ms: number) => Handle;
  readonly clearTimeout: (handle: Handle) => void;
};

export type HighlightController<Id> = {
  /** `id`を強調し、一定時間の後に外す。前の強調の時間は取り消す。 */
  readonly show: (id: Id) => void;
  /** 時間を取り消し、以後は通知しない。 */
  readonly dispose: () => void;
};

/**
 * 強調の入れ替えと、時間による解除を持つ。画面から切り離してあるので、偽のタイマーでテストできる。
 * 続けて`show`すると前の時間を取り消すので、前の強調の時間切れが、後の強調を外さない。
 * `dispose`の後は、時間が切れても、`show`を呼んでも通知しない。破棄した後の画面の状態を更新しないためである。
 */
export function createHighlightController<Id, Handle>(options: {
  readonly durationMs: number;
  readonly scheduler: Scheduler<Handle>;
  readonly onChange: (id: Id | null) => void;
}): HighlightController<Id> {
  const { durationMs, scheduler, onChange } = options;
  let timer: { readonly handle: Handle } | null = null;
  let disposed = false;

  const cancel = (): void => {
    if (timer !== null) {
      scheduler.clearTimeout(timer.handle);
      timer = null;
    }
  };

  return {
    show: (id) => {
      if (disposed) {
        return;
      }
      cancel();
      onChange(id);
      timer = {
        handle: scheduler.setTimeout(() => {
          timer = null;
          onChange(null);
        }, durationMs),
      };
    },
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}

/**
 * 待っている区画が自分なら、着地して、受け取ったことを知らせる。受け取ったかを返す。
 * 区画が描かれた後に呼ぶので、着地先の要素はすでにある。
 */
export function arrive<Id>(options: {
  readonly sectionId: Id;
  readonly pending: Id | null;
  readonly land: () => void;
  readonly onArrived: (id: Id) => void;
}): boolean {
  if (options.pending !== options.sectionId) {
    return false;
  }
  options.land();
  options.onArrived(options.sectionId);
  return true;
}

/**
 * 区画の部品が、描かれたときに移動を受けるフック。
 * 区画が描かれている間だけ呼ばれるので、区画が描かれないときは受け取らない。
 * 待つ区画が自分になるか、描かれた時点で自分なら、見出しへスクロールしてフォーカスを移し、`onArrived`を呼ぶ。
 * `onArrived`は最新の関数を読むが、効果の条件には入れない。毎回の描画で作り直される関数で、効果を繰り返さないためである。
 */
export function useSectionArrival(
  sectionId: SystemSectionId,
  pending: SystemSectionId | null,
  onArrived: (id: SystemSectionId) => void,
): void {
  const latest = useRef(onArrived);
  useEffect(() => {
    latest.current = onArrived;
  });
  useEffect(() => {
    arrive({
      sectionId,
      pending,
      land: () => {
        jumpToSection(sectionDomId(sectionId));
      },
      onArrived: (id) => {
        latest.current(id);
      },
    });
  }, [sectionId, pending]);
}

/** ブラウザのタイマーを使う`Scheduler`。 */
const BROWSER_SCHEDULER: Scheduler<ReturnType<typeof setTimeout>> = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

/**
 * 着地した区画の強調を持つフック。`show`で強調を始め、時間が来ると自動で外す。
 * 画面を離れるときは、時間を取り消す。StrictModeで効果が繰り返されても、
 * 破棄した制御は通知しないので、前の時間が新しい強調を外さない。
 */
export function useSectionHighlight(): {
  readonly highlighted: SystemSectionId | null;
  readonly show: (id: SystemSectionId) => void;
} {
  const [highlighted, setHighlighted] = useState<SystemSectionId | null>(null);
  const controller = useRef<HighlightController<SystemSectionId> | null>(null);
  useEffect(
    () => () => {
      controller.current?.dispose();
      controller.current = null;
    },
    [],
  );
  const show = (id: SystemSectionId): void => {
    controller.current ??= createHighlightController({
      durationMs: HIGHLIGHT_MS,
      scheduler: BROWSER_SCHEDULER,
      onChange: setHighlighted,
    });
    controller.current.show(id);
  };
  return { highlighted, show };
}
