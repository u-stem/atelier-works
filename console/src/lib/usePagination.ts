import type { RefObject } from "react";

/** 仮の実装。 */
export function usePagination(
  _total: number,
  _size: number,
  _initialPage = 0,
): {
  page: number;
  change: (next: number) => void;
  reset: () => void;
  anchorRef: RefObject<HTMLDivElement | null>;
} {
  return {
    page: -1,
    change: () => {},
    reset: () => {},
    anchorRef: { current: null },
  };
}
