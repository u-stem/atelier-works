import { ExternalLink } from "lucide-react";
import { jobRunUrl, normalizeWindmillBaseUrl } from "../lib/jobLink.ts";

/**
 * ビルド時に決めるWindmillの外向きのベースURL。設定が無いか不正なら`null`で、同じオリジンの相対パスにする。
 * ConsoleはWindmillと同じオリジンで配信するので、設定は別のオリジンで公開するときだけ要る。
 */
const WINDMILL_BASE_URL = normalizeWindmillBaseUrl(
  import.meta.env.VITE_WINDMILL_PUBLIC_URL,
);

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
  const href = jobRunUrl(jobId, WINDMILL_BASE_URL);
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
