import { Fragment, type ReactNode, useMemo, useState } from "react";
import type { ApprovalDesignDoc } from "../../api/guards/approvalDesignDoc.ts";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { useApprovalDesignDoc, useIntakeSnapshot } from "../../api/queries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import {
  LoadingBody,
  type LoadingDisplay,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { ViewModeSwitch } from "../../components/ViewModeSwitch.tsx";
import {
  designBlockedReason,
  snapshotReadiness,
} from "../../lib/approvalDecision.ts";
import { NO_LINGER_OPTIONS } from "../../lib/delayedVisible.ts";
import { displayableIssueText } from "../../lib/intakeText.ts";
import type { RepoRef } from "../../lib/markdownLink.ts";
import type { ViewMode } from "../../lib/requirementsView.ts";
import {
  blankRunMark,
  countDesignAnomalies,
  endMark,
  spaceRunMark,
  textStats,
  type VisibleSegment,
  visibleText,
} from "../../lib/visibleText.ts";
import { QueryFailure } from "../items/QueryFailure.tsx";
import { ApprovalBar } from "./ApprovalBar.tsx";
import { DesignTextPreview } from "./DesignTextPreview.tsx";
import { IntakeSnapshotPanel } from "./IntakeSnapshotPanel.tsx";
import { LOADING_SHAPE, PanelNote, PanelShell } from "./ReviewPanel.tsx";

const MARK_CLASS =
  "rounded-sm bg-warning/15 px-1 font-medium text-warning [unicode-bidi:isolate]";

/** 印の要素に持たせる、元の文字列。画面の外から全文を組み直す検査が読む。 */
function sourceAttr(source: string): string {
  return encodeURIComponent(source);
}

/** 改行の無い最後の行以外は、末尾の改行を印の外に出す。 */
function withoutTrailingBreak(source: string): string {
  return source.replace(/\n$/, "");
}

/** 空行の印に添える、空白とタブの数。どちらも無ければ`null`。 */
function blankRunDetail(
  lines: readonly { readonly spaces: number; readonly tabs: number }[],
): string | null {
  const spaces = lines.reduce((sum, line) => sum + line.spaces, 0);
  const tabs = lines.reduce((sum, line) => sum + line.tabs, 0);
  if (spaces === 0 && tabs === 0) {
    return null;
  }
  return `(空白 ${String(spaces)}、タブ ${String(tabs)})`;
}

function SegmentView({ segment }: { segment: VisibleSegment }): ReactNode {
  switch (segment.kind) {
    case "plain":
      return segment.source;
    case "line-break":
      return null;
    case "code":
      return (
        <span data-source={sourceAttr(segment.source)} className={MARK_CLASS}>
          {segment.label}
        </span>
      );
    case "blank-run": {
      const detail = blankRunDetail(segment.lines);
      return (
        <span
          data-source={sourceAttr(withoutTrailingBreak(segment.source))}
          className={MARK_CLASS}
        >
          {blankRunMark(segment.lines.length)}
          {detail}
        </span>
      );
    }
    case "space-run":
      return (
        <span data-source={sourceAttr(segment.source)} className={MARK_CLASS}>
          {spaceRunMark(Array.from(segment.source).length)}
        </span>
      );
  }
}

type Line = {
  readonly segments: readonly VisibleSegment[];
  /** 行の後ろに改行を出すか。 */
  readonly newline: boolean;
};

/** 区切りを行ごとにまとめる。空行の連続の印は、それだけで1つの行になる。 */
function groupLines(segments: readonly VisibleSegment[]): readonly Line[] {
  const lines: Line[] = [];
  let current: VisibleSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "line-break") {
      lines.push({ segments: current, newline: true });
      current = [];
    } else if (segment.kind === "blank-run") {
      lines.push({
        segments: [...current, segment],
        newline: segment.source.endsWith("\n"),
      });
      current = [];
    } else {
      current.push(segment);
    }
  }
  if (current.length > 0) {
    lines.push({ segments: current, newline: false });
  }
  return lines;
}

/**
 * 設計書の全文を、実装に渡る文字のまま描く。
 * 見えない文字は、コードポイントの表記にして見える形で出す。
 * 並びは、行ごとに左から右へ固定する。右から左に書く文字が、周りの並びを入れ替えないためである。
 * HTMLとリンクの参照定義は、解釈せず文字のまま出す。
 */
