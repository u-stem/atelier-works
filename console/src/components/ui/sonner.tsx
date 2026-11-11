import * as SonnerPrimitive from "sonner";

/**
 * トーストの置き場。色はテーマのトークンから取り、htmlのdata-themeに追従する。OSの設定に従うのは、data-themeが無いときだけである。
 * sonner自身の配色より優先させるため、ユーティリティに`!`を付けている。
 * 書き込みの結果の知らせは`announce`で出す。成功以外は閉じるまで残るので、残ったトーストが重なっても全部読めるようにする。
 * 重ねて畳む既定をやめて縦に並べ(`expand`)、並べる数に上限を置かない(`visibleToasts`)。
 * sonnerは上限を超えたトーストを透明にするので、上限があると、古い知らせが閉じるまで読めなくなるためである。
 * 並べたトーストが画面の高さを超えると、古いものは画面の上へはみ出す。新しいものを閉じると下りてくる。
 */
function Toaster({ toastOptions, ...props }: SonnerPrimitive.ToasterProps) {
  return (
    <SonnerPrimitive.Toaster
      className="toaster group"
      expand
      visibleToasts={Number.POSITIVE_INFINITY}
      toastOptions={{
        closeButtonAriaLabel: "知らせを閉じる",
        ...toastOptions,
        classNames: {
          toast:
            "border-border! bg-popover! text-popover-foreground! shadow-md!",
          description: "text-muted-foreground!",
          closeButton:
            "border-border! bg-popover! text-popover-foreground! hover:bg-muted! focus-visible:ring-2! focus-visible:ring-ring!",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
