import { Fragment, useId } from "react";
import { Button } from "../components/ui/button.tsx";
import { useDialogSync } from "../components/useDialogSync.ts";
import { type Platform, shortcutRows } from "../lib/shortcutKeys.ts";
import { SCREENS } from "./screens.ts";

const KBD_CLASS =
  "rounded-sm border border-border bg-muted px-1.5 font-sans text-caption leading-5 text-muted-foreground";

/**
 * ショートカットの一覧と、1文字のショートカットを有効にする切り替え。
 * ブラウザ標準の`<dialog>`をモーダルで開く。Escで閉じ、閉じると元の要素へフォーカスが戻る。
 * 一覧は画面の表から作る。1文字のキーは既定で無効で、切り替えで有効にする。
 * 無効のままでも、パレットの項目とサイドバーのボタンから、この一覧を開ける。
 * 閉じる操作はすべて`onClose`を呼ぶ。`open`を偽にして閉じたときは呼ばない。
 */
export function ShortcutHelp({
  open,
  onClose,
  enabled,
  onEnabledChange,
  platform,
}: {
  open: boolean;
  onClose: () => void;
  /** 1文字のショートカットが有効か。 */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  platform: Platform;
}) {
  const headingId = useId();
  const noteId = useId();
  const { ref, openRef } = useDialogSync(open);
  const rows = shortcutRows(SCREENS, platform);

  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      aria-describedby={noteId}
      onClose={() => {
        // 親が`open`を偽にして閉じたときは、親がすでに知っているので知らせない。
        if (openRef.current) {
          onClose();
        }
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-raised backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id={headingId} className="text-lead font-semibold">
          ショートカットの一覧
        </h2>
        <ul className="flex flex-col gap-2 text-body">
          {rows.map((row) => (
            <li
              key={row.description}
              className="flex items-center justify-between gap-4"
            >
              <span>{row.description}</span>
              <span className="flex shrink-0 items-center gap-1 text-small text-muted-foreground">
                {row.keys.map((key, index) => (
                  <Fragment key={key}>
                    {index === 0 ? null : <span>{row.separator}</span>}
                    <kbd className={KBD_CLASS}>{key}</kbd>
                  </Fragment>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <label className="flex items-center gap-3 text-body">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              onEnabledChange(event.target.checked);
            }}
            className="size-4 accent-primary"
          />
          <span>ショートカットを有効にする</span>
        </label>
        <p id={noteId} className="text-small text-muted-foreground">
          <span className="block">
            gの次の数字と?は、入力中の内容を失わないよう、既定では無効です。
          </span>
          <span className="block">
            無効のままでも、コマンドパレットとこの一覧は使えます。
          </span>
        </p>
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              ref.current?.close();
            }}
          >
            閉じる
          </Button>
        </div>
      </div>
    </dialog>
  );
}
