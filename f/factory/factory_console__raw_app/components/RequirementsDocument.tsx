// 要件定義書1件を、Confluence風の文書ページとして表示する。
// `tabs/RequirementsTab.tsx`の詳細欄と`tabs/InboxTab.tsx`の要件の詳細で共有し、
// どちらも`console_query`の`requirements_doc`ビューで`RequirementsDocRow`を
// 取得して、このコンポーネントで描く。

import React from "react";
import { extractHeadings, extractTitle } from "../lib/extractHeadings";
import { safeGitHubUrl } from "../lib/githubLink";
import { type RequirementsDocRow, toRequirementsDocRow } from "../lib/types";
import { useConsoleQuery } from "../lib/useConsoleQuery";
import "./confluence.css";
import { Markdown } from "./Markdown";
import { Skeleton } from "./Skeleton";

type StatusVariant = "success" | "warning" | "danger" | "neutral";

const STATUS_VARIANTS: Record<string, StatusVariant> = {
  approved: "success",
  pr_open: "success",
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

/**
 * 右の欄に固定表示する目次。リンクはidで見出しまでスクロールする。
 * idは、`Markdown`の`h2`・`h3`の差し替えが`slugify`で付けるものと同じ
 * (`lib/extractHeadings.ts`のモジュールコメントを参照)。
 */
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
  /**
   * メタ情報の行の横に描く追加の操作(例: `RequirementsTab`のattemptの選択)。
   * 省略すると何も描かない。
   */
  headerActions?: React.ReactNode;
}): React.ReactElement {
  const title = extractTitle(doc.markdown) ?? doc.title ?? "(無題)";
  const issueUrl = safeGitHubUrl(doc.issue_url);

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
              {issueUrl !== null ? (
                <a href={issueUrl} target="_blank" rel="noreferrer">
                  Issue #{doc.issue_number ?? "-"}
                </a>
              ) : (
                <span>Issue #{doc.issue_number ?? "-"}</span>
              )}
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

/**
 * 作業項目1件の要件定義書を`console_query`の`requirements_doc`ビューで
 * 取得して描く。読み込み・エラー・描画の処理を、`tabs/RequirementsTab.tsx`の
 * 詳細欄と`tabs/InboxTab.tsx`の要件の詳細で共有する。
 * `attempt: null`なら最新のattemptを取得する。
 */
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
