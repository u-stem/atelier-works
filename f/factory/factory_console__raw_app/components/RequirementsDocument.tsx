// The "Confluence-style document page" view of one requirements document —
// shared by tabs/RequirementsTab.tsx's detail pane and tabs/InboxTab.tsx's
// requirements detail (which used to render summary/markdown/diagrams/
// open_questions inline from the Inbox row; both now fetch a
// `RequirementsDocRow` via the "requirements_doc" console_query view and
// render it through this one component).

import React from "react";
import { extractHeadings, extractTitle } from "../lib/extractHeadings";
import { type RequirementsDocRow, toRequirementsDocRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";
import "./confluence.css";
import { Markdown } from "./Markdown";
import { Skeleton } from "./Skeleton";

type StatusVariant = "success" | "warning" | "danger" | "neutral";

const STATUS_VARIANTS: Record<string, StatusVariant> = {
  approved: "success",
  awaiting_approval: "warning",
  requirements_generating: "warning",
  rejected: "danger",
  needs_human: "danger",
  failed: "danger",
  expired: "danger",
  cancelled: "danger",
};

function statusVariant(status: string): StatusVariant {
  return STATUS_VARIANTS[status] ?? "neutral";
}

/** Table of contents, sticky in the right rail — links scroll the heading
 * into view by id (the same id `Markdown`'s `h2`/`h3` override assigns via
 * `slugify`, see lib/extractHeadings.ts's module doc). */
function TableOfContents({
  markdown,
}: {
  markdown: string;
}): React.ReactElement | null {
  const headings = extractHeadings(markdown);
  if (headings.length === 0) {
    return null;
  }
  return (
    <nav className="confluence-toc" aria-label="目次">
      <p className="confluence-toc-title">目次</p>
      <ul>
        {headings.map((heading) => (
          <li
            key={heading.id}
            className={`confluence-toc-level-${String(heading.level)}`}
          >
            <a href={`#${heading.id}`}>{heading.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function RequirementsDocument({
  doc,
  headerActions,
}: {
  doc: RequirementsDocRow;
  /** Extra controls rendered next to the meta row — e.g. RequirementsTab's
   * attempt selector. Omitted (undefined) renders nothing there. */
  headerActions?: React.ReactNode;
}): React.ReactElement {
  const title = extractTitle(doc.markdown) ?? doc.title ?? "(無題)";

  return (
    <div className="confluence-doc">
      <div className="confluence-doc-header">
        <h1 className="confluence-doc-title">{title}</h1>
        <div className="confluence-doc-meta">
          <span>
            {doc.owner}/{doc.repo}
          </span>
          {doc.issue_url !== null && (
            <>
              {" "}
              ・{" "}
              <a href={doc.issue_url} target="_blank" rel="noreferrer">
                Issue #{doc.issue_number ?? "-"}
              </a>
            </>
          )}
          {" ・ "}attempt {doc.attempt}
          {" ・ "}
          <span
            className={`status-pill status-pill--${statusVariant(doc.work_item_status)}`}
          >
            {doc.work_item_status}
          </span>
          {doc.doc_dir_source === "db_fallback" && (
            <>
              {" ・ "}
              <span className="status-pill status-pill--neutral">
                DBの控えを表示中(元ファイル未取得)
              </span>
            </>
          )}
        </div>
        {headerActions !== undefined && (
          <div className="confluence-doc-actions">{headerActions}</div>
        )}
      </div>
      <div className="confluence-doc-body">
        <div className="confluence-doc-content">
          <p className="confluence-doc-summary">{doc.summary}</p>
          <Markdown markdown={doc.markdown} diagrams={doc.diagrams} />
          {doc.open_questions.length > 0 && (
            <section className="confluence-doc-open-questions">
              <h2>未確定事項</h2>
              <ul>
                {doc.open_questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <TableOfContents markdown={doc.markdown} />
      </div>
    </div>
  );
}

/** Fetches one work item's requirements document via the "requirements_doc"
 * console_query view and renders it — the shared load/error/render path
 * behind both tabs/RequirementsTab.tsx's detail pane and
 * tabs/InboxTab.tsx's requirements detail. `attempt: null` fetches the
 * latest attempt. */
export function RequirementsDocumentLoader({
  workItemId,
  attempt,
  headerActions,
}: {
  workItemId: number;
  attempt: number | null;
  headerActions?: React.ReactNode;
}): React.ReactElement {
  const { rows, loading, error } = useConsoleQuery(
    "requirements_doc",
    toRequirementsDocRow,
    attempt === null
      ? { work_item_id: workItemId }
      : { work_item_id: workItemId, attempt },
  );

  if (loading) {
    return <Skeleton />;
  }
  if (error !== null) {
    return <p className="error-banner">{error}</p>;
  }
  const doc = rows[0];
  if (doc === undefined) {
    return (
      <div className="empty-state">
        <p className="empty-state-title">
          work_item_id {workItemId} の要件定義が見つかりませんでした。
        </p>
      </div>
    );
  }
  return <RequirementsDocument doc={doc} headerActions={headerActions} />;
}
