import { ApiFailure, describeApiError } from "../../api/errors.ts";
import type { IntakeSnapshot } from "../../api/guards/intakeSnapshot.ts";
import { useIntakeSnapshot } from "../../api/queries.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { displayableIssueText } from "../../lib/intakeText.ts";

/**
 * 取り込み時点のIssueの題名と本文を出す。
 * 起票者が書いた信頼できない入力なので、Markdownにもhtmlにも解釈せず、文字列のまま描く。
 * Reactが文字列をエスケープするので、タグやリンクは文字として見える。
 */
function SnapshotBody({ snapshot }: { snapshot: IntakeSnapshot }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <p className="text-body font-medium break-words text-foreground">
        {displayableIssueText(snapshot.title)}
      </p>
      <pre
        dir="ltr"
        className="max-h-96 overflow-auto rounded-lg bg-muted px-4 py-3 font-mono text-small break-words whitespace-pre-wrap text-foreground"
      >
        {snapshot.body === ""
          ? "(本文は空です)"
          : displayableIssueText(snapshot.body)}
      </pre>
      {snapshot.body_truncated ? (
        <p className="text-small text-warning">
          本文が長いため、先頭だけを表示しています。全文はIssueで確かめてください。
        </p>
      ) : null}
    </div>
  );
}

/**
 * 要件定義の承認画面に出す、取り込み時点のIssue。
 * 実装のClaudeは、GitHub上の現在のIssueではなく、この内容を受け取る。
 * 承認の前に現在のIssueと違っていれば、承認は断られる。
 */
export function IntakeSnapshotPanel({ workItemId }: { workItemId: number }) {
  const snapshot = useIntakeSnapshot(workItemId);
  const error = snapshot.error;
  const apiError = error instanceof ApiFailure ? error.apiError : null;
  return (
    <section
      aria-labelledby="intake-snapshot-heading"
      className="rounded-xl border border-border bg-card"
    >
      <header className="flex flex-col gap-1 border-b border-border px-5 py-3">
        <h3 id="intake-snapshot-heading" className="text-lead font-semibold">
          取り込み時点のIssue
        </h3>
        <p className="text-small text-muted-foreground">
          実装のClaudeは、GitHub上の現在のIssueではなく、この題名と本文を受け取ります。承認の時点で現在のIssueがこれと違うと、承認は断られます。
        </p>
      </header>
      {snapshot.isPending ? (
        <div className="space-y-2 px-5 py-4" role="status">
          <span className="sr-only">読み込み中</span>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : snapshot.isError ? (
        <div className="px-5 py-4">
          <Alert variant="destructive">
            <AlertTitle>取り込み時点のIssueを取得できませんでした</AlertTitle>
            <AlertDescription>
              <p>
                {apiError === null
                  ? "原因は不明です。"
                  : describeApiError(apiError)}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void snapshot.refetch();
                }}
              >
                もう一度取得する
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : snapshot.data === null ? (
        <p className="px-5 py-4 text-small text-muted-foreground">
          この作業項目に、取り込み時点のIssueはありません。
        </p>
      ) : (
        <SnapshotBody snapshot={snapshot.data} />
      )}
    </section>
  );
}
