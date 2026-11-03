import { Info } from "lucide-react";
import { useMemo, useRef } from "react";
import { Link } from "react-router";
import type { DesignDoc } from "../../api/guards/design.ts";
import { Markdown } from "../../components/markdown/Markdown.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Card } from "../../components/ui/card.tsx";
import { REQUIREMENTS_FRAME_CLASS } from "../../lib/layoutClasses.ts";
import { formatAbsoluteIso } from "../../lib/relativeTime.ts";
import type { PreparedDoc } from "../../lib/requirementsView.ts";
import { LINK_CLASS } from "./detail/DetailParts.tsx";
import { RequirementsToc } from "./RequirementsToc.tsx";
import { useActiveHeading } from "./useActiveHeading.ts";

/**
 * 本文の先頭に出す固定の注記。
 * この画面の描画は、承認と実装が受け取る文字と違うので、承認の判断を承認画面の全文へ戻す。
 */
const FIXED_NOTICE =
  "承認と実装が受け取る文字は、承認画面の全文です。この画面は読みやすく描いたもので、HTMLのコメント、リンク参照定義、見えない文字の扱いが違います。";

/**
 * 設計書1件の本文。固定の注記、作成の時刻、要約、本文、未確定事項を左に、目次を右に置く。
 * 承認の操作は置かない。承認待ちの設計書には、承認画面へのリンクだけを注記に添える。
 * 承認の状態の表示と、設計書の切り替えは置かず、詳細の設計タブへ戻って行う。
 * 本文と要約と未確定事項は、信頼できない入力を読んだ出力なので、`prepared`(見えない文字を置き換え済み)だけを描く。
 */
export function DesignDocumentView({
  doc,
  prepared,
}: {
  doc: DesignDoc;
  prepared: PreparedDoc;
}) {
  const repo = useMemo(
    () => ({ owner: doc.owner, repo: doc.repo }),
    [doc.owner, doc.repo],
  );
  // 目次は2か所(畳んだ目次と右の目次)に出すので、強調する節は1か所で決める。
  const anchor = useRef<HTMLDivElement>(null);
  const tocIds = useMemo(
    () => prepared.headings.map((heading) => heading.id),
    [prepared.headings],
  );
  const activeId = useActiveHeading(tocIds, anchor);
  const approvalLink =
    doc.approval_status === "pending" && doc.approval_request_id !== null
      ? `/?approval=${doc.approval_request_id}`
      : null;
  return (
    <div ref={anchor} className={REQUIREMENTS_FRAME_CLASS}>
      <article className="flex min-w-0 max-w-[47.5rem] flex-1 flex-col gap-6">
        <Alert variant="warning">
          <Info aria-hidden="true" />
          <AlertDescription>
            <p>{FIXED_NOTICE}</p>
            {approvalLink === null ? null : (
              <p>
                <Link to={approvalLink} className={LINK_CLASS}>
                  承認画面で全文を確かめる
                </Link>
              </p>
            )}
          </AlertDescription>
        </Alert>
        <p className="text-small text-subtle">
          作成{" "}
          <time dateTime={doc.created_at}>
            {formatAbsoluteIso(doc.created_at)}
          </time>
        </p>
        {prepared.replaced ? (
          <p className="text-small text-warning">
            不可視の文字を含みます。見えない文字や、並びの見た目を入れ替える文字は、代替文字(U+FFFD)に置き換えて表示しています。
          </p>
        ) : null}
        {/* 目次は、狭い幅では本文の前に畳んで置く。 */}
        {prepared.headings.length === 0 ? null : (
          <Card tag="details" padding="compact" className="min-[1100px]:hidden">
            <summary className="cursor-pointer text-small font-semibold text-muted-foreground">
              目次
            </summary>
            <div className="mt-3">
              <RequirementsToc
                headings={prepared.headings}
                activeId={activeId}
              />
            </div>
          </Card>
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
          <section aria-labelledby="design-open-questions-heading">
            <h2
              id="design-open-questions-heading"
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
      {prepared.headings.length === 0 ? null : (
        <aside className="sticky top-6 hidden w-56 shrink-0 min-[1100px]:block">
          <RequirementsToc headings={prepared.headings} activeId={activeId} />
        </aside>
      )}
    </div>
  );
}
