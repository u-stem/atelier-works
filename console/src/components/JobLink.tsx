import { ExternalLink } from "lucide-react";
import { Link } from "react-router";
import { jobDetailPath, jobRunUrl } from "../lib/jobLink.ts";

const LINK_CLASS =
  "inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Consoleのジョブの詳細へのリンク。`jobId`がUUIDの形でなければ何も出さない。
 * `state`には、詳細のパンくずが一覧へ戻る経路(`jobsBackState`)を渡せる。
 */
export function JobLink({
  jobId,
  label,
  state,
}: {
  jobId: string | null;
  label: string;
  state?: { readonly jobsBack: string } | undefined;
}) {
  const to = jobDetailPath(jobId);
  if (to === null) {
    return null;
  }
  return (
    <Link to={to} state={state} className={LINK_CLASS}>
      {label}
    </Link>
  );
}

/**
 * WindmillのジョブのUIへの副次のリンク。`jobId`がUUIDの形でなければ何も出さない。
 * ステップのログが取れないなど、Consoleの詳細で足りないときの逃げ道である。
 * WindmillのUIはログインが要るので、別のタブで開く。
 */
export function WindmillJobLink({
  jobId,
  label,
}: {
  jobId: string | null;
  label: string;
}) {
  const href = jobRunUrl(jobId);
  if (href === null) {
    return null;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={LINK_CLASS}
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
}
