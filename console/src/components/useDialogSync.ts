export type DialogLike = {
  readonly open: boolean;
  showModal(): void;
  close(): void;
};

export function syncDialog(
  _dialog: DialogLike,
  _open: boolean,
  _onOpened?: () => void,
): void {}
