import { Fragment, useId, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog } from "../components/ui/dialog.tsx";
import { CHECKBOX_CLASS } from "../lib/controlClasses.ts";
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
  const ref = useRef<HTMLDialogElement>(null);
  const rows = shortcutRows(SCREENS, platform);

  return (
    <Dialog
      ref={ref}
      open={open}
      onClose={onClose}
      aria-labelledby={headingId}
      aria-describedby={noteId}
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
            className={CHECKBOX_CLASS}
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
    </Dialog>
  );
}