export function DesignTextView({ text }: { text: string }) {
  const lines = useMemo(() => groupLines(visibleText(text)), [text]);
  return (
    <div className="max-h-[40rem] overflow-auto rounded-md border border-border bg-background">
      <pre className="px-3 py-2 font-mono text-small text-foreground whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:4]">
        {lines.map((line, index) => (
          // 行は並びが変わらないので、位置を鍵にしてよい。
          // biome-ignore lint/suspicious/noArrayIndexKey: 位置が行の同一性である
          <Fragment key={index}>
            <bdo dir="ltr">
              {line.segments.map((segment, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 位置が区切りの同一性である
                <SegmentView key={at} segment={segment} />
              ))}
            </bdo>
            {line.newline ? "\n" : null}
          </Fragment>
        ))}
      </pre>
    </div>
  );
}

/** 承認を止める異常の内訳。件数のあるものだけを並べる。 */
function AnomalySummary({ text }: { text: string }) {
  const anomalies = countDesignAnomalies(text);
  if (anomalies.total === 0) {
    return null;
  }
  const items: readonly (readonly [string, number, string])[] = [
    ["見えない文字", anomalies.invisible, "件"],
    ["右から左に書く文字", anomalies.strongRtl, "件"],
    ["3行以上続く空行", anomalies.blankRuns, "か所"],
    ["長く続く空白", anomalies.spaceRuns, "か所"],
    ["空行や空白の印をまねた文言", anomalies.markLookalikes, "件"],
  ];
  return (
    <div
      role="alert"
      className="rounded-md border border-warning px-4 py-3 text-small text-warning"
    >
      <p className="font-medium">承認を止めている並びの内訳です。</p>
      <ul className="mt-1 list-disc pl-5">
        {items
          .filter(([, count]) => count > 0)
          .map(([label, count, unit]) => (
            <li key={label}>{`${label}: ${String(count)} ${unit}`}</li>
          ))}
      </ul>
    </div>
  );
}

/** 原文を表示しているときの注記。 */
const TEXT_NOTICE =
  "承認の対象は、この全文です。承認すると、ここに出ている文字がそのまま実装に渡ります。図、要約、未確定事項は実装に渡りません。";

/** プレビューを表示しているときの注記。プレビューが描かないものを、ここで1度だけ挙げる。 */
const PREVIEW_NOTICE =
  "承認の対象は、原文の全文です。このプレビューは、生のHTML(コメントを含む)、リンク参照定義、画像を描きません。閉じない<!--より後ろの本文も、描かないことがあります。文字参照で書いた見えない文字や向きの制御文字は、置き換えずに描くことがあります。原文に切り替えて確かめてください。図、要約、未確定事項は実装に渡りません。";

/** プレビュー中に承認を止める理由。注記の文と重ならないようにする。 */
const PREVIEW_BLOCKED_REASON =
  "設計書をプレビューで表示中は承認できません。承認するには、原文を表示してください。";

/**
 * 設計書の表示の形式から、承認を止める理由を決める。
 * 承認できる表示は`"text"`(原文)だけで、プレビューも、知らない値も止める。
 * 原文で確かめられる表示でだけ承認を押せるようにするため、条件を画面のソースの中に置く。
 */
export function designPreviewGate(input: {
  mode: string;
  previewed: boolean;
}): {
  reason: string | null;
  check: string | null;
} {
  return {
    reason: input.mode === "text" ? null : PREVIEW_BLOCKED_REASON,
    check: null,
  };
}

/** 設計書の表示の状態。`previewed`は、プレビューを一度でも選んだかである。 */
export type DesignView = { mode: ViewMode; previewed: boolean };

/** 表示の形式を切り替えた後の状態を返す。 */
export function nextDesignView(_view: DesignView, _next: string): DesignView {
  return { mode: "text", previewed: false };
}

/**
 * 設計書の全文と、承認の判断に要る注記。
 * 行数とコードポイント数は全文の外にも出し、全文の終わりの印も全文の外に置く。
 * 本文が同じ文言を書いても、本物の印と紛れないためである。
 * 全文は、既定の原文では実装に渡る文字のまま描き、`mode`がプレビューのときだけ、参考の描画に替える。
 * 異常の内訳、行数、終わりの印は、どちらの形式でも出す。
 * `repo`は、プレビューがリンクを許すリポジトリ。
 */
export function DesignDocBody({
  doc,
  mode,
  onChange,
  repo,
}: {
  doc: ApprovalDesignDoc;
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  repo: RepoRef | null;
}) {
  const stats = textStats(doc.text);
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <ViewModeSwitch
        target="設計書"
        textLabel="原文"
        mode={mode}
        onChange={onChange}
      />
      <p className="text-small text-muted-foreground">
        {mode === "preview" ? PREVIEW_NOTICE : TEXT_NOTICE}
      </p>
      <AnomalySummary text={doc.text} />
      <p className="text-small tabular-nums text-muted-foreground">
        {`全文: ${String(stats.lines)} 行、${String(stats.codePoints)} コードポイント`}
      </p>
      {mode === "preview" ? (
        <DesignTextPreview text={doc.text} repo={repo} />
      ) : (
        <DesignTextView text={doc.text} />
      )}
      <p className="text-small tabular-nums text-muted-foreground">
        {endMark(stats.lines, stats.codePoints)}
      </p>
    </div>
  );
}

