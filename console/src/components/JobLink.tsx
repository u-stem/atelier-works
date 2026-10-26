import { ExternalLink } from "lucide-react";
import { jobRunUrl } from "../lib/jobLink.ts";

/** WindmillのジョブのUIへの副次のリンク。 */
export function WindmillJobLink(_props: {
  jobId: string | null;
  label: string;
}) {
  return null;
}

/**
 * Windmillのジョブの画面へのリンク。`jobId`がUUIDの形でなければ何も出さない。
 * ジョブの画面はWindmillのログインが要るので、別のタブで開く。
 */
export function JobLink({
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
      className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
}
