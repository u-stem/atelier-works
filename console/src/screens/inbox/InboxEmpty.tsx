import { CircleCheck, Inbox } from "lucide-react";
import { SUMMARY_REFRESH_MS } from "../../api/queries.ts";
import { emptyStateTone, type UnlistedCount } from "../../lib/inboxView.ts";
import { formatClockTime, formatNextRefresh } from "../../lib/refreshTiming.ts";
import { UnlistedCards } from "./UnlistedCards.tsx";

/**
 * 一覧が空のときの画面。画面を二つに割らず、中央に一枚の面を置く。
 * 何も残っていないときだけ成功の印を出し、ほかの種類が残っているときは中立の印にする。
 * あわせて、最後に確かめた時刻、次の自動更新、ほかの種類に残る件数を伝える。
 */
export function InboxEmpty({
  updatedAt,
  now,
  unlisted,
}: {
  updatedAt: number;
  now: number;
  unlisted: readonly UnlistedCount[];
}) {
  const next = formatNextRefresh(updatedAt, now, SUMMARY_REFRESH_MS);
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
      <section
        aria-label="要対応の状況"
        className="w-full max-w-xl rounded-2xl border border-border bg-card p-8 shadow-raised"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          {emptyStateTone(unlisted) === "clear" ? (
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-success/14 text-success">
              <CircleCheck aria-hidden="true" className="size-6" />
            </span>
          ) : (
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
              <Inbox aria-hidden="true" className="size-6" />
            </span>
          )}
          <h2 className="text-title font-semibold tracking-tight">
            対応が必要な承認はありません
          </h2>
          <p className="text-small text-muted-foreground tabular-nums">
            {updatedAt > 0
              ? `${formatClockTime(updatedAt)}に確認しました`
              : null}
            {updatedAt > 0 && next !== null ? "・" : null}
            {next === null ? null : `次の自動更新は${next}`}
          </p>
        </div>
        {unlisted.length === 0 ? null : (
          <div className="mt-6 border-t border-border pt-5">
            <p className="mb-3 text-small font-medium text-muted-foreground">
              ほかに対応が必要なもの
            </p>
            <UnlistedCards entries={unlisted} />
          </div>
        )}
      </section>
    </div>
  );
}
