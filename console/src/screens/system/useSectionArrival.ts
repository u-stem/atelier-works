// 区画への移動を、区画の側で受ける仕組みと、着地した区画の強調の時間。

import type { SystemSectionId } from "../../lib/systemSections.ts";

/** 区画へ渡す、移動の受け取りと強調の状態。 */
export type SectionArrival = {
  /** 移動を待っている区画。待つ区画が無いときは`null`。 */
  readonly pending: SystemSectionId | null;
  /** 強調している区画。無ければ`null`。 */
  readonly highlighted: SystemSectionId | null;
  /** 区画が移動を受け取ったときに呼ぶ。 */
  readonly onArrived: (id: SystemSectionId) => void;
};

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

export function createHighlightController<Id, Handle>(_options: {
  readonly durationMs: number;
  readonly scheduler: Scheduler<Handle>;
  readonly onChange: (id: Id | null) => void;
}): HighlightController<Id> {
  return {
    show: () => undefined,
    dispose: () => undefined,
  };
}

export function arrive<Id>(_options: {
  readonly sectionId: Id;
  readonly pending: Id | null;
  readonly land: () => void;
  readonly onArrived: (id: Id) => void;
}): boolean {
  return false;
}
