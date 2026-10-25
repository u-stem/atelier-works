import { type FocusTarget, MAIN_ID } from "../lib/routeFocus.ts";

/**
 * スキップのリンクの押下を、本文へのフォーカスの移動に替える。
 * 既定の移動(`#`への移動)は、アドレスに`#`を足し、履歴を積むので止める。
 */
export function skipToMain(
  event: { preventDefault(): void },
  main: FocusTarget | null,
): void {
  event.preventDefault();
  main?.focus({ preventScroll: true });
}

/**
 * 本文へ飛ぶリンク。ページの先頭にあり、フォーカスが当たったときだけ見える。
 * キーボードの利用者が、メニューの入口を毎回たどらずに、本文へ移れるようにする。
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_ID}`}
      onClick={(event) => {
        skipToMain(event, document.getElementById(MAIN_ID));
      }}
      className="sr-only rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground outline-none focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      本文へスキップ
    </a>
  );
}
