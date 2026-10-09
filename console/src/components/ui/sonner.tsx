import * as SonnerPrimitive from "sonner";

/**
 * トーストの置き場。色はテーマのトークンから取り、OSの設定とdata-themeに追従する。
 * sonner自身の配色より優先させるため、ユーティリティに`!`を付けている。
 * 成功と失敗の知らせは`toast`で出す。
 */
function Toaster({ toastOptions, ...props }: SonnerPrimitive.ToasterProps) {
  return (
    <SonnerPrimitive.Toaster
      className="toaster group"
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast:
            "border-border! bg-popover! text-popover-foreground! shadow-md!",
          description: "text-muted-foreground!",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
