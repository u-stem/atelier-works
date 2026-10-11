import { CircleCheck, ExternalLink, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { WriteOutcome } from "../../api/executeWrite.ts";
import type { SummaryNotice } from "../../api/guards/summary.ts";
import type { NoticeResolveResult } from "../../api/guards/writeResults.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import { noticesQueryKey } from "../../api/noticeQueries.ts";
import { summaryQueryKey } from "../../api/queries.ts";
import { writeTargetKey } from "../../api/writeLocks.ts";
import { resolveNotice } from "../../api/writes.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { describeNotice } from "../../lib/noticeView.ts";
import { formatAbsoluteWithRelative } from "../../lib/relativeTime.ts";
import {
  describeNoticeResult,
  STALE_LIST_NOTICE,
} from "../../lib/writeNotices.ts";
import { NoticeMessageText } from "./NoticeMessageText.tsx";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-x-4 px-5 py-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd className="min-w-0 text-body text-foreground">{children}</dd>
    </div>
  );
}

function announce(notice: {
  readonly tone: "success" | "info" | "warning";
  readonly message: string;
}): void {
  switch (notice.tone) {
    case "success":
      toast.success(notice.message);
      return;
    case "info":
      toast.info(notice.message);
      return;
    case "warning":
      toast.warning(notice.message);
      return;
  }
}

/**
 * 通知の解決。確認のダイアログは出さない。
 * 解決した通知は履歴に残り、状況が続けば新しい通知が出るので、取り返しのつかない操作ではない。
 * summaryに加えて、未解決の通知の取得も読み直す。選んだ通知が一覧に無いときの詳細が、古い値を出さないためである。
 */
const RESOLVE_CONFIG = {
  keyOf: (noticeId: number) => writeTargetKey("notice", noticeId),
  run: (noticeId: number): Promise<NoticeResolveResult> =>
    resolveNotice(noticeId),
  onOutcome: (outcome: WriteOutcome<NoticeResolveResult>): void => {
    if (outcome.kind === "done") {
      announce(describeNoticeResult(outcome.result));
    } else {
      toast.error(outcome.message);
    }
  },
  onStale: (): void => {
    announce(STALE_LIST_NOTICE);
  },
  invalidates: [summaryQueryKey, noticesQueryKey],
} as const;

/**
 * 選んだ通知の詳細。重要度、本文、対象へのリンク、起きたことと次の操作を出す。
 * 本文は信頼できない文字を含みうるので、プレーンテキストで描く。
 * 解決のボタンは、未解決でConsoleから解決できる種類のときだけ出す。
 * 解決できない種類には、ボタンの代わりに理由を出す。
 */
export function NoticeDetail({
  notice,
  now,
  source = "summary",
}: {
  notice: SummaryNotice;
  now: number;
  /** 通知の出どころ。summaryの本文は上限で切れているので、切れた旨を添える。 */
  source?: "summary" | "full";
}) {
  const description = describeNotice(notice, source);
  const { submit, isLocked } = useWriteMutation(RESOLVE_CONFIG);
  const locked = isLocked(notice.notice_id);
  const { guide } = description;
  return (
    <article className="flex max-w-[47.5rem] flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={description.severity === "info" ? "outline" : "warning"}
          >
            {description.badgeLabel}
          </Badge>
          {description.resolved ? (
            <Badge variant="success">解決済み</Badge>
          ) : null}
        </div>
        <h2 className="text-display font-semibold tracking-tight text-balance">
          {description.title}
        </h2>
      </header>
      <dl className="divide-y divide-border rounded-xl border border-border bg-card">
        <Row label="本文">
          {description.messageReplaced ? (
            <p className="mb-2 text-small text-warning">
              不可視の文字を含みます。見えない文字や、並びの見た目を入れ替える文字は、代替文字(U+FFFD)に置き換えて表示しています。
            </p>
          ) : null}
          <p
            dir="ltr"
            className="text-body break-words whitespace-pre-wrap text-foreground [unicode-bidi:isolate]"
          >
            <NoticeMessageText parts={description.messageParts} />
          </p>
          {description.messageTruncated ? (
            <p className="mt-2 text-small text-muted-foreground">
              本文が長いため、途中までを表示しています。
            </p>
          ) : null}
        </Row>
        {description.targets.length === 0 ? null : (
          <Row label="対象">
            <ul className="flex flex-col gap-1">
              {description.targets.map((target) => (
                <li key={target.label}>
                  {target.url === null ? (
                    target.label
                  ) : (
                    <a
                      href={target.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {target.label}
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </Row>
        )}
        <Row label="発生した時刻">
          <time dateTime={notice.created_at} className="tabular-nums">
            {formatAbsoluteWithRelative(notice.created_at, now)}
          </time>
        </Row>
      </dl>
      <section
        aria-label="起きたことと次の操作"
        className="flex flex-col gap-4 rounded-xl border border-border bg-card px-5 py-4"
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-small font-medium text-subtle">起きたこと</h3>
          <p className="text-body text-foreground">{guide.meaning}</p>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-small font-medium text-subtle">次の操作</h3>
          <p className="text-body text-foreground">{guide.action}</p>
          {guide.commands.length === 0 ? null : (
            <ol className="mt-1 flex list-decimal flex-col gap-1.5 pl-6">
              {guide.commands.map((command) => (
                <li key={command}>
                  <code className="rounded-md bg-muted px-2 py-0.5 font-mono text-small text-foreground">
                    {command}
                  </code>
                </li>
              ))}
            </ol>
          )}
          {guide.note === null ? null : (
            <p className="mt-1 text-small text-muted-foreground">
              {guide.note}
            </p>
          )}
        </div>
      </section>
      {description.resolved ? (
        <p className="flex items-center gap-2 text-small text-muted-foreground">
          <CircleCheck
            aria-hidden="true"
            className="size-4 shrink-0 text-success"
          />
          この通知は解決済みです。
        </p>
      ) : description.canResolve ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            disabled={locked}
            onClick={() => {
              submit(notice.notice_id);
            }}
          >
            {locked ? "解決しています" : "解決済みにする"}
          </Button>
          <p className="flex items-start gap-2 text-small text-muted-foreground">
            <Info
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-subtle"
            />
            対応を終えたことを確かめてから押します。解決した人と時刻が記録され、同じ状況がまた起きれば、新しい通知になります。
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-5 py-4">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-subtle"
          />
          <div className="flex flex-col gap-1">
            <p className="text-body font-medium text-foreground">
              Consoleからは解決できません
            </p>
            <p className="text-small text-muted-foreground">
              {description.unresolvableReason}
            </p>
          </div>
        </div>
      )}
    </article>
  );
}
