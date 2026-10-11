import { TriangleAlert } from "lucide-react";
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

/** 描画する状態。取得の結果を、描画に要る形だけにしたもの。 */
export type IntakeSnapshotViewState =
  | { readonly status: "loading" }
  | {
      readonly status: "error";
      readonly message: string;
      readonly onRetry: () => void;
    }
  | { readonly status: "empty" }
  | { readonly status: "loaded"; readonly snapshot: IntakeSnapshot };

/**
 * 切った後ろの部分にある、承認者が確かめられない内容の警告の文を返す。
 * 該当が無ければ`null`を返す。
 */
export function tailWarning(snapshot: IntakeSnapshot): string | null {
  const parts: string[] = [];
  if (snapshot.body_tail_html_comments > 0) {
    parts.push(
      `HTMLのコメント(<!--)が${String(snapshot.body_tail_html_comments)}個`,
    );
  }
  if (snapshot.body_tail_hidden_chars > 0) {
    parts.push(
      `画面に出せない文字が${String(snapshot.body_tail_hidden_chars)}個`,
    );
  }
  if (parts.length === 0) return null;
  return `表示していない後ろの部分に、${parts.join("と")}あります。`;
}

/**
 * 取り込み時点のIssueの題名と本文を出す。
 * 起票者が書いた信頼できない入力なので、Markdownにもhtmlにも解釈せず、文字列のまま描く。
 * Reactが文字列をエスケープするので、タグやリンクは文字として見える。
 */
function SnapshotBody({ snapshot }: { snapshot: IntakeSnapshot }) {
  const title = displayableIssueText(snapshot.title);
  const body = displayableIssueText(snapshot.body);
  const tail = tailWarning(snapshot);
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      {snapshot.refreshed ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>取り込み後に書き換えられたIssueの内容です</AlertTitle>
          <AlertDescription>
            <p>
              却下や再実行による作り直しのときに、Issueの題名と本文を現在の内容で更新しました。この内容を確かめてから承認してください。
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {title.replaced || body.replaced ? (
        <p className="text-small text-warning">
          不可視の文字を含みます。見えない文字や、並びの見た目を入れ替える文字は、代替文字(U+FFFD)に置き換えて表示しています。実装のClaudeには、置き換える前の内容が渡ります。
        </p>
      ) : null}
      <p
        dir="ltr"
        className="text-body font-medium break-words text-foreground [unicode-bidi:isolate]"
      >
        {title.text}
      </p>
      <pre
        dir="ltr"
        className="max-h-96 overflow-auto rounded-lg bg-muted px-4 py-3 font-mono text-small break-words whitespace-pre-wrap text-foreground [unicode-bidi:isolate]"
      >
        {snapshot.body === "" ? "(本文は空です)" : body.text}
      </pre>
      {snapshot.body_truncated ? (
        <p className="text-small text-warning">
          本文が長いため、先頭だけを表示しています。GitHubの画面では見えない内容(HTMLのコメントや不可視の文字)がありうるので、表示していない部分は確かめきれません。
        </p>
      ) : null}
      {tail === null ? null : (
        <p className="text-small font-medium text-warning">{tail}</p>
      )}
    </div>
  );
}

/**
 * 取り込み時点のIssueの枠。状態に応じて、読み込み中、取得の失敗、該当なし、内容を出す。
 * 実装のClaudeは、GitHub上の現在のIssueではなく、この内容を受け取る。
 * 承認の前に現在のIssueと違っていれば、承認は断られる。
 */
export function IntakeSnapshotView({
  state,
}: {
  state: IntakeSnapshotViewState;
}) {
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
      {state.status === "loading" ? (
        <div className="space-y-2 px-5 py-4" role="status">
          <span className="sr-only">読み込み中</span>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : state.status === "error" ? (
        <div className="px-5 py-4">
          <Alert variant="destructive">
            <AlertTitle>取り込み時点のIssueを取得できませんでした</AlertTitle>
            <AlertDescription>
              <p>{state.message}</p>
              <Button size="sm" variant="outline" onClick={state.onRetry}>
                もう一度取得する
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : state.status === "empty" ? (
        <p className="px-5 py-4 text-small text-muted-foreground">
          この作業項目に、取り込み時点のIssueはありません。
        </p>
      ) : (
        <SnapshotBody snapshot={state.snapshot} />
      )}
    </section>
  );
}

/** 要件定義の承認画面に出す、取り込み時点のIssue。承認依頼ごとに取り直す。 */
export function IntakeSnapshotPanel({
  workItemId,
  approvalRequestId,
}: {
  workItemId: number;
  approvalRequestId: number;
}) {
  const snapshot = useIntakeSnapshot(workItemId, approvalRequestId);
  const error = snapshot.error;
  const apiError = error instanceof ApiFailure ? error.apiError : null;
  if (snapshot.isPending) {
    return <IntakeSnapshotView state={{ status: "loading" }} />;
  }
  if (snapshot.isError) {
    return (
      <IntakeSnapshotView
        state={{
          status: "error",
          message:
            apiError === null ? "原因は不明です。" : describeApiError(apiError),
          onRetry: () => {
            void snapshot.refetch();
          },
        }}
      />
    );
  }
  if (snapshot.data === null) {
    return <IntakeSnapshotView state={{ status: "empty" }} />;
  }
  return (
    <IntakeSnapshotView state={{ status: "loaded", snapshot: snapshot.data }} />
  );
}
