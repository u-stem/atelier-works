import type { ReleaseNotice } from "./lib/release.ts";

const BUTTON_CLASS =
  "shrink-0 rounded-md border border-current px-3 py-1.5 text-sm hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function reload(): void {
  window.location.reload();
}

/** 配信中の版から外れたときに、再読み込みを促す。suggestは控えめに、urgeは目立つ色で出す。 */
export function ReloadBanner({ notice }: { notice: ReleaseNotice }) {
  if (notice === "none") {
    return null;
  }
  if (notice === "urge") {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-4 bg-destructive px-6 py-3 text-sm font-medium text-destructive-foreground"
      >
        <p>
          配信中の版が戻されたか、この画面のファイルが配信から外れました。正しく動かないことがあるので、再読み込みしてください。
        </p>
        <button type="button" className={BUTTON_CLASS} onClick={reload}>
          再読み込み
        </button>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-4 border-b border-border bg-muted px-6 py-3 text-sm text-muted-foreground"
    >
      <p>新しい版が配信されています。再読み込みしてください。</p>
      <button type="button" className={BUTTON_CLASS} onClick={reload}>
        再読み込み
      </button>
    </div>
  );
}
