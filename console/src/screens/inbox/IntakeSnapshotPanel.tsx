import { TriangleAlert } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { IntakeSnapshot } from "../../api/guards/intakeSnapshot.ts";
import { useIntakeSnapshot } from "../../api/queries.ts";
import {
  LoadingBody,
  type LoadingDisplay,
  type LoadingShape,
} from "../../components/LoadingState.tsx";
import { Markdown } from "../../components/markdown/Markdown.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { displayableIssueText } from "../../lib/intakeText.ts";
import type { RepoRef } from "../../lib/markdownLink.ts";
import type { ViewMode } from "../../lib/requirementsView.ts";

/** 描画する状態。取得の結果を、描画に要る形だけにしたもの。 */
export type IntakeSnapshotViewState =
  | {
      readonly status: "loading";
      readonly display: Exclude<LoadingDisplay, "content">;
    }
  | {
      readonly status: "error";
      readonly error: unknown;
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

/** プレビューの本文の目次。プレビューは見出しの`id`を持たないので、空にする。 */
const NO_HEADINGS: readonly never[] = [];

/** プレビューは図を描かない。`.drawio`の参照は、図の名前を文字で出す。 */
const NO_DIAGRAMS: readonly never[] = [];

/** プレビューの本文の下に、承認の対象が原文であることを伝える注記。 */
export const PREVIEW_NOTICE =
  "プレビューは、生のHTML(コメントを含む)、リンク参照定義、画像を描かず、見えない文字を置き換えずに描くことがあります。承認の対象は原文です。";

/** 本文が空のときに出す固定の文。`Markdown`には渡さない。 */
const EMPTY_BODY_NOTE = "(本文は空です)";

const BODY_BOX_CLASS =
  "max-h-96 overflow-auto rounded-lg px-4 py-3 text-small break-words text-foreground [unicode-bidi:isolate]";

/**
 * Issueの本文を、原文かプレビューで出す。承認の対象は原文で、プレビューは参考の表示である。
 * 原文(`text`)は、Markdownにもhtmlにも解釈せず、文字列のまま`<pre>`に描く。
 * Reactが文字列をエスケープするので、タグやリンクは文字として見える。
 * プレビューは、見えない文字を置き換えた本文を`Markdown`に渡す。
 * `Markdown`は生のHTMLを描かず、リンクは`repo`のIssueとPRに絞り、画像は文字で出す。
 * `repo`が`null`のときは、リンクを作らない。
 * 本文が空のときは、どちらのモードでも固定の文を`<pre>`に出す。
 * `repo`は、呼び出し側が同じ参照を渡し続ける(`Markdown`が参照で描き直しを判断するため)。
 */
export function IssueBody({
  source,
  mode,
  repo,
}: {
  source: string;
  mode: ViewMode;
  repo: RepoRef | null;
}) {
  const body = displayableIssueText(source);
  if (source === "" || mode === "text") {
    return (
      <pre
        dir="ltr"
        className={`${BODY_BOX_CLASS} bg-muted font-mono whitespace-pre-wrap`}
      >
        {source === "" ? EMPTY_BODY_NOTE : body.text}
      </pre>
    );
  }
  return (
    <>
      <p className="text-small text-muted-foreground">{PREVIEW_NOTICE}</p>
      <div
        data-preview
        dir="ltr"
        className={`${BODY_BOX_CLASS} border border-border`}
      >
        <Markdown
          markdown={body.text}
          headings={NO_HEADINGS}
          diagrams={NO_DIAGRAMS}
          rejectedDiagrams={NO_DIAGRAMS}
          repo={repo}
        />
      </div>
    </>
  );
}

/**
 * 取り込み時点のIssueの題名と本文を出す。
 * 起票者が書いた信頼できない入力なので、題名は文字列のまま描く。
 * 本文は、既定の原文では解釈せずに描き、`mode`がプレビューのときだけ`Markdown`で参考に描く。
 * `modeSwitch`は、画面が持つ切り替え。本文の上に置く。
 */
function SnapshotBody({
  snapshot,
  mode,
  modeSwitch,
}: {
  snapshot: IntakeSnapshot;
  mode: ViewMode;
  modeSwitch: ReactNode;
}) {
  const title = displayableIssueText(snapshot.title);
  const body = displayableIssueText(snapshot.body);
  const tail = tailWarning(snapshot);
  const { owner, repo } = snapshot;
  const repoRef = useMemo(() => ({ owner, repo }), [owner, repo]);
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
      {modeSwitch}
      <IssueBody source={snapshot.body} mode={mode} repo={repoRef} />
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

/** 読み込み中の形。 */
const LOADING_SHAPE: LoadingShape = {
  className: "space-y-2 px-5 py-4",
  node: (
    <>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </>
  ),
};

/**
 * 取り込み時点のIssueの枠。状態に応じて、読み込み中、取得の失敗、該当なし、内容を出す。
 * 実装のClaudeは、GitHub上の現在のIssueではなく、この内容を受け取る。
 * 承認の前に現在のIssueと違っていれば、承認は断られる。
 */
export function IntakeSnapshotView({
  state,
  mode = "text",
  modeSwitch = null,
}: {
  state: IntakeSnapshotViewState;
  /** 本文の表示の形式。省略すると原文になる。 */
  mode?: ViewMode;
  /** 本文の上に置く切り替え。表示の形式を持つ画面が渡す。 */
  modeSwitch?: ReactNode;
}) {
  return (
    <Card aria-labelledby="intake-snapshot-heading" tag="section">
      <header className="flex flex-col gap-1 border-b border-border px-5 py-3">
        <h3 id="intake-snapshot-heading" className="text-lead font-semibold">
          取り込み時点のIssue
        </h3>
        <p className="text-small text-muted-foreground">
          実装のClaudeは、GitHub上の現在のIssueではなく、この題名と本文を受け取ります。承認の時点で現在のIssueがこれと違うと、承認は断られます。
        </p>
      </header>
      {state.status === "loading" ? (
        <LoadingBody display={state.display} shape={LOADING_SHAPE} />
      ) : state.status === "error" ? (
        <div className="px-5 py-4">
          <QueryFailureAlert
            title="取り込み時点のIssueを取得できませんでした"
            error={state.error}
            onRetry={state.onRetry}
          />
        </div>
      ) : state.status === "empty" ? (
        <p className="px-5 py-4 text-small text-muted-foreground">
          この作業項目に、取り込み時点のIssueはありません。
        </p>
      ) : (
        <SnapshotBody
          snapshot={state.snapshot}
          mode={mode}
          modeSwitch={modeSwitch}
        />
      )}
    </Card>
  );
}

/** 要件定義の承認画面に出す、取り込み時点のIssue。承認依頼ごとに取り直す。 */
export function IntakeSnapshotPanel({
  workItemId,
  approvalRequestId,
  display,
  mode = "text",
  modeSwitch = null,
}: {
  workItemId: number;
  approvalRequestId: number;
  /** 読み込み中の表示。承認バーの判定と同じ状態を使うため、呼び出し側が決める。 */
  display: LoadingDisplay;
  /** 本文の表示の形式。省略すると原文になる。 */
  mode?: ViewMode;
  /** 本文の上に置く切り替え。表示の形式を持つ画面が渡す。 */
  modeSwitch?: ReactNode;
}) {
  const snapshot = useIntakeSnapshot(workItemId, approvalRequestId);
  // 値が揃った後も、スケルトンを残す時間の間は、読み込み中の表示を続ける。
  if (display !== "content") {
    return <IntakeSnapshotView state={{ status: "loading", display }} />;
  }
  if (snapshot.isPending) {
    return null;
  }
  if (snapshot.isError) {
    return (
      <IntakeSnapshotView
        state={{
          status: "error",
          error: snapshot.error,
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
    <IntakeSnapshotView
      state={{ status: "loaded", snapshot: snapshot.data }}
      mode={mode}
      modeSwitch={modeSwitch}
    />
  );
}