/** 承認する依頼が指す設計書を出す面。取得の状態ごとに、承認者へ伝える文を変える。 */
function DocPanel({
  approvalRequestId,
  query,
  display,
  mode,
  onChange,
  repo,
}: {
  approvalRequestId: number;
  query: {
    readonly data: ApprovalDesignDoc | null | undefined;
    readonly error: Error | null;
    readonly isError: boolean;
    readonly refetch: () => unknown;
  };
  display: LoadingDisplay;
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  repo: RepoRef | null;
}) {
  const doc = query.data;
  let body: ReactNode;
  if (display !== "content") {
    body = <LoadingBody display={display} shape={LOADING_SHAPE} />;
  } else if (query.isError) {
    body = (
      <div className="p-4">
        <QueryFailure
          title="設計書を取得できませんでした"
          loginHint="上のバナーからログインすると、設計書を表示します。"
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          compact
        />
      </div>
    );
  } else if (doc === undefined || doc === null) {
    body = <PanelNote>この依頼の設計書が見つかりません。</PanelNote>;
  } else if (doc.approval_request_id !== approvalRequestId) {
    body = (
      <PanelNote>
        表示している設計書が、承認する依頼のものと違います。
      </PanelNote>
    );
  } else {
    body = (
      <DesignDocBody doc={doc} mode={mode} onChange={onChange} repo={repo} />
    );
  }
  return (
    <PanelShell heading="承認対象の設計書" link={null}>
      {body}
    </PanelShell>
  );
}

/**
 * 設計の承認。取り込み時点のIssueと、承認する依頼の設計書の全文を並べ、その直下に承認バーを置く。
 * 承認を押せるかは、取得の状態などの`designBlockedReason`と、設計書の表示の形式の判定で決め、この画面は結果を承認バーに渡す。
 * 設計書は原文が既定で、プレビューは参考に切り替えて読める。プレビューを表示している間は承認を止める。
 * 取り込み時点のIssueは、切り替えの対象にせず、常に原文で出す。
 * 承認バーは承認依頼ごとに作り直し、チェックなどの状態を別の依頼に持ち越さない。
 * 却下は、設計書を読めなくても押せる。
 * `initialView`は設計書の最初の表示の状態で、省略すると原文になる。
 */
export function DesignReview({
  approval,
  title,
  now,
  initialView = { mode: "text", previewed: false },
}: {
  approval: SummaryApproval;
  title: string;
  now: number;
  initialView?: DesignView;
}) {
  const [mode, setMode] = useState<ViewMode>(initialView.mode);
  const onChange = (next: ViewMode) => {
    setMode(next);
  };
  const { owner, repo } = approval;
  const repoRef = useMemo(() => ({ owner, repo }), [owner, repo]);
  const doc = useApprovalDesignDoc(approval.approval_request_id);
  const docDisplay = useLoadingDisplay(loadPhaseOf(doc), NO_LINGER_OPTIONS);
  // パネルと同じ取得(キーが同じ)を読むので、取得は1回で済む。
  const snapshot = useIntakeSnapshot(
    approval.work_item_id,
    approval.approval_request_id,
  );
  // 承認の可否は取得の状態だけで決まる。内容と食い違わないよう、取得が済んだら骨組みを残さず内容を出す。
  const snapshotDisplay = useLoadingDisplay(
    loadPhaseOf(snapshot),
    NO_LINGER_OPTIONS,
  );
  const blocked = designBlockedReason({
    approvalRequestId: approval.approval_request_id,
    snapshot: snapshotReadiness(snapshot),
    doc: { isPending: doc.isPending, isError: doc.isError, data: doc.data },
    workItemStatus: approval.work_item_status,
  });
  const gate = designPreviewGate({ mode, previewed: false });
  return (
    <>
      <IntakeSnapshotPanel
        workItemId={approval.work_item_id}
        approvalRequestId={approval.approval_request_id}
        display={snapshotDisplay}
      />
      <DocPanel
        approvalRequestId={approval.approval_request_id}
        query={doc}
        display={docDisplay}
        mode={mode}
        onChange={onChange}
        repo={repoRef}
      />
      <ApprovalBar
        key={approval.approval_request_id}
        approval={approval}
        now={now}
        subject={displayableIssueText(title).text}
        factoryLabel={null}
        approveBlockedReason={blocked ?? gate.reason}
        refreshed={snapshot.data?.refreshed === true}
        fullCheckRequired={snapshot.data?.body_truncated === true}
      />
    </>
  );
}
