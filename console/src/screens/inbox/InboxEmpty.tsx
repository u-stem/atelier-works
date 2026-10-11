import { CircleCheck, Inbox } from "lucide-react";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { emptyStateTone, type UnlistedCount } from "../../lib/inboxView.ts";
import type { RefreshFailure } from "./refreshFailure.ts";
import { UnlistedCards } from "./UnlistedCards.tsx";

/**
 * 一覧が空のときの画面。画面を二つに割らず、中央に一枚の面を置く。
 * 何も残っていないときだけ成功の印を出し、ほかの種類が残っているときは中立の印にする。
 * あわせて、ほかの種類に残る件数を伝える。
 * 最終更新と自動更新の間隔は、画面の見出しが示す。
 * 取り直しに失敗しているときは、最後に取れた時点の結果だと断り、成功の印は出さない。
 * 「何もない」を、確かめられていない状態で言い切らないためである。
 */
export function InboxEmpty({
  unlisted,
  refreshFailure = null,
}: {
  unlisted: readonly UnlistedCount[];
  /** 一覧の取り直しが失敗しているときに渡す。 */
  refreshFailure?: RefreshFailure | null;
}) {
  const failed = refreshFailure !== null;
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
      <section
        aria-label="要対応の状況"
        className="w-full max-w-xl rounded-2xl border border-border bg-card p-8 shadow-raised"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          {!failed && emptyStateTone(unlisted) === "clear" ? (
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-success/14 text-success">
              <CircleCheck aria-hidden="true" className="size-6" />
            </span>
          ) : (
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
              <Inbox aria-hidden="true" className="size-6" />
            </span>
          )}
          <h2 className="text-title font-semibold tracking-tight">
            {failed
              ? "最後に取得できた時点では、対応が必要な承認・失敗・通知はありませんでした"
              : "対応が必要な承認・失敗・通知はありません"}
          </h2>
          {refreshFailure === null ? null : (
            <StaleDataNotice
              error={refreshFailure.error}
              isFetching={refreshFailure.isFetching}
              onRetry={refreshFailure.onRetry}
            />
          )}
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
