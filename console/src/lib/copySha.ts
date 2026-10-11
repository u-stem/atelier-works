// 版の全体をクリップボードへ複製し、結果を知らせる。
// クリップボードと通知の手段は引数で受け、画面から切り離して確かめられるようにする。

/** 複製に使うクリップボード。使えない環境では`undefined`を渡す。 */
export type ClipboardWriter = {
  readonly writeText: (text: string) => Promise<void>;
};

/** 複製の結果を知らせる手段。 */
export type CopyNotifier = {
  readonly success: (message: string) => void;
  readonly error: (message: string) => void;
};

/**
 * `sha`を複製する。成功したか、失敗したかを`notify`で知らせる。
 * クリップボードが無い環境や、書き込みを拒まれたときは、失敗を知らせる。
 */
export async function copySha(
  sha: string,
  clipboard: ClipboardWriter | undefined,
  notify: CopyNotifier,
): Promise<void> {
  if (clipboard === undefined) {
    notify.error("この環境では複製できません");
    return;
  }
  try {
    await clipboard.writeText(sha);
  } catch {
    notify.error("版を複製できませんでした");
    return;
  }
  notify.success("版を複製しました");
}
