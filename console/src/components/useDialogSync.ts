import { type RefObject, useEffect, useRef } from "react";

/** `HTMLDialogElement`のうち、開閉の同期が使う部分。 */
export type DialogLike = {
  readonly open: boolean;
  showModal(): void;
  close(): void;
};

/**
 * `open`に合わせて、dialogをモーダルで開くか閉じる。すでにその状態なら何もしない。
 * `onOpened`は、このときに開いた直後だけ呼ぶ。初期フォーカスの指定に使う。
 */
export function syncDialog(
  dialog: DialogLike,
  open: boolean,
  onOpened?: () => void,
): void {
  if (open && !dialog.open) {
    dialog.showModal();
    onOpened?.();
  } else if (!open && dialog.open) {
    dialog.close();
  }
}

/**
 * dialogの開閉を`open`に同期する。返すrefをdialogに付ける。
 * `openRef`は直近の`open`を持つ。`close`イベントが、利用側の閉じ込みか、ブラウザの閉じる動作かを見分けるために使う。
 */
export function useDialogSync(
  open: boolean,
  onOpened?: () => void,
): {
  ref: RefObject<HTMLDialogElement | null>;
  openRef: RefObject<boolean>;
} {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    if (ref.current !== null) {
      syncDialog(ref.current, open, onOpened);
    }
  }, [open, onOpened]);
  return { ref, openRef };
}

/**
 * 要素にフォーカスを置く。まだ描かれていない(`null`)ときは何もしない。
 * `syncDialog`の`onOpened`に渡して、ダイアログを開いたときの初期フォーカスを決める。
 */
export function focusElement(target: { focus(): void } | null): void {
  target?.focus();
}
