import { ExternalLink, Info } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { RequirementsDoc } from "../../api/guards/requirements.ts";
import { Markdown } from "../../components/markdown/Markdown.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { workItemRef, workItemStatusLabel } from "../../lib/labels.ts";
import {
  docSourceNotice,
  type PreparedDoc,
  requirementsStatusTone,
  toneBadgeVariant,
} from "../../lib/requirementsView.ts";
import { safeGitHubUrl } from "../../lib/safeUrl.ts";
import { AttemptSwitcher } from "./AttemptSwitcher.tsx";
import { RequirementsToc } from "./RequirementsToc.tsx";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-small text-subtle">{label}</dt>
      <dd className="min-w-0 text-small text-foreground">{children}</dd>
    </div>
  );
}

function IssueLink({ doc }: { doc: RequirementsDoc }) {
  if (doc.issue_number === null) {
    return <>なし</>;
  }
  const label = `Issue #${doc.issue_number}`;
  const url = safeGitHubUrl(doc.issue_url);
  if (url === null) {
    return <>{label}</>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
}

/**
 * 要件定義書1件の本文。メタ情報、試行の切り替え、要約、本文、未確定事項を左に、目次を右に置く。
 * メタ情報は、本文を押し下げないよう、折り返す1〜2行にまとめる。
 * 本文と要約と未確定事項はIssueの内容に由来するので、`prepared`(見えない文字を置き換え済み)だけを描く。
 * `embedded`のときは、承認の画面の中に置くため、メタ情報、試行の切り替え、目次を省き、幅も親に合わせる。
 * 承認の画面は、承認する試行を固定して出すので、試行を切り替えさせない。
 */
export function RequirementsDocumentView({
  doc,
  prepared,
  latestAttempt,
  embedded = false,
}: {
  doc: RequirementsDoc;
  prepared: PreparedDoc;
  /** 最新の試行の番号。確かめられていないときは`null`。 */
  latestAttempt: number | null;
  embedded?: boolean;
}) {
  const repo = useMemo(
    () => ({ owner: doc.owner, repo: doc.repo }),
    [doc.owner, doc.repo],
  );
  const sourceNotice = docSourceNotice(doc.doc_dir_source);
  return (
    <div
      className={
        embedded
          ? "flex w-full items-start"
          : "mx-auto flex w-full max-w-[75rem] items-start gap-10 px-8 py-6"
      }
    >
      <article
        className={
          embedded
            ? "flex min-w-0 flex-1 flex-col gap-6"
            : "flex min-w-0 max-w-[47.5rem] flex-1 flex-col gap-6"
        }
      >
        {embedded ? null : (
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Row label="状態">
              <Badge
                variant={toneBadgeVariant(
                  requirementsStatusTone(doc.work_item_status),
                )}
              >
                {workItemStatusLabel(doc.work_item_status)}
              </Badge>
            </Row>
            <Row label="リポジトリ">
              {doc.owner}/{doc.repo}
            </Row>
            <Row label="Issue">
              <IssueLink doc={doc} />
            </Row>
            <Row label="作業項目">{workItemRef(doc.work_item_id)}</Row>
            <Row label="試行">
              <AttemptSwitcher
                workItemId={doc.work_item_id}
                current={doc.attempt}
                latest={latestAttempt}
              />
            </Row>
          </dl>
        )}
        {sourceNotice === null ? null : (
          <Alert variant="warning">
            <Info aria-hidden="true" />
            <AlertDescription>
              <p>{sourceNotice}</p>
            </AlertDescription>
          </Alert>
        )}
        {prepared.replaced ? (
          <p className="text-small text-warning">
            不可視の文字を含みます。見えない文字や、並びの見た目を入れ替える文字は、代替文字(U+FFFD)に置き換えて表示しています。
          </p>
        ) : null}
        {/* 目次は、狭い幅では本文の前に畳んで置く。 */}
        {embedded || prepared.headings.length === 0 ? null : (
          <details className="rounded-xl border border-border bg-card px-5 py-3 min-[1100px]:hidden">
            <summary className="cursor-pointer text-small font-semibold text-muted-foreground">
              目次
            </summary>
            <div className="mt-3">
              <RequirementsToc headings={prepared.headings} />
            </div>
          </details>
        )}
        <p
          dir="ltr"
          className="border-l-4 border-border pl-4 text-lead text-muted-foreground [unicode-bidi:isolate]"
        >
          {prepared.summary}
        </p>
        <Markdown
          markdown={prepared.markdown}
          headings={prepared.headings}
          hiddenTitleLine={prepared.titleLine}
          diagrams={doc.diagrams}
          rejectedDiagrams={doc.rejected_diagrams}
          repo={repo}
        />
        {prepared.openQuestions.length === 0 ? null : (
          <section aria-labelledby="open-questions-heading">
            <h2
              id="open-questions-heading"
              className="mb-3 border-t border-border pt-6 text-title font-semibold tracking-tight"
            >
              未確定事項
            </h2>
            <ul className="list-disc space-y-1 pl-6">
              {prepared.openQuestions.map((question, index) => (
                // 同じ文が重なりうるので、並びの位置も鍵に含める。
                // biome-ignore lint/suspicious/noArrayIndexKey: 並びは取得のたびに変わらず、重複する文があっても鍵を一意にするため。
                <li key={`${index}-${question}`} className="pl-1">
                  {question}
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
      {embedded || prepared.headings.length === 0 ? null : (
        <aside className="sticky top-6 hidden w-56 shrink-0 min-[1100px]:block">
          <RequirementsToc headings={prepared.headings} />
        </aside>
      )}
    </div>
  );
}
