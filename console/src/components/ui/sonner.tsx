import * as SonnerPrimitive from "sonner";

/**
 * トーストの置き場。色はテーマのトークンから取り、htmlのdata-themeに追従する。OSの設定に従うのは、data-themeが無いときだけである。
 * sonner自身の配色より優先させるため、ユーティリティに`!`を付けている。
 * 書き込みの結果の知らせは`announce`で出す。成功以外は閉じるまで残るので、残ったトーストが重なっても全部読めるようにする。
 * 重ねて畳む既定をやめて縦に並べ(`expand`)、並べる数に上限を置かない(`visibleToasts`)。
 * sonnerは上限を超えたトーストを透明にするので、上限があると、古い知らせが閉じるまで読めなくなるためである。
 * 並べたトーストが画面の高さを超えると、古いものは画面の上へはみ出す。新しいものを閉じると下りてくる。
 * 閉じるボタンは、成功のトーストを含むすべてに付ける(`closeButton`)。
 * sonnerは、キーボードで並びへ移る(Alt+T)と消えるまでの時間を止め、トーストが1件以下に減るまで止めたままにする。
 * ボタンが無いと、成功のトーストもキーボードでは閉じられないためである。
 * トースト本体のフォーカスの輪は、閉じるボタンと同じ形にする。影の指定が、sonnerのフォーカスの影を上書きするためである。
 */
function Toaster({ toastOptions, ...props }: SonnerPrimitive.ToasterProps) {
  return (
    <SonnerPrimitive.Toaster
      className="toaster group"
      expand
      visibleToasts={Number.POSITIVE_INFINITY}
      closeButton
      toastOptions={{
        closeButtonAriaLabel: "知らせを閉じる",
        ...toastOptions,
        classNames: {
          toast:
            "border-border! bg-popover! text-popover-foreground! shadow-md! focus-visible:ring-2! focus-visible:ring-ring!",
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
