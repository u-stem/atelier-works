import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { JobLink } from "../../../components/JobLink.tsx";
import type { JobLinkView, TargetLink } from "../../../lib/itemDetailView.ts";
import { formatAbsoluteWithRelative } from "../../../lib/relativeTime.ts";

export const LINK_CLASS =
  "inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 見出し付きの区画。 */
export function Panel({
  heading,
  note,
  children,
}: {
  heading: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lead font-semibold">{heading}</h2>
        {note === undefined ? null : (
          <p className="text-small text-muted-foreground">{note}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/** 項目名と値を並べる行。`<dl>`の中に置く。 */
export function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-x-4 px-5 py-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd className="min-w-0 text-body break-words text-foreground">
        {children}
      </dd>
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
      {children}
    </p>
  );
}

/** Issueの起票者や実行ログに由来する文字を、改行を保ったままプレーンテキストで描く。 */
export function PlainBlock({ children }: { children: string }) {
  return (
    <p
      dir="ltr"
      className="text-body break-words whitespace-pre-wrap [unicode-bidi:isolate]"
    >
      {children}
    </p>
  );
}

/** GitHubのIssueかPRへのリンク。リンクにできるURLが無ければ、番号だけを文字で出す。 */
export function TargetLinkView({ target }: { target: TargetLink | null }) {
  if (target === null) {
    return <span className="text-subtle">-</span>;
  }
  if (target.url === null) {
    return <span className="tabular-nums">{target.label}</span>;
  }
  return (
    <a
      href={target.url}
      target="_blank"
      rel="noopener noreferrer"
      className={LINK_CLASS}
    >
      {target.label}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
}

/** 「10/09 18:48(2時間前)」の形の時刻。 */
export function TimeLabel({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} className="tabular-nums">
      {formatAbsoluteWithRelative(iso, now)}
    </time>
  );
}

/** ジョブの画面へのリンクを横に並べる。ジョブが無ければ何も出さない。 */
export function JobLinks({ jobs }: { jobs: readonly JobLinkView[] }) {
  if (jobs.length === 0) {
    return null;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1 text-small">
      {jobs.map((job) => (
        <JobLink key={job.label} jobId={job.jobId} label={job.label} />
      ))}
    </span>
  );
}
