import { displayableIssueText } from "../../lib/intakeText.ts";
import type { PipelineLink } from "../../lib/pipelineView.ts";

/** GitHubへの外部リンク。リンクが無いときは「-」を出す。 */
export function ExternalLink({ link }: { link: PipelineLink | null }) {
  if (link === null) {
    return <span className="text-subtle">-</span>;
  }
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-sm tabular-nums underline underline-offset-2"
    >
      {link.label}
    </a>
  );
}

/** 題名やブランチのように、Issueの起票者や外のコードが決める文字。見えない文字を落としてから文字として出す。 */
export function PlainText({ value }: { value: string | null }) {
  if (value === null || value.length === 0) {
    return <span className="text-subtle">-</span>;
  }
  return <>{displayableIssueText(value).text}</>;
}
