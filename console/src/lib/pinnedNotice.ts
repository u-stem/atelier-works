import type { ReleaseNotice } from "./writeNotices.ts";

export type PinnedNotice = {
  readonly id: number;
  readonly item: string;
  readonly notice: ReleaseNotice;
};

export type PinnedNoticeStore = {
  readonly get: () => PinnedNotice | null;
  readonly pin: (item: string, notice: ReleaseNotice) => void;
  readonly dismiss: () => void;
  readonly subscribe: (listener: () => void) => () => void;
};

export function createPinnedNoticeStore(): PinnedNoticeStore {
  return {
    get: () => null,
    pin: () => undefined,
    dismiss: () => undefined,
    subscribe: () => () => undefined,
  };
}
